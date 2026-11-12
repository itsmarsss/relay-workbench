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
func TestInteractiveTerminalWindows(t *testing.T) {
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
	windows, err := Windows(ctx, spec.Info)
	if err != nil || len(windows) != 1 || windows[0].Name != "sh" || !windows[0].Active {
		t.Fatalf("first window: %#v %v", windows, err)
	}
	frames := make(chan map[string]any, 100)
	go func() {
		_ = Stream(ctx, spec.Info, func(frame map[string]any) error { frames <- frame; return nil })
	}()
	await := func(kind string) {
		t.Helper()
		for timeout := time.After(5 * time.Second); ; {
			select {
			case frame := <-frames:
				if frame["type"] == kind {
					return
				}
			case <-timeout:
				t.Fatalf("no %s frame", kind)
			}
		}
	}
	await("snapshot")
	literal := "$(touch SHOULD_NOT_EXIST)"
	if err = NewWindow(ctx, spec.Info, "shell", spec.Cwd, map[string]string{"RELAY_WINDOW_MARK": literal}, "/bin/sh", []string{"-i"}); err != nil {
		t.Fatal(err)
	}
	await("windows")
	await("snapshot")
	windows, err = Windows(ctx, spec.Info)
	if err != nil || len(windows) != 2 || windows[1].Name != "shell" || !windows[1].Active || windows[0].Active {
		t.Fatalf("second window: %#v %v", windows, err)
	}
	// Typing reaches the window on show, with its environment passed literally.
	if err = Input(ctx, spec.Info, "printf 'mark=%s\\n' \"$RELAY_WINDOW_MARK\"\r"); err != nil {
		t.Fatal(err)
	}
	for deadline = time.Now().Add(5 * time.Second); ; time.Sleep(30 * time.Millisecond) {
		screen, _ := Capture(ctx, spec.Info)
		if strings.Contains(screen, "mark="+literal) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("input did not reach the new window: %q", screen)
		}
	}
	if _, statErr := os.Stat(filepath.Join(spec.Cwd, "SHOULD_NOT_EXIST")); statErr == nil {
		t.Fatal("window environment was evaluated")
	}
	if err = SelectWindow(ctx, spec.Info, windows[0].Index); err != nil {
		t.Fatal(err)
	}
	await("windows")
	if screen, _ := Capture(ctx, spec.Info); strings.Contains(screen, "mark=") {
		t.Fatalf("first window shows the second window's output: %q", screen)
	}
	if err = CloseWindow(ctx, spec.Info, windows[0].Index); err == nil {
		t.Fatal("the session's own window was closed")
	}
	if err = CloseWindow(ctx, spec.Info, windows[1].Index); err != nil {
		t.Fatal(err)
	}
	if windows, err = Windows(ctx, spec.Info); err != nil || len(windows) != 1 {
		t.Fatalf("after close: %#v %v", windows, err)
	}
	if err = NewWindow(ctx, spec.Info, "bad\nname", spec.Cwd, nil, "/bin/sh", nil); err == nil {
		t.Fatal("control text accepted as a window name")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("terminal did not stop")
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

func TestViewerRefusesControlTextInSessionNames(t *testing.T) {
	for _, name := range []string{"relay-ok\nkill-server", "relay-x;kill-server", "relay-x\r", "-target"} {
		info := Info{Session: name, Socket: filepath.Join(t.TempDir(), "tmux.sock")}
		if _, err := Capture(context.Background(), info); err == nil {
			t.Fatal("unsafe capture target accepted")
		}
		if err := Stream(context.Background(), info, func(map[string]any) error { t.Fatal("unsafe viewer opened"); return nil }); err == nil {
			t.Fatal("unsafe viewer accepted")
		}
	}
}
