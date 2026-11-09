package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"relay.local/relay/internal/process"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestStartupErrorsReleaseExperimentalLock(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	web := t.TempDir()
	if err := run([]string{"--data-dir", dir, "--web-dir", web, "--port", "0"}); err == nil {
		t.Fatal("invalid port accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "server.lock")); !os.IsNotExist(err) {
		t.Fatalf("lock left behind: %v", err)
	}
	if err := run([]string{"--data-dir", dir, "--web-dir", filepath.Join(web, "missing")}); err == nil {
		t.Fatal("missing web directory accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "server.lock")); !os.IsNotExist(err) {
		t.Fatalf("lock left behind: %v", err)
	}
}
func TestRequiresExplicitIsolatedPaths(t *testing.T) {
	if err := run(nil); err == nil {
		t.Fatal("missing paths accepted")
	}
	if err := run([]string{"unexpected"}); err == nil {
		t.Fatal("unexpected positional arguments accepted")
	}
}

func TestBuiltBinarySupervisesCommand(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the experimental binary")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for process fixture")
	}
	binary := filepath.Join(t.TempDir(), "relay-go")
	builder := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", binary, ".")
	if output, err := builder.CombinedOutput(); err != nil {
		t.Fatalf("build: %s: %v", output, err)
	}
	result, err := process.Run(context.Background(), process.Options{WorkerExecutable: binary, WorkerArgs: []string{"--internal-worker"}, Command: node, Args: []string{"-e", `console.log('worker ok')`}, Directory: t.TempDir(), Timeout: 5 * time.Second, MaxOutputBytes: 4096})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || strings.TrimSpace(result.Stdout) != "worker ok" {
		t.Fatalf("unexpected result: %#v", result)
	}
}
