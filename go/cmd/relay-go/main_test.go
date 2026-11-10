package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"relay.local/relay/internal/process"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/verification"
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

func TestBuiltBinaryRunsSupervisedCheckHelper(t *testing.T) {
	if testing.Short() || (runtime.GOOS != "darwin" && runtime.GOOS != "linux") {
		t.Skip("builds the Unix verification helper")
	}
	binary := filepath.Join(t.TempDir(), "relay-go")
	builder := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", binary, ".")
	if output, err := builder.CombinedOutput(); err != nil {
		t.Fatalf("build: %s: %v", output, err)
	}
	root := t.TempDir()
	runner, err := verification.StartRunner(context.Background(), verification.RunnerOptions{WorkerExecutable: binary, WorkerArgs: []string{"--internal-worker"}, Repositories: []verification.Repository{{ID: "repo", Root: root}}, SourceFingerprint: "fingerprint", Timeout: 10 * time.Second, OnEvent: func(context.Context, map[string]any) error { return nil }})
	if err != nil {
		t.Fatal(err)
	}
	defer runner.Close()
	command := exec.Command(binary, "--internal-check", "--socket", runner.Socket(), "--token", runner.Token(), "--repository", "repo", "--cwd", root, "--", "/bin/echo", "literal argument")
	output, err := command.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "literal argument") {
		t.Fatalf("helper failed: %s %v", output, err)
	}
	records := runner.Records()
	if len(records) != 1 || records[0].Status != "complete" || records[0].Code == nil || *records[0].Code != 0 {
		t.Fatalf("missing supervised result: %#v", records)
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
	result, err := process.Run(context.Background(), process.Options{WorkerExecutable: binary, WorkerArgs: []string{"--internal-worker"}, Command: node, Args: []string{"-e", `console.log('worker ok')`}, Directory: t.TempDir(), Timeout: 20 * time.Second, MaxOutputBytes: 4096})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || strings.TrimSpace(result.Stdout) != "worker ok" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestStateTransferCLIRefusesLiveAndExistingDestinations(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source")
	db, err := store.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	config := task.ConfigurationService{Store: db}
	created, err := config.CreateTask(map[string]any{"title": "CLI transfer", "demo": true})
	if err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "state.tar.gz")
	if err := run([]string{"--data-dir", source, "--export-state", archive}); err == nil {
		t.Fatal("live state exported through CLI")
	}
	if _, err := os.Stat(archive); !os.IsNotExist(err) {
		t.Fatal("failed export retained output")
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--data-dir", source, "--export-state", archive}); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "new-state")
	if err := run([]string{"--data-dir", destination, "--import-state", archive}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--data-dir", destination, "--import-state", archive}); err == nil {
		t.Fatal("existing destination overwritten")
	}
	restored, err := store.Open(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	raw, err := restored.Get(created["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	if value["status"] != "imported" {
		t.Fatal("CLI import retained executable task")
	}
}
