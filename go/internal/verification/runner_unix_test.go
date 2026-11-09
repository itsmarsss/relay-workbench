//go:build darwin || linux

package verification

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"relay.local/relay/internal/process"
)

func TestCheckWorker(t *testing.T) {
	if os.Getenv("RELAY_CHECK_WORKER") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Exit(process.Worker(os.Args[i+1:]))
		}
	}
	os.Exit(127)
}

func checkFixture(t *testing.T, onEvent func(context.Context, map[string]any) error) (*Runner, string) {
	t.Helper()
	root := t.TempDir()
	worker, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if onEvent == nil {
		onEvent = func(context.Context, map[string]any) error { return nil }
	}
	runner, err := StartRunner(context.Background(), RunnerOptions{WorkerExecutable: worker, WorkerArgs: []string{"-test.run=^TestCheckWorker$", "--"}, Environment: map[string]string{"RELAY_CHECK_WORKER": "1"}, Repositories: []Repository{{ID: "repo", Root: root}}, SourceFingerprint: "source-fingerprint", Timeout: 10 * time.Second, OnEvent: onEvent})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runner.Close() })
	return runner, root
}

func checkArgs(r *Runner, cwd string, command ...string) []string {
	return append([]string{"--socket", r.Socket(), "--token", r.Token(), "--repository", "repo", "--cwd", cwd, "--"}, command...)
}

func TestSupervisedCheckRecordsLiteralArgumentsAndExitStatus(t *testing.T) {
	var mu sync.Mutex
	events := []map[string]any{}
	runner, root := checkFixture(t, func(_ context.Context, event map[string]any) error {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, event)
		return nil
	})
	marker := filepath.Join(root, "must-not-exist")
	argument := "literal $(touch " + marker + ")"
	var output, stderr bytes.Buffer
	if code := RunClient(checkArgs(runner, root, "/bin/echo", argument), &output, &stderr); code != 0 {
		t.Fatalf("check failed: %d %s", code, stderr.String())
	}
	if !strings.Contains(output.String(), argument) {
		t.Fatalf("literal output missing: %s", output.String())
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("command argument was interpreted by a shell")
	}
	records := runner.Records()
	if len(records) != 1 || records[0].Status != "complete" || records[0].Code == nil || *records[0].Code != 0 || records[0].SourceFingerprint != "source-fingerprint" || len(records[0].Args) != 1 || records[0].Args[0] != argument {
		t.Fatalf("incorrect evidence: %#v", records)
	}
	records[0].Args[0] = "tampered"
	*records[0].Code = 99
	if saved := runner.Records(); saved[0].Args[0] != argument || saved[0].Code == nil || *saved[0].Code != 0 {
		t.Fatal("returned evidence could mutate the runner journal")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(events) < 3 {
		t.Fatalf("check activity was not streamed: %#v", events)
	}
}

func TestSupervisedCheckRejectsInvalidSessionAndEscapingDirectory(t *testing.T) {
	runner, root := checkFixture(t, nil)
	var output, stderr bytes.Buffer
	args := checkArgs(runner, root, "/bin/echo", "bad")
	args[3] = strings.Repeat("0", len(runner.Token()))
	if code := RunClient(args, &output, &stderr); code == 0 || !strings.Contains(stderr.String(), "session") {
		t.Fatalf("invalid token accepted: %d %s", code, stderr.String())
	}
	stderr.Reset()
	if code := RunClient(checkArgs(runner, t.TempDir(), "/bin/echo", "bad"), &output, &stderr); code == 0 || !strings.Contains(stderr.String(), "outside") {
		t.Fatalf("outside directory accepted: %d %s", code, stderr.String())
	}
	outside := t.TempDir()
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	stderr.Reset()
	if code := RunClient(checkArgs(runner, link, "/bin/echo", "bad"), &output, &stderr); code == 0 {
		t.Fatal("escaping symlink accepted")
	}
	if len(runner.Records()) != 0 {
		t.Fatal("rejected checks were executed")
	}
}

func TestSupervisedCheckRejectsReplacedRepository(t *testing.T) {
	runner, root := checkFixture(t, nil)
	if err := os.Rename(root, root+"-original"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root + "-original") })
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	var output, stderr bytes.Buffer
	if code := RunClient(checkArgs(runner, root, "/bin/echo", "bad"), &output, &stderr); code == 0 || !strings.Contains(stderr.String(), "repository changed") {
		t.Fatalf("replacement repository accepted: %d %s", code, stderr.String())
	}
	if len(runner.Records()) != 0 {
		t.Fatal("check ran in a replacement repository")
	}
}

func TestRunnerDoesNotRemoveReplacementDirectory(t *testing.T) {
	runner, _ := checkFixture(t, nil)
	directory := filepath.Dir(runner.Socket())
	old := directory + "-original"
	if err := os.Rename(directory, old); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(directory); _ = os.RemoveAll(old) })
	outside := t.TempDir()
	marker := filepath.Join(outside, "check.sock")
	if err := os.WriteFile(marker, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, directory); err != nil {
		t.Fatal(err)
	}
	if err := runner.Close(); err == nil {
		t.Fatal("replacement directory was not reported")
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "preserve" {
		t.Fatal("cleanup modified the replacement directory")
	}
}

func TestSupervisedCheckReportsFailureAndDoesNotInventEvidence(t *testing.T) {
	runner, root := checkFixture(t, nil)
	var output, stderr bytes.Buffer
	if code := RunClient(checkArgs(runner, root, "/bin/sh", "-c", "exit 7"), &output, &stderr); code != 7 {
		t.Fatalf("exit code lost: %d %s", code, stderr.String())
	}
	records := runner.Records()
	if len(records) != 1 || records[0].Status != "complete" || records[0].Code == nil || *records[0].Code != 7 {
		t.Fatalf("failed check was not recorded: %#v", records)
	}
}

func TestSupervisedChecksShareResourceGate(t *testing.T) {
	var mu sync.Mutex
	active, maxActive := 0, 0
	runner, root := checkFixture(t, func(_ context.Context, event map[string]any) error {
		mu.Lock()
		defer mu.Unlock()
		summary, _ := event["summary"].(string)
		if summary == "Running supervised check" {
			active++
			if active > maxActive {
				maxActive = active
			}
		} else if strings.HasPrefix(summary, "Supervised check exited") {
			active--
		}
		return nil
	})
	var group sync.WaitGroup
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			var stdout, stderr bytes.Buffer
			codes <- RunClient(checkArgs(runner, root, "/bin/sh", "-c", "sleep 0.2"), &stdout, &stderr)
		}()
	}
	group.Wait()
	close(codes)
	for code := range codes {
		if code != 0 {
			t.Fatalf("check failed: %d", code)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if maxActive != 1 || active != 0 || len(runner.Records()) != 2 {
		t.Fatalf("checks overlapped or lost evidence: max %d active %d", maxActive, active)
	}
}

func TestSupervisedCheckDoesNotRecordSuccessWhenEventFails(t *testing.T) {
	runner, root := checkFixture(t, func(_ context.Context, event map[string]any) error {
		if strings.HasPrefix(text(event["summary"]), "Supervised check exited") {
			return errors.New("event store unavailable")
		}
		return nil
	})
	var output, stderr bytes.Buffer
	if code := RunClient(checkArgs(runner, root, "/bin/echo", "hello"), &output, &stderr); code == 0 {
		t.Fatal("event failure was ignored")
	}
	records := runner.Records()
	if len(records) != 1 || records[0].Status != "interrupted" || records[0].Code != nil {
		t.Fatalf("event failure became passing evidence: %#v", records)
	}
}

func TestClosingRunnerStopsAnActiveCheck(t *testing.T) {
	runner, root := checkFixture(t, nil)
	marker := filepath.Join(root, "started")
	done := make(chan int, 1)
	go func() {
		var stdout, stderr bytes.Buffer
		done <- RunClient(checkArgs(runner, root, "/bin/sh", "-c", `touch "$1"; sleep 30`, "fixture", marker), &stdout, &stderr)
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("check did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := runner.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-done:
		if code == 0 {
			t.Fatal("cancelled check succeeded")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled check did not terminate")
	}
	records := runner.Records()
	if len(records) != 1 || records[0].Status != "interrupted" {
		t.Fatalf("cancelled check was not recorded: %#v", records)
	}
}
