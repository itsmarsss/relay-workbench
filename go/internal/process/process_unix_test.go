//go:build darwin || linux

package process

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"relay.local/relay/internal/runtimebudget"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkerHelper(t *testing.T) {
	if os.Getenv("RELAY_TEST_WORKER") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Exit(Worker(os.Args[i+1:]))
		}
	}
	os.Exit(127)
}
func options(t *testing.T, script string, args ...string) Options {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is needed for process fixtures")
	}
	worker, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return Options{WorkerExecutable: worker, WorkerArgs: []string{"-test.run=^TestWorkerHelper$", "--"}, Command: node, Args: append([]string{"-e", script}, args...), Directory: t.TempDir(), Timeout: 5 * time.Second, TerminationGrace: 2 * time.Second, MaxOutputBytes: 65536, Environment: map[string]string{"RELAY_TEST_WORKER": "1"}}
}
func TestArgumentsAndStreamingAreLiteral(t *testing.T) {
	literal := "$(touch should-not-exist); `unsafe`"
	opts := options(t, `process.stdout.write(process.argv[1]+"\n");process.stderr.write("warning\n");`, literal)
	var mu sync.Mutex
	lines := map[string][]string{}
	opts.OnLine = func(_ context.Context, line, stream string) error {
		mu.Lock()
		defer mu.Unlock()
		lines[stream] = append(lines[stream], line)
		return nil
	}
	result, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || strings.TrimSpace(result.Stdout) != literal || strings.TrimSpace(result.Stderr) != "warning" {
		t.Fatalf("unexpected output: %#v", result)
	}
	if _, err = os.Stat(filepath.Join(opts.Directory, "should-not-exist")); !os.IsNotExist(err) {
		t.Fatal("argument was executed as shell code")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(lines["stdout"]) != 1 || lines["stdout"][0] != literal || len(lines["stderr"]) != 1 {
		t.Fatalf("line events: %#v", lines)
	}
}
func TestNonzeroExitIsReturnedWithoutSuccess(t *testing.T) {
	result, err := Run(context.Background(), options(t, `process.exit(7)`))
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 7 {
		t.Fatalf("exit code %d", result.ExitCode)
	}
}
func TestCancellationTimeoutAndOutputLimit(t *testing.T) {
	t.Run("cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		opts := options(t, `setInterval(()=>{},1000)`)
		go func() { time.Sleep(150 * time.Millisecond); cancel() }()
		_, err := Run(ctx, opts)
		if !errors.Is(err, ErrCancelled) {
			t.Fatalf("cancellation: %v", err)
		}
	})
	t.Run("timeout", func(t *testing.T) {
		opts := options(t, `setInterval(()=>{},1000)`)
		opts.Timeout = 150 * time.Millisecond
		_, err := Run(context.Background(), opts)
		if !errors.Is(err, ErrTimeout) {
			t.Fatalf("timeout: %v", err)
		}
	})
	t.Run("output limit", func(t *testing.T) {
		opts := options(t, `process.stdout.write('x'.repeat(200000))`)
		opts.MaxOutputBytes = 1024
		result, err := Run(context.Background(), opts)
		if !errors.Is(err, ErrOutputLimit) || len(result.Stdout) > 1024 {
			t.Fatalf("limit: %v (%d)", err, len(result.Stdout))
		}
	})
}
func TestCallbackFailureAndPanicStopExecution(t *testing.T) {
	for _, panics := range []bool{false, true} {
		opts := options(t, `console.log('ready');setInterval(()=>{},1000)`)
		opts.OnLine = func(context.Context, string, string) error {
			if panics {
				panic("callback")
			}
			return errors.New("callback failed")
		}
		_, err := Run(context.Background(), opts)
		if err == nil || !strings.Contains(err.Error(), "callback") {
			t.Fatalf("callback error: %v", err)
		}
	}
}
func TestMissingSupervisorProtocolNeverPasses(t *testing.T) {
	opts := options(t, `process.exit(0)`)
	opts.WorkerExecutable = "/bin/echo"
	opts.WorkerArgs = nil
	_, err := Run(context.Background(), opts)
	if !errors.Is(err, ErrCleanup) {
		t.Fatalf("missing protocol: %v", err)
	}
}
func TestCompletionStopsBackgroundDescendants(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "leaked")
	script := `const {spawn}=require('node:child_process');const script='setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"leaked"),1000)';spawn(process.execPath,['-e',script,process.argv[1]],{stdio:'ignore'}).unref();`
	opts := options(t, script, marker)
	result, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("exit: %d", result.ExitCode)
	}
	time.Sleep(1300 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("background descendant survived: %v", err)
	}
}
func TestCrashHelper(t *testing.T) {
	if os.Getenv("RELAY_CRASH_PARENT") != "1" {
		return
	}
	ready := os.Getenv("RELAY_CRASH_READY")
	marker := os.Getenv("RELAY_CRASH_MARKER")
	opts := options(t, `require('node:fs').writeFileSync(process.argv[1],'ready');setTimeout(()=>require('node:fs').writeFileSync(process.argv[2],'leaked'),1500);`, ready, marker)
	_, err := Run(context.Background(), opts)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	os.Exit(0)
}
func TestSupervisorStopsAfterParentCrash(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	ready := filepath.Join(dir, "ready")
	marker := filepath.Join(dir, "leaked")
	cmd := exec.Command(executable, "-test.run=^TestCrashHelper$")
	cmd.Env = append(os.Environ(), "RELAY_CRASH_PARENT=1", "RELAY_CRASH_READY="+ready, "RELAY_CRASH_MARKER="+marker)
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() }()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err = os.Stat(ready); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err = os.Stat(ready); err != nil {
		t.Fatal("child did not start")
	}
	if err = cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_, _ = cmd.Process.Wait()
	time.Sleep(1800 * time.Millisecond)
	if _, err = os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("worker survived parent crash: %v", err)
	}
}

func TestSignalExitIsReported(t *testing.T) {
	opts := options(t, `process.kill(process.pid,'SIGTERM')`)
	result, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != -1 || result.Signal != "SIGTERM" {
		t.Fatalf("signal result: %#v", result)
	}
}
func TestCleanWithoutResultCannotBeSuccess(t *testing.T) {
	opts := options(t, `process.exit(0)`)
	opts.WorkerExecutable = "/bin/sh"
	opts.WorkerArgs = []string{"-c", `printf '{"type":"clean"}\n' >&4`}
	_, err := Run(context.Background(), opts)
	if !errors.Is(err, ErrCleanup) {
		t.Fatalf("incomplete protocol accepted: %v", err)
	}
}

func TestBlockedOutputCallbackCannotHangTheRunner(t *testing.T) {
	stopped := make(chan struct{})
	opts := options(t, `console.log('ready')`)
	opts.OnLine = func(ctx context.Context, _, _ string) error { defer close(stopped); <-ctx.Done(); return nil }
	start := time.Now()
	_, err := Run(context.Background(), opts)
	if !errors.Is(err, ErrCallbackBlocked) {
		t.Fatalf("blocked callback: %v", err)
	}
	if time.Since(start) > 4*time.Second {
		t.Fatal("callback stalled runner")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("callback did not receive cancellation")
	}
}
func TestSlowOutputConsumerFailsExplicitly(t *testing.T) {
	opts := options(t, `process.stdout.write('x\n'.repeat(20000))`)
	opts.OnLine = func(ctx context.Context, _, _ string) error { <-ctx.Done(); return nil }
	_, err := Run(context.Background(), opts)
	if !errors.Is(err, ErrOutputBackpressure) {
		t.Fatalf("output backpressure: %v", err)
	}
}

func TestProgressExtendsBudgetButNeverBeyondHardLimit(t *testing.T) {
	var last atomic.Int64
	updates := make(chan runtimebudget.Snapshot, 16)
	opts := options(t, `setTimeout(()=>console.log('done'),900)`)
	opts.Timeout = 600 * time.Millisecond
	opts.Progress = &ProgressPolicy{MaxTimeout: 3500 * time.Millisecond, ProgressWindow: 400 * time.Millisecond, LastProgressUnixMillis: &last, Updates: updates}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(80 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case now := <-ticker.C:
				last.Store(now.UnixMilli())
			case <-stop:
				return
			}
		}
	}()
	result, err := Run(context.Background(), opts)
	close(stop)
	<-done
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || !strings.Contains(result.Stdout, "done") {
		t.Fatalf("result: %#v", result)
	}
	found := false
	for len(updates) > 0 {
		if (<-updates).Extensions > 0 {
			found = true
		}
	}
	if !found {
		t.Fatal("progress did not extend budget")
	}
}
func TestBudgetExhaustionIsDistinctFromTimeout(t *testing.T) {
	opts := options(t, `setInterval(()=>{},1000)`)
	opts.Timeout = 150 * time.Millisecond
	opts.Progress = &ProgressPolicy{MaxTimeout: 300 * time.Millisecond}
	_, err := Run(context.Background(), opts)
	if !errors.Is(err, ErrBudgetExhausted) || errors.Is(err, ErrTimeout) {
		t.Fatalf("wrong classification: %v", err)
	}
	var detail *BudgetError
	if !errors.As(err, &detail) || detail.Snapshot.Extensions != 0 {
		t.Fatalf("missing budget evidence: %v", err)
	}
}
func TestClosedBudgetUpdatesCannotCrashRunner(t *testing.T) {
	updates := make(chan runtimebudget.Snapshot)
	close(updates)
	opts := options(t, `process.exit(0)`)
	opts.Progress = &ProgressPolicy{Updates: updates}
	result, err := Run(context.Background(), opts)
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("result %#v: %v", result, err)
	}
}

func TestCleanSuccessRequiresARealStartedTarget(t *testing.T) {
	opts := options(t, `process.exit(0)`)
	opts.WorkerExecutable = "/bin/sh"
	opts.WorkerArgs = []string{"-c", `printf '{"type":"result","code":0}\n{"type":"clean"}\n' >&4`}
	_, err := Run(context.Background(), opts)
	if !errors.Is(err, ErrCleanup) {
		t.Fatalf("invalid protocol accepted: %v", err)
	}
}
func TestInvalidProgressPolicyIsRejected(t *testing.T) {
	opts := options(t, `process.exit(0)`)
	opts.Timeout = time.Microsecond
	opts.Progress = &ProgressPolicy{}
	if _, err := Run(context.Background(), opts); err == nil {
		t.Fatal("submillisecond budget accepted")
	}
}
