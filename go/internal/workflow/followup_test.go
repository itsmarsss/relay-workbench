//go:build darwin || linux

package workflow

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"relay.local/relay/internal/store"
	"strings"
	"testing"
	"time"
)

func followupFinal(action string) string {
	var event map[string]any
	_ = json.Unmarshal([]byte(stageFinal()), &event)
	var handoff map[string]any
	_ = json.Unmarshal([]byte(text(object(event["item"])["text"])), &handoff)
	handoff["followUpAction"] = action
	raw, _ := json.Marshal(handoff)
	object(event["item"])["text"] = string(raw)
	raw, _ = json.Marshal(event)
	return string(raw)
}
func TestFollowupAnswersWithoutRestartingAcceptedWorkflow(t *testing.T) {
	c, db, id, _, program := acceptedPublicationFixture(t)
	if err := os.WriteFile(program, []byte("#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '"+followupFinal("complete")+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	before := coordinatorTask(t, db, id)
	raw, _ := db.Get(id)
	if _, err := c.Followup(context.Background(), id, map[string]any{"taskRevision": store.TaskRevision(raw), "message": "Explain this change", "provider": "codex"}); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value := coordinatorTask(t, db, id)
	run := object(array(value["deliveryRuns"])[0])
	if run["status"] != "complete" || value["status"] != "completed" || len(array(value["attempts"])) != len(array(before["attempts"])) || value["reviewedFingerprint"] != before["reviewedFingerprint"] {
		t.Fatalf("question restarted workflow: %#v", value)
	}
}
func TestFollowupChangesResumeImplementationAndRequireNewReview(t *testing.T) {
	c, db, id, _, program := acceptedPublicationFixture(t)
	script := "#!/bin/sh\ninput=$(cat)\ncase \"$input\" in *'You are the follow-up working agent'*) printf '%s\\n' '" + followupFinal("changes") + "';; *) printf '%s\\n' '" + stageFinal() + "';; esac\n"
	if err := os.WriteFile(program, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ := db.Get(id)
	if _, err := c.Followup(context.Background(), id, map[string]any{"taskRevision": store.TaskRevision(raw), "message": "Improve the changed behavior", "provider": "codex"}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	var value map[string]any
	for time.Now().Before(deadline) {
		value = coordinatorTask(t, db, id)
		if len(array(value["messages"])) > 0 && value["status"] != "completed" && c.Running() == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if value["status"] == "completed" || value["reviewedFingerprint"] != nil || value["verifiedFingerprint"] != nil {
		t.Fatalf("new work retained acceptance: %#v", value)
	}
	if !strings.Contains(text(object(array(value["messages"])[0])["text"]), "Improve the changed behavior") {
		t.Fatal("request was lost")
	}
}
func TestFollowupPreservesUnexpectedEditsAndInvalidatesAcceptance(t *testing.T) {
	c, db, id, _, program := acceptedPublicationFixture(t)
	if err := os.WriteFile(program, []byte("#!/bin/sh\ncat >/dev/null\nprintf unexpected > file.txt\nprintf '%s\\n' '"+followupFinal("complete")+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ := db.Get(id)
	if _, err := c.Followup(context.Background(), id, map[string]any{"taskRevision": store.TaskRevision(raw), "message": "Explain"}); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value := coordinatorTask(t, db, id)
	data, _ := os.ReadFile(filepath.Join(text(value["workspaceRoot"]), "file.txt"))
	if value["status"] != "blocked" || value["reviewedFingerprint"] != nil || string(data) != "unexpected" {
		t.Fatalf("unexpected write was accepted or discarded: %#v", value)
	}
}
func TestFollowupAfterPublicationUsesAcceptedContentAndCanResume(t *testing.T) {
	c, db, id, _, program := acceptedPublicationFixture(t)
	if err := os.WriteFile(program, []byte("#!/bin/sh\ncat >/dev/null\ngit add -A\ngit -c user.name=Fixture -c user.email=fixture@example.invalid commit -q -m 'test: publish'\nprintf '%s\\n' '"+publicationHandoff("complete")+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ := db.Get(id)
	if _, err := c.Publish(context.Background(), id, store.TaskRevision(raw), "repo"); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value := coordinatorTask(t, db, id)
	if object(value["delivery"])["status"] != "complete" {
		t.Fatal("fixture did not publish")
	}
	if err := os.WriteFile(program, []byte("#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '"+followupFinal("complete")+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ = db.Get(id)
	if _, err := c.Followup(context.Background(), id, map[string]any{"taskRevision": store.TaskRevision(raw), "message": "Explain published changes"}); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value = coordinatorTask(t, db, id)
	runs := array(value["deliveryRuns"])
	if object(runs[len(runs)-1])["status"] != "complete" {
		t.Fatalf("publication invalidated follow-up: %#v", value)
	}
	guard, err := c.storageGuard()
	if err != nil {
		t.Fatal(err)
	}
	if err = c.prepare(context.Background(), id, guard, time.Second); err != nil {
		t.Fatal("publication prevented retained-workspace validation:", err)
	}
}

func TestFollowupCancellationRetainsWorkAndRequiresVerification(t *testing.T) {
	c, db, id, _, program := acceptedPublicationFixture(t)
	marker := filepath.Join(t.TempDir(), "started")
	c.env["RELAY_FOLLOWUP_MARKER"] = marker
	if err := os.WriteFile(program, []byte("#!/bin/sh\ncat >/dev/null\nprintf partial > file.txt\ntouch \"$RELAY_FOLLOWUP_MARKER\"\nsleep 30\n"), 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ := db.Get(id)
	if _, err := c.Followup(context.Background(), id, map[string]any{"taskRevision": store.TaskRevision(raw), "message": "Explain"}); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("follow-up did not start")
	}
	if err := c.Pause(id); err != nil {
		t.Fatal(err)
	}
	value := coordinatorTask(t, db, id)
	run := object(array(value["deliveryRuns"])[0])
	data, _ := os.ReadFile(filepath.Join(text(value["workspaceRoot"]), "file.txt"))
	if run["status"] != "interrupted" || value["reviewedFingerprint"] != nil || value["status"] != "blocked" || string(data) != "partial" {
		t.Fatalf("cancellation lost work or acceptance remained: %#v", value)
	}
}
func TestInterruptedFollowupInvalidatesUncheckedSourceOnRestart(t *testing.T) {
	c, db, id, _, _ := acceptedPublicationFixture(t)
	value := coordinatorTask(t, db, id)
	value["deliveryRuns"] = []any{map[string]any{"id": "interrupted-followup", "stage": "followup", "status": "running"}}
	saved(t, db, value)
	if err := c.recoverInterrupted(); err != nil {
		t.Fatal(err)
	}
	value = coordinatorTask(t, db, id)
	if value["status"] != "blocked" || value["stage"] != "verify" || value["reviewedFingerprint"] != nil || object(array(value["deliveryRuns"])[0])["status"] != "interrupted" {
		t.Fatal("interrupted follow-up kept unchecked acceptance")
	}
}
