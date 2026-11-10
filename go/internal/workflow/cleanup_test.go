//go:build darwin || linux

package workflow

import (
	"context"
	"os"
	"path/filepath"
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
