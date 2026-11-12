// Package terminal hosts private tmux sessions without evaluating task text.
package terminal

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Info struct {
	Session       string `json:"session"`
	Socket        string `json:"socket"`
	AttachCommand string `json:"attachCommand"`
	Interactive   bool   `json:"interactive"`
}
type Spec struct {
	Info       Info              `json:"terminal"`
	Command    string            `json:"command"`
	Args       []string          `json:"args"`
	Cwd        string            `json:"cwd"`
	Env        map[string]string `json:"env"`
	Worker     string            `json:"worker"`
	WorkerArgs []string          `json:"workerArgs"`
	Directory  string            `json:"directory"`
}
type Result struct {
	Code  int    `json:"code"`
	Error string `json:"error,omitempty"`
}

var validSession = regexp.MustCompile(`^relay-[A-Za-z0-9_-]{1,100}$`)

func validateInfo(info Info) error {
	if !validSession.MatchString(info.Session) || !filepath.IsAbs(info.Socket) || strings.ContainsAny(info.Socket, "\x00\r\n") {
		return errors.New("invalid terminal")
	}
	return nil
}

func Available() bool { _, err := exec.LookPath("tmux"); return err == nil }
func Prepare(worker string, args []string, command string, commandArgs []string, cwd string, env map[string]string, prompt []byte, interactive bool) (Spec, string, error) {
	if worker == "" || command == "" || !filepath.IsAbs(cwd) {
		return Spec{}, "", errors.New("invalid terminal invocation")
	}
	if !Available() {
		return Spec{}, "", errors.New("install tmux to use live terminals")
	}
	dir, err := os.MkdirTemp("", "relay-tty-")
	if err != nil {
		return Spec{}, "", err
	}
	session := "relay-" + filepath.Base(dir)[len("relay-tty-"):]
	socket := filepath.Join(dir, "tmux.sock")
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }
	spec := Spec{Info: Info{session, socket, "tmux -S " + quote(socket) + " attach-session -t " + quote(session), interactive}, Command: command, Args: commandArgs, Cwd: cwd, Env: env, Worker: worker, WorkerArgs: args, Directory: dir}
	encoded, err := json.Marshal(spec)
	if err == nil {
		err = os.WriteFile(filepath.Join(dir, "spec.json"), encoded, 0600)
	}
	if err == nil {
		err = os.WriteFile(filepath.Join(dir, "input"), prompt, 0600)
	}
	for _, name := range []string{"stdout", "stderr"} {
		if err == nil {
			err = os.WriteFile(filepath.Join(dir, name), nil, 0600)
		}
	}
	if err != nil {
		os.RemoveAll(dir)
		return Spec{}, "", err
	}
	return spec, filepath.Join(dir, "spec.json"), nil
}
func readSpec(path string) (Spec, error) {
	var spec Spec
	data, err := os.ReadFile(path)
	if err != nil {
		return spec, err
	}
	if len(data) > 1024*1024 || json.Unmarshal(data, &spec) != nil || spec.Directory != filepath.Dir(path) || !filepath.IsAbs(spec.Cwd) || validateInfo(spec.Info) != nil || spec.Info.Socket != filepath.Join(spec.Directory, "tmux.sock") {
		return spec, errors.New("invalid private terminal specification")
	}
	return spec, nil
}
func command(ctx context.Context, info Info, args ...string) ([]byte, error) {
	if err := validateInfo(info); err != nil {
		return nil, err
	}
	bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	child := exec.CommandContext(bounded, "tmux", append([]string{"-S", info.Socket}, args...)...)
	return child.CombinedOutput()
}
func Input(ctx context.Context, info Info, data string) error {
	if len(data) == 0 || len(data) > 8192 {
		return errors.New("terminal input must contain 1 to 8192 bytes")
	}
	encoded := hex.EncodeToString([]byte(data))
	args := []string{"send-keys", "-t", info.Session, "-H"}
	for i := 0; i < len(encoded); i += 2 {
		args = append(args, encoded[i:i+2])
	}
	_, err := command(ctx, info, args...)
	return err
}
func Resize(ctx context.Context, info Info, cols, rows int) error {
	if cols < 20 || cols > 500 || rows < 5 || rows > 200 {
		return errors.New("invalid terminal dimensions")
	}
	_, err := command(ctx, info, "resize-window", "-t", info.Session, "-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows))
	return err
}
func Capture(ctx context.Context, info Info) (string, error) {
	out, err := command(ctx, info, "capture-pane", "-e", "-p", "-t", info.Session)
	if len(out) > 1024*1024 {
		return "", errors.New("terminal preview is too large")
	}
	return string(out), err
}

// Window is one tmux window of a terminal's private session. The first is the terminal the
// session was started for; the rest are extra shells or agents a person opened beside it.
type Window struct {
	Index  int    `json:"index"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
	Dead   bool   `json:"dead"`
}

const maxWindows = 8

var validWindowName = regexp.MustCompile(`^[A-Za-z0-9 ._-]{1,40}$`)

func Windows(ctx context.Context, info Info) ([]Window, error) {
	out, err := command(ctx, info, "list-windows", "-t", info.Session, "-F", "#{window_index}\t#{window_active}\t#{pane_dead}\t#{window_name}")
	if err != nil {
		return nil, err
	}
	windows := []Window{}
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		parts := strings.SplitN(line, "\t", 4)
		if len(parts) != 4 {
			continue
		}
		index, err := strconv.Atoi(parts[0])
		if err != nil {
			continue
		}
		windows = append(windows, Window{Index: index, Name: parts[3], Active: parts[1] == "1", Dead: parts[2] == "1"})
	}
	return windows, nil
}

// NewWindow opens another program in the session and shows it. Arguments are passed to tmux as
// an argument list, never as shell text.
func NewWindow(ctx context.Context, info Info, name, cwd string, env map[string]string, program string, args []string) error {
	if !info.Interactive || !validWindowName.MatchString(name) || !filepath.IsAbs(cwd) || program == "" {
		return errors.New("invalid terminal window")
	}
	windows, err := Windows(ctx, info)
	if err != nil {
		return err
	}
	if len(windows) >= maxWindows {
		return errors.New("close a terminal before opening another")
	}
	call := []string{"new-window", "-t", info.Session + ":", "-n", name, "-c", cwd}
	for key, value := range env {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, 0) {
			return errors.New("invalid terminal environment")
		}
		call = append(call, "-e", key+"="+value)
	}
	call = append(append(call, "--", program), args...)
	if out, err := command(ctx, info, call...); err != nil {
		return fmt.Errorf("could not open a terminal: %s", strings.TrimSpace(string(out)))
	}
	// Unlike the first window, an extra one simply goes away when its program exits.
	_, _ = command(ctx, info, "set-option", "-w", "-t", info.Session, "remain-on-exit", "off")
	_, _ = command(ctx, info, "set-option", "-w", "-t", info.Session, "automatic-rename", "off")
	return nil
}
func SelectWindow(ctx context.Context, info Info, index int) error {
	if index < 0 || index > 1000 {
		return errors.New("invalid terminal window")
	}
	_, err := command(ctx, info, "select-window", "-t", info.Session+":"+strconv.Itoa(index))
	return err
}

// CloseWindow ends an extra window. The first window is the session itself and ends only when
// control is returned.
func CloseWindow(ctx context.Context, info Info, index int) error {
	windows, err := Windows(ctx, info)
	if err != nil {
		return err
	}
	if len(windows) == 0 || index <= windows[0].Index || index > 1000 {
		return errors.New("the first terminal closes when control is returned")
	}
	_, err = command(ctx, info, "kill-window", "-t", info.Session+":"+strconv.Itoa(index))
	return err
}

// Worker is itself run under the liveness-supervised process worker. Its
// foreground tmux server is never shared with another task or application.
func Worker(args []string) int {
	if len(args) != 1 {
		return 127
	}
	spec, err := readSpec(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 127
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()
	server := exec.Command("tmux", "-D", "-S", spec.Info.Socket, "-f", "/dev/null")
	server.Stderr = os.Stderr
	if err = server.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 127
	}
	done := make(chan error, 1)
	go func() { done <- server.Wait() }()
	defer func() {
		_, _ = command(context.Background(), spec.Info, "kill-server")
		_ = server.Process.Kill()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}()
	ready := false
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if _, err = command(ctx, spec.Info, "show-options", "-s"); err == nil {
			ready = true
			break
		}
		select {
		case <-ctx.Done():
			return 130
		case <-time.After(20 * time.Millisecond):
		}
	}
	if !ready {
		fmt.Fprintln(os.Stderr, "tmux did not start")
		return 127
	}
	name := filepath.Base(spec.Command)
	if !validWindowName.MatchString(name) {
		name = "terminal"
	}
	paneArgs := append([]string{"new-session", "-d", "-s", spec.Info.Session, "-n", name, "-x", "120", "-y", "35", "-c", spec.Cwd, "--", spec.Worker}, spec.WorkerArgs...)
	paneArgs = append(paneArgs, "--internal-terminal-pane", args[0])
	if out, err := command(ctx, spec.Info, paneArgs...); err != nil {
		fmt.Fprintln(os.Stderr, string(out), err)
		return 127
	}
	_, _ = command(ctx, spec.Info, "set-option", "-t", spec.Info.Session, "remain-on-exit", "on")
	_, _ = command(ctx, spec.Info, "set-option", "-w", "-t", spec.Info.Session, "automatic-rename", "off")
	offsets := map[string]int64{}
	flush := func() error {
		for _, item := range []struct {
			name string
			dst  io.Writer
		}{{"stdout", os.Stdout}, {"stderr", os.Stderr}} {
			f, err := os.Open(filepath.Join(spec.Directory, item.name))
			if err != nil {
				return err
			}
			stat, err := f.Stat()
			if err != nil {
				f.Close()
				return err
			}
			if stat.Size() > 8*1024*1024 {
				f.Close()
				return errors.New("terminal output exceeded limit")
			}
			n, err := io.Copy(item.dst, io.NewSectionReader(f, offsets[item.name], stat.Size()-offsets[item.name]))
			f.Close()
			offsets[item.name] += n
			if err != nil {
				return err
			}
		}
		return nil
	}
	ticker := time.NewTicker(60 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return 130
		case <-done:
			fmt.Fprintln(os.Stderr, "terminal server stopped")
			return 1
		case <-ticker.C:
			if err = flush(); err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 1
			}
			if raw, readErr := os.ReadFile(filepath.Join(spec.Directory, "result.json")); readErr == nil {
				var result Result
				if json.Unmarshal(raw, &result) != nil {
					return 1
				}
				_ = flush()
				if result.Error != "" {
					fmt.Fprintln(os.Stderr, result.Error)
				}
				return result.Code
			}
		}
	}
}
