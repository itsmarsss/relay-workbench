//go:build darwin || linux

package workflow

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"relay.local/relay/internal/store"
)

func revisionBody(t *testing.T, db *store.Store, id string) map[string]any {
	t.Helper()
	raw, err := db.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{"taskRevision": store.TaskRevision(raw)}
}

func TestCheckpointContinuationPreservesIndexAndDirtySource(t *testing.T) {
	c, db, id, source := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+stageFinal()+"'")
	if _, err := c.Start(id); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value := coordinatorTask(t, db, id)
	root := text(value["workspaceRoot"])
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("staged\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitFixture(t, root, "add", "file.txt")
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("unstaged\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "new.txt"), []byte("untracked\n"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := c.update(id, func(value map[string]any) error {
		attempts := array(value["attempts"])
		object(attempts[len(attempts)-1])["id"] = "dirty-checkpoint"
		delete(object(attempts[len(attempts)-1]), "afterFingerprint")
		return nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = c.captureCheckpoint(context.Background(), id, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	rows, err := c.checkpointRecords(id)
	if err != nil || len(rows) != 3 {
		t.Fatalf("checkpoints: %d %v", len(rows), err)
	}
	if err = c.captureCheckpoint(context.Background(), id, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	// Later changes must survive both capture and restoration.
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("later edits\n"), 0600); err != nil {
		t.Fatal(err)
	}
	body := revisionBody(t, db, id)
	body["checkpointId"], body["stage"] = rows[2].ID, "approach"
	fork, err := c.ForkCheckpoint(context.Background(), id, body)
	if err != nil {
		t.Fatal(err)
	}
	forkID := text(object(fork)["id"])
	waitCoordinator(t, c, forkID)
	continued := coordinatorTask(t, db, forkID)
	newRoot := text(continued["workspaceRoot"])
	if object(continued["checkpointRestore"])["status"] != "complete" || continued["status"] != "awaiting_plan" || newRoot == root {
		t.Fatalf("continuation failed: %#v", continued)
	}
	if continued["chosenApproach"] != nil || continued["verifiedFingerprint"] != nil || continued["reviewedFingerprint"] != nil || continued["automation"] != nil {
		t.Fatal("stale approval or verification inherited")
	}
	for path, expected := range map[string]string{filepath.Join(newRoot, "file.txt"): "unstaged\n", filepath.Join(newRoot, "new.txt"): "untracked\n", filepath.Join(root, "file.txt"): "later edits\n", filepath.Join(source, "file.txt"): "local changes\n"} {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != expected {
			t.Fatalf("%s: %q %v", path, got, err)
		}
	}
	cmd := exec.Command("git", "-C", newRoot, "show", ":file.txt")
	got, err := cmd.Output()
	if err != nil || string(got) != "staged\n" {
		t.Fatalf("index lost: %q %v", got, err)
	}
	if _, err = c.Resume(forkID); err == nil {
		t.Fatal("approach gate bypassed by resume")
	}
	if _, err = c.ForkCheckpoint(context.Background(), id, body); err != nil {
		t.Fatal(err)
	}
}

func TestCheckpointRejectsStaleAndInvalidContinuations(t *testing.T) {
	c, db, id, _ := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+stageFinal()+"'")
	if _, err := c.Start(id); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	rows, err := c.checkpointRecords(id)
	if err != nil || len(rows) != 2 {
		t.Fatalf("checkpoints missing: %v", err)
	}
	body := revisionBody(t, db, id)
	body["checkpointId"], body["stage"] = rows[1].ID, "implement"
	if _, err = c.ForkCheckpoint(context.Background(), id, body); err == nil {
		t.Fatal("unapproved implementation allowed")
	}
	body["stage"] = "decision"
	if _, err = c.ForkCheckpoint(context.Background(), id, body); err == nil {
		t.Fatal("nonexistent debugger decision allowed")
	}
	body["stage"], body["taskRevision"] = "saved", "stale"
	if _, err = c.ForkCheckpoint(context.Background(), id, body); err == nil {
		t.Fatal("stale continuation allowed")
	}
}

func TestAutomationDelegationIsAtomicAndRevocable(t *testing.T) {
	c, db, id, _ := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+stageFinal()+"'")
	body := revisionBody(t, db, id)
	body["enabled"], body["scope"] = true, "reviewed"
	if _, err := c.setAutomation(id, body); err != nil {
		t.Fatal(err)
	}
	if _, err := c.setAutomation(id, body); err == nil {
		t.Fatal("stale authorization accepted")
	}
	body = revisionBody(t, db, id)
	body["enabled"], body["scope"] = false, "reviewed"
	if _, err := c.setAutomation(id, body); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Start(id); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	if coordinatorTask(t, db, id)["status"] != "awaiting_plan" {
		t.Fatal("revoked Auto implemented changes")
	}
	raw, _, err := db.GetMeta("automation:" + id)
	var state map[string]any
	if err != nil || json.Unmarshal([]byte(raw), &state) != nil || state["enabled"] != false {
		t.Fatal("revocation not persisted")
	}
	// Historical checkpoints do not confer authority to a new task.
	rows, _ := c.checkpointRecords(id)
	body = revisionBody(t, db, id)
	body["checkpointId"], body["stage"] = rows[1].ID, "approach"
	fork, err := c.ForkCheckpoint(context.Background(), id, body)
	if err != nil {
		t.Fatal(err)
	}
	forkID := text(object(fork)["id"])
	waitCoordinator(t, c, forkID)
	if _, exists, _ := db.GetMeta("automation:" + forkID); exists {
		t.Fatal("fork inherited delegation")
	}
}
