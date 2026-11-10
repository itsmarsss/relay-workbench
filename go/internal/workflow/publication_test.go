//go:build darwin || linux

package workflow

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/workspace"
)

func publicationHandoff(verdict string) string {
	result := map[string]any{"summary": "Draft pull request ready", "details": "Provider response observed", "files": []any{}, "evidence": []any{"Provider returned the pull request"}, "risks": []any{}, "options": []any{}, "findings": []any{}, "verdict": verdict, "publication": map[string]any{"url": "https://code.example/team/repo/pull/7", "number": "7", "title": "Change", "state": "open", "draft": true, "checks": "pending", "review": "required"}, "preparation": nil}
	raw, _ := json.Marshal(result)
	line, _ := json.Marshal(map[string]any{"type": "item.completed", "item": map[string]any{"type": "agent_message", "text": string(raw)}})
	return string(line)
}

func TestPublicationHistoryDoesNotNestPreviousRuns(t *testing.T) {
	previous := map[string]any{"id": "last", "content": "hash", "originalHead": "head", "summary": "Previous", "previous": map[string]any{"previous": map[string]any{"large": "history"}}}
	compact := publicationPrevious(previous)
	if compact["id"] != "last" || compact["content"] != "hash" || compact["previous"] != nil {
		t.Fatalf("publication history recursively nested: %#v", compact)
	}
}

func acceptedPublicationFixture(t *testing.T) (*Coordinator, *store.Store, string, string, string) {
	t.Helper()
	c, db, id, source := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+stageFinal()+"'")
	if _, err := c.Start(id); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value := coordinatorTask(t, db, id)
	root := text(value["workspaceRoot"])
	if root == "" || value["status"] != "awaiting_plan" {
		t.Fatalf("workspace not prepared: %#v", value)
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("approved change\n"), 0600); err != nil {
		t.Fatal(err)
	}
	inspector := workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}
	snapshot, err := inspector.Snapshot(context.Background(), []workspace.Workspace{{RepositoryID: "repo", Root: root}})
	if err != nil {
		t.Fatal(err)
	}
	value["status"], value["stage"] = "completed", "review"
	value["chosenApproach"] = map[string]any{"id": "a"}
	value["verifiedFingerprint"], value["reviewedFingerprint"] = snapshot.Combined, snapshot.Combined
	value["approvals"] = []any{map[string]any{"type": "approach", "option": map[string]any{"id": "a"}}, map[string]any{"type": "final", "fingerprint": snapshot.Combined}}
	if err = updateWorkspace(value, "repo", func(entry map[string]any) { entry["acceptedFingerprint"] = snapshot.Repositories["repo"] }); err != nil {
		t.Fatal(err)
	}
	saved(t, db, value)
	config, err := (task.ConfigurationService{Store: db}).Read()
	if err != nil {
		t.Fatal(err)
	}
	program := text(object(object(config.Value["harnesses"])["codex"])["command"])
	return c, db, id, source, program
}

func TestPublicationAgentCommitsAcceptedContentWithoutChangingSource(t *testing.T) {
	c, db, id, source, program := acceptedPublicationFixture(t)
	script := "#!/bin/sh\ncat >/dev/null\ngit add -A\ngit -c user.name=Fixture -c user.email=fixture@example.invalid commit -q -m 'test: publish'\nprintf '%s\\n' '" + publicationHandoff("complete") + "'\n"
	if err := os.WriteFile(program, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ := db.Get(id)
	if _, err := c.Publish(context.Background(), id, strings.Repeat("0", 64), "repo"); err == nil {
		t.Fatal("stale publication request accepted")
	}
	if _, err := c.Publish(context.Background(), id, store.TaskRevision(raw), "repo"); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value := coordinatorTask(t, db, id)
	delivery, observed := object(value["delivery"]), object(value["publication"])
	if value["status"] != "completed" || delivery["status"] != "complete" || observed["url"] != "https://code.example/team/repo/pull/7" || len(array(value["deliveryRuns"])) == 0 {
		t.Fatalf("publication result missing: %#v", value)
	}
	if data, err := os.ReadFile(filepath.Join(source, "file.txt")); err != nil || string(data) != "local changes\n" {
		t.Fatal("source checkout changed")
	}
}

func TestPublicationDoesNotStartWhenAcceptedWorkspaceChanged(t *testing.T) {
	c, db, id, _, program := acceptedPublicationFixture(t)
	marker := filepath.Join(t.TempDir(), "started")
	c.env["RELAY_PUBLICATION_MARKER"] = marker
	if err := os.WriteFile(program, []byte("#!/bin/sh\ntouch \"$RELAY_PUBLICATION_MARKER\"\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	value := coordinatorTask(t, db, id)
	if err := os.WriteFile(filepath.Join(text(value["workspaceRoot"]), "file.txt"), []byte("not approved\n"), 0600); err != nil {
		t.Fatal(err)
	}
	raw, _ := db.Get(id)
	if _, err := c.Publish(context.Background(), id, store.TaskRevision(raw), "repo"); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value = coordinatorTask(t, db, id)
	if object(value["delivery"])["status"] != "blocked" || !strings.Contains(text(object(value["delivery"])["summary"]), "changed since") {
		t.Fatalf("stale content was not blocked: %#v", value)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("publication agent ran on unapproved changes")
	}
}

func TestRoutinePublicationRevalidationKeepsHumanApprovalHonest(t *testing.T) {
	c, db, id, _, _ := acceptedPublicationFixture(t)
	value := coordinatorTask(t, db, id)
	root, base := text(value["workspaceRoot"]), text(value["baseCommit"])
	inspector := workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}
	content, err := inspector.AcceptedContent(context.Background(), root, base)
	if err != nil {
		t.Fatal(err)
	}
	prepared := &publicationPrepared{AttemptID: "prepared", RepositoryID: "repo", BaseCommit: base, Content: content, SameContent: true}
	value["status"] = "awaiting_final"
	value["publicationRecovery"] = map[string]any{"active": true, "attemptId": "prepared", "repositoryId": "repo", "baseCommit": base, "content": content, "sameContent": true}
	saved(t, db, value)
	if err = c.acceptRoutinePublication(context.Background(), id, prepared, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	value = coordinatorTask(t, db, id)
	finals, revalidations := 0, 0
	for _, item := range array(value["approvals"]) {
		approval := object(item)
		if approval["type"] == "final" {
			finals++
		}
		if approval["type"] == "publication_revalidation" && approval["source"] == "relay" {
			revalidations++
		}
	}
	if value["status"] != "completed" || finals != 1 || revalidations != 1 {
		t.Fatalf("revalidation misrepresented approval: %#v", value)
	}
	value["status"] = "awaiting_final"
	value["publicationRecovery"] = map[string]any{"active": true, "attemptId": "prepared", "repositoryId": "repo", "baseCommit": base, "content": content, "sameContent": true}
	saved(t, db, value)
	if err = os.WriteFile(filepath.Join(root, "file.txt"), []byte("changed after acceptance\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = c.acceptRoutinePublication(context.Background(), id, prepared, func() error { return nil }); err == nil {
		t.Fatal("changed accepted content was auto-approved")
	}
	if value = coordinatorTask(t, db, id); value["status"] != "awaiting_final" {
		t.Fatal("failed revalidation changed task status")
	}
}
