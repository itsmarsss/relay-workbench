//go:build darwin || linux

package workspace

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestWriterProcess(t *testing.T) {
	if os.Getenv("RELAY_WRITER_TEST") != "1" {
		return
	}
	lease, err := NewWriterRegistry().Acquire("child", []string{os.Getenv("RELAY_WRITER_ROOT")})
	if err != nil {
		os.Exit(2)
	}
	defer lease.Release()
	os.Stdout.Write([]byte("ready\n"))
	io.Copy(io.Discard, os.Stdin)
}
func TestWriterLockSurvivesIndependentRegistriesAndCrash(t *testing.T) {
	root := t.TempDir()
	worker, _ := os.Executable()
	child := exec.Command(worker, "-test.run=^TestWriterProcess$")
	child.Env = append(os.Environ(), "RELAY_WRITER_TEST=1", "RELAY_WRITER_ROOT="+root)
	in, _ := child.StdinPipe()
	out, _ := child.StdoutPipe()
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { in.Close(); child.Process.Kill(); child.Wait() }()
	buf := make([]byte, 6)
	if _, err := io.ReadFull(out, buf); err != nil || string(buf) != "ready\n" {
		t.Fatalf("child not ready: %q %v", buf, err)
	}
	if _, err := NewWriterRegistry().Acquire("parent", []string{root}); !errors.Is(err, ErrWorkspaceBusy) {
		t.Fatalf("second process acquired writer: %v", err)
	}
	child.Process.Kill()
	child.Wait()
	lease, err := NewWriterRegistry().Acquire("recovered", []string{root})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	alias := filepath.Join(t.TempDir(), "alias")
	if err = os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	if _, err = NewWriterRegistry().Acquire("alias", []string{alias}); !errors.Is(err, ErrWorkspaceBusy) {
		t.Fatalf("alias acquired writer: %v", err)
	}
	lease.Release()
}
func TestWriterLockRejectsLinksAndReplacement(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(t.TempDir(), "target")
	os.WriteFile(target, nil, 0600)
	os.Symlink(target, filepath.Join(root, "relay-writer.lock"))
	if _, err := NewWriterRegistry().Acquire("task", []string{root}); err == nil {
		t.Fatal("symlink accepted")
	}
	os.Remove(filepath.Join(root, "relay-writer.lock"))
	lease, err := NewWriterRegistry().Acquire("task", []string{root})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	os.Rename(filepath.Join(root, "relay-writer.lock"), filepath.Join(root, "old-lock"))
	os.WriteFile(filepath.Join(root, "relay-writer.lock"), nil, 0600)
	if err = lease.WithHeld("task", []string{root}, func() error { t.Fatal("replaced lock used"); return nil }); err == nil {
		t.Fatal("replacement not detected")
	}
}
