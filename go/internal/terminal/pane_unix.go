//go:build darwin || linux

package terminal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func Pane(args []string) int {
	if len(args) != 1 {
		return 127
	}
	spec, err := readSpec(args[0])
	if err != nil {
		return 127
	}
	signals := []os.Signal{syscall.SIGTERM, syscall.SIGHUP}
	if !spec.Info.Interactive {
		signals = append(signals, os.Interrupt)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), signals...)
	defer cancel()
	child := exec.Command(spec.Command, spec.Args...)
	child.Dir = spec.Cwd
	child.Env = os.Environ()
	for key, value := range spec.Env {
		child.Env = append(child.Env, key+"="+value)
	}
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: !spec.Info.Interactive}
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	files := []*os.File{}
	if !spec.Info.Interactive {
		input, e := os.Open(filepath.Join(spec.Directory, "input"))
		if e != nil {
			return 127
		}
		files = append(files, input)
		child.Stdin = input
		out, e := os.OpenFile(filepath.Join(spec.Directory, "stdout"), os.O_WRONLY|os.O_APPEND, 0600)
		if e != nil {
			return 127
		}
		files = append(files, out)
		stderr, e := os.OpenFile(filepath.Join(spec.Directory, "stderr"), os.O_WRONLY|os.O_APPEND, 0600)
		if e != nil {
			return 127
		}
		files = append(files, stderr)
		child.Stdout = io.MultiWriter(os.Stdout, out)
		child.Stderr = io.MultiWriter(os.Stderr, stderr)
	}
	defer func() {
		for _, f := range files {
			f.Close()
		}
	}()
	result := Result{}
	if err = child.Start(); err == nil {
		done := make(chan error, 1)
		go func() { done <- child.Wait() }()
		select {
		case err = <-done:
		case <-ctx.Done():
			if spec.Info.Interactive {
				_ = child.Process.Signal(syscall.SIGTERM)
			} else {
				_ = syscall.Kill(-child.Process.Pid, syscall.SIGTERM)
			}
			select {
			case err = <-done:
			case <-time.After(time.Second):
				if spec.Info.Interactive {
					_ = child.Process.Kill()
				} else {
					_ = syscall.Kill(-child.Process.Pid, syscall.SIGKILL)
				}
				err = <-done
			}
		}
		if !spec.Info.Interactive {
			_ = syscall.Kill(-child.Process.Pid, syscall.SIGTERM)
			time.Sleep(30 * time.Millisecond)
			_ = syscall.Kill(-child.Process.Pid, syscall.SIGKILL)
		}
	}
	if err != nil {
		result.Code = 1
		result.Error = err.Error()
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() > 0 {
			result.Code = exit.ExitCode()
		}
	}
	encoded, _ := json.Marshal(result)
	temp := filepath.Join(spec.Directory, "result.tmp")
	if err = os.WriteFile(temp, encoded, 0600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err = os.Rename(temp, filepath.Join(spec.Directory, "result.json")); err != nil {
		return 1
	}
	return result.Code
}
