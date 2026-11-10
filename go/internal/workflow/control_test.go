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
)

func TestControlsPreserveGatesAndRejectStaleOrPrivilegedEdits(t *testing.T) {
	c, db, id, _ := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+stageFinal()+"'")
	ctx := context.Background()
	edit := func(op string, body map[string]any) (any, error) {
		raw, _ := db.Get(id)
		body["taskRevision"] = store.TaskRevision(raw)
		return c.Control(ctx, id, op, body)
	}
	if _, err := edit("edit", map[string]any{"approvals": []any{}}); err == nil {
		t.Fatal("privileged edit accepted")
	}
	if _, err := edit("status-override", map[string]any{"value": "finished", "lane": "finished"}); err != nil {
		t.Fatal(err)
	}
	value := coordinatorTask(t, db, id)
	if value["status"] != "draft" || object(value["statusOverride"])["value"] != "finished" {
		t.Fatal("board override changed workflow")
	}
	if _, err := edit("request-changes", map[string]any{"message": "implement"}); err == nil {
		t.Fatal("unapproved implementation accepted")
	}
	if _, err := c.Control(ctx, id, "edit", map[string]any{"taskRevision": strings.Repeat("0", 64), "title": "stale"}); err == nil {
		t.Fatal("stale edit accepted")
	}
	if _, err := edit("edit", map[string]any{"title": "Updated"}); err != nil {
		t.Fatal(err)
	}
	if value = coordinatorTask(t, db, id); value["title"] != "Updated" || value["status"] != "draft" {
		t.Fatal("draft update failed")
	}
	if _, err := edit("delete", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Get(id); err == nil {
		t.Fatal("task survived deletion")
	}
}

func TestReviewCommentsBindToTheDisplayedDiff(t *testing.T) {
	c, db, id, _, _ := acceptedPublicationFixture(t)
	value := coordinatorTask(t, db, id)
	value["status"] = "awaiting_final"
	saved(t, db, value)
	diff, err := c.Diff(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"taskRevision": diff["taskRevision"], "fingerprint": diff["fingerprint"], "repositoryId": "repo", "file": "file.txt", "line": float64(1), "side": "new", "text": "Please improve this."}
	if _, err = c.Control(context.Background(), id, "review-comment", body); err != nil {
		t.Fatal(err)
	}
	if _, err = c.Control(context.Background(), id, "review-comment", body); err == nil {
		t.Fatal("stale diff accepted")
	}
	raw, _ := db.Get(id)
	body["taskRevision"] = store.TaskRevision(raw)
	body["file"] = "../secret"
	if _, err = c.Control(context.Background(), id, "review-comment", body); err == nil {
		t.Fatal("unsafe path accepted")
	}
	body["file"] = "file.txt"
	body["fingerprint"] = "old"
	if _, err = c.Control(context.Background(), id, "review-comment", body); err == nil {
		t.Fatal("mismatched diff accepted")
	}
}

func TestReviewCommentsRejectUnrecordedWorkspaceChanges(t *testing.T) {
	c, db, id, _, _ := acceptedPublicationFixture(t)
	value := coordinatorTask(t, db, id)
	value["status"] = "awaiting_final"
	saved(t, db, value)
	diff, err := c.Diff(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(text(value["workspaceRoot"]), "file.txt"), []byte("not reviewed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"taskRevision": diff["taskRevision"], "fingerprint": diff["fingerprint"], "repositoryId": "repo", "file": "file.txt", "line": float64(1), "side": "new", "text": "Stale"}
	if _, err := c.Control(context.Background(), id, "review-comment", body); err == nil {
		t.Fatal("comment bound to stale workspace")
	}
	if len(array(coordinatorTask(t, db, id)["reviewComments"])) != 0 {
		t.Fatal("stale comment persisted")
	}
}

func TestEditedRequirementsRevokeApprovalAndAuto(t *testing.T) {
	c, db, id, _, _ := acceptedPublicationFixture(t)
	if err := db.SetMeta("automation:"+id, `{"enabled":true}`); err != nil {
		t.Fatal(err)
	}
	body := revisionBody(t, db, id)
	body["description"] = "A different requirement that needs a new plan"
	if _, err := c.Control(context.Background(), id, "edit", body); err != nil {
		t.Fatal(err)
	}
	value := coordinatorTask(t, db, id)
	if value["status"] != "paused" || value["stage"] != "plan" || value["chosenApproach"] != nil || value["verifiedFingerprint"] != nil || value["reviewedFingerprint"] != nil {
		t.Fatal("changed requirements retained accepted authority")
	}
	raw, exists, err := db.GetMeta("automation:" + id)
	var delegation map[string]any
	json.Unmarshal([]byte(raw), &delegation)
	if err != nil || !exists || delegation["enabled"] != false {
		t.Fatal("Auto remained authorized")
	}
}

func TestPartialWorkspacePreparationFreezesRepositoryScope(t *testing.T) {
	c, db, id, _, _ := acceptedPublicationFixture(t)
	value := coordinatorTask(t, db, id)
	value["status"] = "blocked"
	delete(value, "workspaceRoot")
	value["workspaceDraft"] = map[string]any{"root": "retained"}
	saved(t, db, value)
	body := revisionBody(t, db, id)
	body["repositoryIds"] = []any{"repo"}
	if _, err := c.Control(context.Background(), id, "edit", body); err == nil {
		t.Fatal("partial workspace scope changed")
	}
}

func TestWorkloadSeparatesMonitoringFromTaskAgents(t *testing.T) {
	c := &Coordinator{jobs: map[string]*coordinatorJob{"task": {}, "pr": {kind: "monitor"}}}
	if running, monitoring := c.Workload(); running != 1 || monitoring != 1 || c.Running() != 2 {
		t.Fatalf("incorrect workload: %d %d", running, monitoring)
	}
}
