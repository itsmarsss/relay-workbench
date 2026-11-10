//go:build darwin || linux

package terminal

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"relay.local/relay/internal/process"
)

func TestTerminalModes(t *testing.T) {
	if os.Getenv("RELAY_TERMINAL_TEST") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			args := os.Args[i+1:]
			if len(args) == 0 {
				os.Exit(127)
			}
			switch args[0] {
			case "--internal-terminal-worker":
				os.Exit(Worker(args[1:]))
			case "--internal-terminal-pane":
				os.Exit(Pane(args[1:]))
			default:
				os.Exit(process.Worker(args))
			}
		}
	}
	os.Exit(127)
}
func testSpec(t *testing.T, interactive bool, command string, args []string) (Spec, string, process.Options) {
	t.Helper()
	if !Available() {
		t.Skip("tmux is not installed")
	}
	worker, _ := os.Executable()
	workerArgs := []string{"-test.run=^TestTerminalModes$", "--"}
	env := map[string]string{"RELAY_TERMINAL_TEST": "1", "GORACE": "atexit_sleep_ms=0"}
	spec, path, err := Prepare(worker, workerArgs, command, args, t.TempDir(), env, []byte("literal prompt\n"), interactive)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(spec.Directory) })
	return spec, path, process.Options{WorkerExecutable: worker, WorkerArgs: workerArgs, Command: worker, Args: append(append([]string{}, workerArgs...), "--internal-terminal-worker", path), Directory: spec.Cwd, Environment: env, Timeout: 10 * time.Second, MaxOutputBytes: 1024 * 1024}
}
func TestTerminalLiteralArgumentsAndActualExit(t *testing.T) {
	literal := "$(touch SHOULD_NOT_EXIST); spaced ' quote"
	spec, _, options := testSpec(t, false, "/bin/sh", []string{"-c", "cat; printf '%s' \"$1\"; printf err >&2; exit 7", "fixture", literal})
	result, err := process.Run(context.Background(), options)
	if err != nil || result.ExitCode != 7 || !strings.Contains(result.Stdout, "literal prompt\n"+literal) || !strings.Contains(result.Stderr, "err") {
		t.Fatalf("terminal result: %#v %v", result, err)
	}
	if _, err = os.Stat(filepath.Join(spec.Cwd, "SHOULD_NOT_EXIST")); !os.IsNotExist(err) {
		t.Fatal("literal argument executed")
	}
	if _, err = Capture(context.Background(), spec.Info); err == nil {
		t.Fatal("terminal server leaked after completion")
	}
}
func TestInteractiveTerminalStreamsInputAndCancels(t *testing.T) {
	spec, _, options := testSpec(t, true, "/bin/sh", []string{"-i"})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := process.Run(ctx, options); done <- err }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := Capture(context.Background(), spec.Info); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("terminal not ready")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := Resize(ctx, spec.Info, 100, 24); err != nil {
		t.Fatal(err)
	}
	if err := Input(ctx, spec.Info, "printf 'terminal-ready\\n'\r"); err != nil {
		t.Fatal(err)
	}
	streamCtx, stop := context.WithCancel(ctx)
	frames := make(chan map[string]any, 10)
	streamDone := make(chan error, 1)
	go func() {
		streamDone <- Stream(streamCtx, spec.Info, func(frame map[string]any) error { frames <- frame; return nil })
	}()
	select {
	case frame := <-frames:
		if frame["type"] != "snapshot" {
			t.Fatalf("missing snapshot: %#v", frame)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("terminal stream did not connect")
	}
	stop()
	select {
	case <-streamDone:
	case <-time.After(3 * time.Second):
		t.Fatal("stream did not disconnect")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, process.ErrCancelled) {
			t.Fatalf("cancel: %v", err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("terminal did not stop")
	}
	if _, err := Capture(context.Background(), spec.Info); err == nil {
		t.Fatal("interactive server leaked")
	}
}
func TestTerminalOutputDecoding(t *testing.T) {
	if got := string(decodeOutput("hi\\015\\012\\134 UTF-8: π")); got != "hi\r\n\\ UTF-8: π" {
		t.Fatalf("corrupt stream: %q", got)
	}
	if err := Resize(context.Background(), Info{}, 0, 0); err == nil {
		t.Fatal("invalid size accepted")
	}
}
