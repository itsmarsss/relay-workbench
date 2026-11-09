//go:build darwin || linux

package workflow

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"relay.local/relay/internal/process"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/workspace"
)

func TestAcceptanceWorker(t *testing.T) {
	if os.Getenv("RELAY_ACCEPT_WORKER") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Exit(process.Worker(os.Args[i+1:]))
		}
	}
	os.Exit(127)
}
func gitFixture(t *testing.T, root string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", root, "-c", "core.fsmonitor=false"}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.invalid", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.invalid")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git fixture: %s: %v", out, err)
	}
}
func repositoryFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	gitFixture(t, root, "init", "-q")
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitFixture(t, root, "add", "file.txt")
	gitFixture(t, root, "commit", "-q", "-m", "fixture")
	return root
}
func TestAcceptanceScansRealCrossRepositoryChanges(t *testing.T) {
	one, two := repositoryFixture(t), repositoryFixture(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	runner := workspace.Runner{WorkerExecutable: executable, WorkerArgs: []string{"-test.run=^TestAcceptanceWorker$", "--"}, Environment: map[string]string{"RELAY_ACCEPT_WORKER": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}}
	entries := []workspace.Workspace{{RepositoryID: "one", Root: one}, {RepositoryID: "two", Root: two}}
	initial, err := runner.Snapshot(context.Background(), entries)
	if err != nil {
		t.Fatal(err)
	}
	task := finalTask()
	task["verifiedFingerprint"] = initial.Combined
	task["reviewedFingerprint"] = initial.Combined
	repos := array(task["repositories"])
	object(repos[0])["workspaceRoot"] = one
	object(repos[1])["workspaceRoot"] = two
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	saved(t, db, task)
	lease, err := workspace.NewRegistry().Acquire("task", []string{one, two})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	service := Service{Store: db}
	if err = os.WriteFile(filepath.Join(two, "file.txt"), []byte("unexpected change\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = service.AcceptVerified(context.Background(), "task", Authorization{Human: true}, lease, runner); err == nil {
		t.Fatal("changed cross-repository work accepted")
	}
	if err = os.WriteFile(filepath.Join(two, "file.txt"), []byte("base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := service.AcceptVerified(context.Background(), "task", Authorization{Human: true}, lease, runner)
	if err != nil {
		t.Fatal(err)
	}
	var accepted map[string]any
	if err = json.Unmarshal(result, &accepted); err != nil {
		t.Fatal(err)
	}
	if accepted["status"] != "completed" {
		t.Fatalf("not accepted: %s", result)
	}
	got := array(accepted["repositories"])
	if object(got[0])["acceptedFingerprint"] != initial.Repositories["one"] || object(got[1])["acceptedFingerprint"] != initial.Repositories["two"] {
		t.Fatal("repository fingerprints not preserved")
	}
}
