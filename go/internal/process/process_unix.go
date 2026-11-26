//go:build darwin || linux

package process

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"relay.local/relay/internal/runtimebudget"
)

type statusMessage struct {
	Type   string `json:"type"`
	PID    int    `json:"pid,omitempty"`
	Code   *int   `json:"code,omitempty"`
	Signal string `json:"signal,omitempty"`
}
type lineEvent struct{ text, stream string }
type collector struct {
	mu             sync.Mutex
	total, limit   int
	stdout, stderr bytes.Buffer
	pending        map[string][]byte
	callback       func(context.Context, string, string) error
	callbackCtx    context.Context
	cancel         context.CancelFunc
	lines          chan lineEvent
	callbackDone   chan struct{}
	failed         chan error
	once           sync.Once
	sink           io.Writer
}
type streamWriter struct {
	c      *collector
	stream string
}

func newCollector(ctx context.Context, limit int, callback func(context.Context, string, string) error) *collector {
	cbCtx, cancel := context.WithCancel(ctx)
	c := &collector{limit: limit, pending: map[string][]byte{}, callback: callback, callbackCtx: cbCtx, cancel: cancel, lines: make(chan lineEvent, 8192), callbackDone: make(chan struct{}), failed: make(chan error, 1)}
	go func() {
		defer close(c.callbackDone)
		for event := range c.lines {
			if err := c.line(event.text, event.stream); err != nil {
				c.fail(err)
				return
			}
		}
	}()
	return c
}
func (c *collector) fail(err error) { c.once.Do(func() { c.failed <- err; c.cancel() }) }
func (c *collector) line(line, stream string) (err error) {
	if c.callback == nil {
		return nil
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("output callback panicked: %v", recovered)
		}
	}()
	return c.callback(c.callbackCtx, line, stream)
}
func (c *collector) enqueue(line, stream string) {
	if c.callback == nil {
		return
	}
	select {
	case c.lines <- lineEvent{line, stream}:
	default:
		c.fail(ErrOutputBackpressure)
	}
}
func (w streamWriter) Write(p []byte) (int, error) {
	c := w.c
	c.mu.Lock()
	defer c.mu.Unlock()
	if w.stream == "stdout" && c.sink != nil {
		if _, err := c.sink.Write(p); err != nil {
			c.fail(err)
		}
		return len(p), nil
	}
	if len(p) > c.limit-c.total {
		c.fail(ErrOutputLimit)
		return len(p), nil
	}
	c.total += len(p)
	if w.stream == "stdout" {
		_, _ = c.stdout.Write(p)
	} else {
		_, _ = c.stderr.Write(p)
	}
	c.pending[w.stream] = append(c.pending[w.stream], p...)
	for {
		pos := bytes.IndexByte(c.pending[w.stream], '\n')
		if pos < 0 {
			break
		}
		line := string(c.pending[w.stream][:pos])
		c.pending[w.stream] = c.pending[w.stream][pos+1:]
		c.enqueue(line, w.stream)
	}
	return len(p), nil
}
func (c *collector) finish() {
	c.mu.Lock()
	for _, name := range []string{"stdout", "stderr"} {
		if len(c.pending[name]) > 0 {
			c.enqueue(string(c.pending[name]), name)
		}
	}
	close(c.lines)
	c.mu.Unlock()
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-c.callbackDone:
	case <-timer.C:
		c.fail(ErrCallbackBlocked)
	}
	c.cancel()
}
func (c *collector) result() (string, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stdout.String(), c.stderr.String()
}
func environment(overrides map[string]string) ([]string, error) {
	values := map[string]string{}
	for _, entry := range os.Environ() {
		if i := strings.IndexByte(entry, '='); i >= 0 {
			values[entry[:i]] = entry[i+1:]
		}
	}
	for key, value := range overrides {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, '\x00') {
			return nil, errors.New("invalid process environment")
		}
		values[key] = value
	}
	result := make([]string, 0, len(values))
	for key, value := range values {
		result = append(result, key+"="+value)
	}
	return result, nil
}

// Run starts an internal worker using explicit arguments, then waits until the
// target process and ordinary descendants have terminated. Output callbacks
// receive a cancellation context and must honor it promptly.
func Run(ctx context.Context, options Options) (Result, error) {
	if ctx == nil {
		return Result{}, errors.New("context required")
	}
	if err := ctx.Err(); err != nil {
		return Result{}, ErrCancelled
	}
	if options.WorkerExecutable == "" || options.Command == "" || options.Directory == "" || options.Timeout <= 0 || options.MaxOutputBytes <= 0 {
		return Result{}, errors.New("invalid process options")
	}
	if options.Progress != nil && (options.Timeout < time.Millisecond || options.Progress.MaxTimeout < 0 || options.Progress.ProgressWindow < 0) {
		return Result{}, errors.New("invalid progress policy")
	}
	env, err := environment(options.Environment)
	if err != nil {
		return Result{}, err
	}
	grace := options.TerminationGrace
	if grace <= 0 {
		grace = 2 * time.Second
	}
	aliveRead, aliveWrite, err := os.Pipe()
	if err != nil {
		return Result{}, err
	}
	defer aliveRead.Close()
	defer aliveWrite.Close()
	statusRead, statusWrite, err := os.Pipe()
	if err != nil {
		return Result{}, err
	}
	defer statusRead.Close()
	defer statusWrite.Close()
	args := append(append(append([]string{}, options.WorkerArgs...), options.Command), options.Args...)
	cmd := exec.Command(options.WorkerExecutable, args...)
	cmd.Dir = options.Directory
	cmd.Env = env
	cmd.Stdin = bytes.NewReader(options.Input)
	if options.InputFile != nil {
		cmd.Stdin = options.InputFile
	}
	cmd.ExtraFiles = []*os.File{aliveRead, statusWrite}
	c := newCollector(ctx, options.MaxOutputBytes, options.OnLine)
	c.sink = options.StdoutSink
	cmd.Stdout = streamWriter{c, "stdout"}
	cmd.Stderr = streamWriter{c, "stderr"}
	cmd.WaitDelay = grace + time.Second
	if err = cmd.Start(); err != nil {
		c.finish()
		return Result{}, fmt.Errorf("could not launch supervisor: %w", err)
	}
	_ = aliveRead.Close()
	_ = statusWrite.Close()
	type statusState struct {
		pid    int
		clean  bool
		code   *int
		signal string
	}
	state := statusState{}
	var stateMu sync.Mutex
	statusDone := make(chan struct{})
	go func() {
		defer close(statusDone)
		scanner := bufio.NewScanner(statusRead)
		scanner.Buffer(make([]byte, 128), 4096)
		for scanner.Scan() {
			var msg statusMessage
			if json.Unmarshal(scanner.Bytes(), &msg) != nil {
				continue
			}
			stateMu.Lock()
			if msg.Type == "ready" && msg.PID > 1 {
				state.pid = msg.PID
			}
			if msg.Type == "clean" {
				state.clean = true
			}
			if msg.Type == "result" {
				state.code = msg.Code
				state.signal = msg.Signal
			}
			stateMu.Unlock()
		}
	}()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	started := time.Now()
	var budget *runtimebudget.Budget
	var lastProgress *float64
	notify := func() runtimebudget.Snapshot {
		if options.Progress.LastProgressUnixMillis != nil {
			value := options.Progress.LastProgressUnixMillis.Load()
			if value > 0 {
				number := float64(value)
				lastProgress = &number
			} else {
				lastProgress = nil
			}
		}
		snapshot, _ := budget.Snapshot(lastProgress)
		if options.Progress.Updates != nil {
			func() {
				defer func() { _ = recover() }()
				select {
				case options.Progress.Updates <- snapshot:
				default:
				}
			}()
		}
		return snapshot
	}
	if options.Progress != nil {
		var maximum, window *float64
		if options.Progress.MaxTimeout > 0 {
			v := float64(options.Progress.MaxTimeout.Milliseconds())
			maximum = &v
		}
		if options.Progress.ProgressWindow > 0 {
			v := float64(options.Progress.ProgressWindow.Milliseconds())
			window = &v
		}
		budget = runtimebudget.New(float64(options.Timeout.Milliseconds()), float64(started.UnixMilli()), maximum, window)
		notify()
	}
	timer := time.NewTimer(options.Timeout)
	defer timer.Stop()
	var result Result
	var failure, errorWait error
	waiting := true
	for waiting {
		select {
		case errorWait = <-done:
			waiting = false
		case <-ctx.Done():
			failure = ErrCancelled
			waiting = false
		case failure = <-c.failed:
			waiting = false
		case <-timer.C:
			if budget == nil {
				failure = ErrTimeout
				waiting = false
				break
			}
			snapshot := notify()
			switch budget.Evaluate(float64(time.Now().UnixMilli()), lastProgress) {
			case runtimebudget.Extend:
				notify()
				delay := time.Until(time.UnixMilli(int64(budget.SoftDeadline)))
				if delay < time.Millisecond {
					delay = time.Millisecond
				}
				timer.Reset(delay)
			case runtimebudget.Wait:
				delay := time.Until(time.UnixMilli(int64(budget.SoftDeadline)))
				if delay < time.Millisecond {
					delay = time.Millisecond
				}
				timer.Reset(delay)
			default:
				failure = &BudgetError{Snapshot: snapshot}
				waiting = false
			}
		}
	}
	if failure != nil {
		c.cancel()
		_ = aliveWrite.Close()
		_ = cmd.Process.Signal(syscall.SIGTERM)
		hard := time.NewTimer(grace + time.Second)
		select {
		case errorWait = <-done:
			if !hard.Stop() {
				select {
				case <-hard.C:
				default:
				}
			}
		case <-hard.C:
			stateMu.Lock()
			pid := state.pid
			stateMu.Unlock()
			if pid > 1 {
				_ = syscall.Kill(-pid, syscall.SIGKILL)
			}
			_ = cmd.Process.Kill()
			errorWait = <-done
		}
	}
	_ = aliveWrite.Close()
	<-statusDone
	stateMu.Lock()
	pid, clean, code, targetSignal := state.pid, state.clean, state.code, state.signal
	stateMu.Unlock()
	if clean && (code == nil || (*code == 0 && pid <= 1) || (cmd.ProcessState != nil && *code >= 0 && cmd.ProcessState.ExitCode() != *code)) {
		clean = false
	}
	if !clean {
		if pid > 1 {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		}
		failure = errors.Join(failure, ErrCleanup)
	}
	c.finish()
	result.Stdout, result.Stderr = c.result()
	if failure == nil {
		select {
		case failure = <-c.failed:
		default:
		}
	}
	if cmd.ProcessState != nil {
		result.ExitCode = cmd.ProcessState.ExitCode()
		if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			result.Signal = ws.Signal().String()
		}
	}
	if code != nil {
		result.ExitCode = *code
		result.Signal = targetSignal
	}
	if failure != nil {
		return result, failure
	}
	if errorWait != nil {
		var exit *exec.ExitError
		if !errors.As(errorWait, &exit) {
			return result, errorWait
		}
	}
	return result, nil
}

func signalName(signal syscall.Signal) string {
	switch signal {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGQUIT:
		return "SIGQUIT"
	default:
		return signal.String()
	}
}

// Worker executes a command in a dedicated process group and stops that group
// on parent death, cancellation, or command completion. It uses fds 3 and 4.
func Worker(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "worker requires a command")
		return 127
	}
	alive := os.NewFile(3, "parent-liveness")
	status := os.NewFile(4, "worker-status")
	if alive == nil || status == nil {
		return 127
	}
	defer alive.Close()
	defer status.Close()
	syscall.CloseOnExec(3)
	syscall.CloseOnExec(4)
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	// A Relay started under nohup ignores SIGHUP, and an ignored signal stays ignored in every
	// program it starts: a shell then cannot trap HUP, and tools or tests that rely on it hang.
	// A caught signal is reset to its default when a program starts, so catching (and dropping)
	// SIGHUP here gives the command the default disposition it would get from a terminal.
	hangup := make(chan os.Signal, 1)
	signal.Notify(hangup, syscall.SIGHUP)
	defer signal.Stop(hangup)
	child := exec.Command(args[0], args[1:]...)
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := child.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "could not launch %s: %v\n", args[0], err)
		code := 127
		encoded, _ := json.Marshal(statusMessage{Type: "result", Code: &code})
		_, _ = fmt.Fprintln(status, string(encoded))
		_, _ = fmt.Fprintln(status, `{"type":"clean"}`)
		return 127
	}
	pid := child.Process.Pid
	_, _ = fmt.Fprintf(status, "{\"type\":\"ready\",\"pid\":%d}\n", pid)
	parentDone := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, alive); close(parentDone) }()
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	interrupted := false
	var waitErr error
	select {
	case waitErr = <-done:
	case <-parentDone:
		interrupted = true
	case <-signals:
		interrupted = true
	}
	// Stop descendants even if the target leader already exited. Until the
	// group disappears, report cleanup as unverified to prevent progression.
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	deadline := time.Now().Add(2 * time.Second)
	clean := false
	for time.Now().Before(deadline) {
		if err := syscall.Kill(-pid, 0); errors.Is(err, syscall.ESRCH) {
			clean = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !clean {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		deadline = time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			if err := syscall.Kill(-pid, 0); errors.Is(err, syscall.ESRCH) {
				clean = true
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	if interrupted {
		select {
		case waitErr = <-done:
		case <-time.After(time.Second):
		}
	}
	code := 0
	targetSignal := ""
	if waitErr != nil {
		code = 1
		var exit *exec.ExitError
		if errors.As(waitErr, &exit) {
			code = exit.ExitCode()
			if ws, ok := exit.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				targetSignal = signalName(ws.Signal())
			}
		}
	}
	if interrupted && waitErr == nil {
		code = 1
	}
	encoded, _ := json.Marshal(statusMessage{Type: "result", Code: &code, Signal: targetSignal})
	_, _ = fmt.Fprintln(status, string(encoded))
	if clean {
		_, _ = fmt.Fprintln(status, `{"type":"clean"}`)
	}
	if code < 0 {
		return 1
	}
	return code
}
