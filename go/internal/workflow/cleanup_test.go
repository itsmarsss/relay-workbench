//go:build darwin || linux

package workflow

import (
	"context"
	"os"
	"path/filepath"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/workspace"
	"strings"
	"testing"
)

func TestCleanupRequiresPublicationAndPreservesDirtyWork(t *testing.T) {
	c, db, id, source, _ := acceptedPublicationFixture(t)
	value := coordinatorTask(t, db, id)
	root := text(value["workspaceRoot"])
	body := revisionBody(t, db, id)
	body["includeIgnored"] = false
	if _, err := c.Cleanup(context.Background(), id, body); err == nil {
		t.Fatal("unpublished task cleaned")
	}
	updateWorkspace(value, "repo", func(entry map[string]any) {
		entry["publication"] = map[string]any{"url": "https://code.example/team/repo/pull/7"}
	})
	saved(t, db, value)
	body = revisionBody(t, db, id)
	body["includeIgnored"] = false
	if _, err := c.Cleanup(context.Background(), id, body); err == nil {
		t.Fatal("dirty task cleaned")
	}
	gitFixture(t, root, "add", "-A")
	gitFixture(t, root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "publish")
	runner := workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}
	head, err := runner.RunGit(context.Background(), root, []string{"rev-parse", "HEAD"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	value = coordinatorTask(t, db, id)
	updateWorkspace(value, "repo", func(entry map[string]any) { entry["workspaceHead"] = strings.TrimSpace(head) })
	saved(t, db, value)
	body = revisionBody(t, db, id)
	body["includeIgnored"] = false
	if _, err := c.Cleanup(context.Background(), id, body); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("worktree retained")
	}
	value = coordinatorTask(t, db, id)
	if value["workspaceRoot"] != nil || object(value["workspaceCleanup"])["status"] != "removed" {
		t.Fatal("cleanup state missing")
	}
	if data, err := os.ReadFile(filepath.Join(source, "file.txt")); err != nil || string(data) != "local changes\n" {
		t.Fatal("source changed")
	}
	history, err := c.History(id)
	if err != nil || len(history["checkpoints"].([]map[string]any)) == 0 {
		t.Fatal("history lost")
	}
	body = revisionBody(t, db, id)
	body["includeIgnored"] = false
	if _, err := c.Cleanup(context.Background(), id, body); err != nil {
		t.Fatal("repeat cleanup failed", err)
	}
}

func TestAttachedProfileUsesCleanSourceAndPreservesDirtyRefusal(t *testing.T) {
	c, db, id, source := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+stageFinal()+"'")
	value := coordinatorTask(t, db, id)
	object(value["repository"])["strategy"] = "attach"
	for _, entry := range array(value["repositories"]) {
		object(object(entry)["repository"])["strategy"] = "attach"
	}
	saved(t, db, value)
	if _, err := c.Start(id); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value = coordinatorTask(t, db, id)
	if value["status"] != "blocked" || value["workspaceRoot"] != nil {
		t.Fatal("dirty source attached")
	}
	gitFixture(t, source, "add", "-A")
	gitFixture(t, source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "preserve")
	if _, err := c.Resume(id); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value = coordinatorTask(t, db, id)
	expected, _ := filepath.EvalSymlinks(source)
	if value["status"] != "awaiting_plan" || value["workspaceRoot"] != expected {
		t.Fatalf("attach failed: %#v", value)
	}
}

// A task whose pull request merged is cleaned up even though its record was left paused, and a
// managed checkout is removed by the profile's own cleanupCommand after Relay checks it is clean.
func TestMergedTaskCleansManagedCheckoutWithItsCommand(t *testing.T) {
	c, db, id, _, _ := acceptedPublicationFixture(t)
	tree := filepath.Join(t.TempDir(), "relay-"+id, "src")
	if err := os.MkdirAll(tree, 0o755); err != nil {
		t.Fatal(err)
	}
	gitFixture(t, tree, "init", "-q")
	if err := os.WriteFile(filepath.Join(tree, "file.txt"), []byte("work\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitFixture(t, tree, "add", "-A")
	gitFixture(t, tree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "work")
	value := coordinatorTask(t, db, id)
	value["status"] = "paused"
	updateWorkspace(value, "repo", func(entry map[string]any) {
		object(entry["repository"])["strategy"] = "managed"
		entry["workspaceRoot"], entry["workspace"] = tree, tree
		entry["pullRequestLink"] = map[string]any{"url": "https://code.example/team/repo/pull/9", "state": "merged"}
	})
	saved(t, db, value)
	cleanup := func() error {
		body := revisionBody(t, db, id)
		body["includeIgnored"] = true
		_, err := c.Cleanup(context.Background(), id, body)
		return err
	}
	// Without a cleanupCommand Relay says what to add instead of failing obscurely.
	if err := cleanup(); err == nil || !strings.Contains(err.Error(), "cleanupCommand") {
		t.Fatalf("missing command: %v", err)
	}
	config, err := (task.ConfigurationService{Store: db}).Read()
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range array(config.Value["repositories"]) {
		object(item)["cleanupCommand"] = map[string]any{"command": "/bin/rm", "args": []any{"-rf", "{workspacePath}"}}
	}
	if _, err = (task.ConfigurationService{Store: db}).Replace(config.Revision, config.Value); err != nil {
		t.Fatal(err)
	}
	// Local changes still block it.
	if err := os.WriteFile(filepath.Join(tree, "file.txt"), []byte("unsaved\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := cleanup(); err == nil || !strings.Contains(err.Error(), "local changes") {
		t.Fatalf("dirty checkout: %v", err)
	}
	gitFixture(t, tree, "checkout", "--", "file.txt")
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tree); !os.IsNotExist(err) {
		t.Fatal("managed checkout retained")
	}
	if value = coordinatorTask(t, db, id); object(value["workspaceCleanup"])["status"] != "removed" || value["workspaceRoot"] != nil {
		t.Fatalf("cleanup not recorded: %#v", value["workspaceCleanup"])
	}
}
