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
	if _, err := edit("status-override", map[string]any{"value": "parked", "lane": "parked"}); err != nil {
		t.Fatal(err)
	}
	if value = coordinatorTask(t, db, id); value["status"] != "draft" || object(value["statusOverride"])["lane"] != "parked" {
		t.Fatal("parking changed workflow")
	}
	if _, err := edit("status-override", map[string]any{"value": "parked", "lane": "done"}); err == nil {
		t.Fatal("mismatched board column accepted")
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

func TestInvestigationCanBecomeAFullTaskAfterItFinished(t *testing.T) {
	c, db, id, _, _ := acceptedPublicationFixture(t)
	value := coordinatorTask(t, db, id)
	value["preset"], value["status"], value["stage"] = "investigate", "completed", "investigate"
	value["statusOverride"] = map[string]any{"value": "completed", "lane": "done"}
	saved(t, db, value)
	// Any other change of scope is still refused once a workspace exists.
	body := revisionBody(t, db, id)
	body["preset"], body["repositoryIds"] = "small", []any{"repo"}
	if _, err := c.Control(context.Background(), id, "edit", body); err == nil {
		t.Fatal("repository scope changed with the preset")
	}
	body = revisionBody(t, db, id)
	body["preset"] = "small"
	if _, err := c.Control(context.Background(), id, "edit", body); err != nil {
		t.Fatal(err)
	}
	value = coordinatorTask(t, db, id)
	if value["preset"] != "small" || value["status"] != "paused" || value["stage"] != "plan" || value["statusOverride"] != nil || text(value["workflowGuidance"]) == "" {
		t.Fatalf("investigation did not continue to design: %v %v %v %v", value["preset"], value["status"], value["stage"], value["statusOverride"])
	}
	// The reverse is not offered: a full task with a workspace cannot become investigation only.
	body = revisionBody(t, db, id)
	body["preset"] = "investigate"
	if _, err := c.Control(context.Background(), id, "edit", body); err == nil {
		t.Fatal("a full task was narrowed to investigation only")
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

func TestPullRequestLinksAreBoardNotesThatLeaveWorkflowGatesAlone(t *testing.T) {
	c, db, id, _ := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+stageFinal()+"'")
	ctx := context.Background()
	link := func(body map[string]any) error {
		raw, _ := db.Get(id)
		body["taskRevision"] = store.TaskRevision(raw)
		_, err := c.Control(ctx, id, "pull-request", body)
		return err
	}
	address := "https://example.test/org/repo/pull/42"
	valid := func() map[string]any {
		return map[string]any{"repositoryId": "repo", "url": address, "state": "open", "draft": true}
	}
	for name, change := range map[string]func(map[string]any){
		"unknown repository": func(body map[string]any) { body["repositoryId"] = "other" },
		"script address":     func(body map[string]any) { body["url"] = "javascript:alert(1)" },
		"credentials":        func(body map[string]any) { body["url"] = "https://user:secret@example.test/pull/1" },
		"non-text address":   func(body map[string]any) { body["url"] = 42 },
		"unknown state":      func(body map[string]any) { body["state"] = "approved" },
		"missing state":      func(body map[string]any) { delete(body, "state") },
		"merged draft":       func(body map[string]any) { body["state"] = "merged" },
		"non-boolean draft":  func(body map[string]any) { body["draft"] = "true" },
		"observed evidence":  func(body map[string]any) { body["checks"] = "passing" },
	} {
		body := valid()
		change(body)
		if err := link(body); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	if err := link(map[string]any{"repositoryId": "repo", "url": nil}); err == nil {
		t.Fatal("removed a link that was never set")
	}
	before := coordinatorTask(t, db, id)
	if before["pullRequestLink"] != nil {
		t.Fatal("a rejected link was saved")
	}
	if err := link(valid()); err != nil {
		t.Fatal(err)
	}
	value := coordinatorTask(t, db, id)
	saved := object(value["pullRequestLink"])
	if saved["url"] != address || saved["number"] != "42" || saved["state"] != "open" || saved["draft"] != true || text(saved["checkedAt"]) == "" || len(saved) != 5 {
		t.Fatalf("link %v", saved)
	}
	// The link is a note: status, approvals and Relay's own publication record are untouched.
	if value["status"] != before["status"] || value["stage"] != before["stage"] || value["publication"] != nil || len(array(value["approvals"])) != len(array(before["approvals"])) {
		t.Fatalf("link changed workflow state: %v", value)
	}
	if err := link(map[string]any{"repositoryId": "repo", "url": address, "state": "merged"}); err != nil {
		t.Fatal(err)
	}
	if saved = object(coordinatorTask(t, db, id)["pullRequestLink"]); saved["state"] != "merged" || saved["draft"] != false {
		t.Fatalf("relinked %v", saved)
	}
	if _, err := c.Control(ctx, id, "pull-request", map[string]any{"taskRevision": strings.Repeat("0", 64), "repositoryId": "repo", "url": nil}); err == nil {
		t.Fatal("stale unlink accepted")
	}
	if err := link(map[string]any{"repositoryId": "repo", "url": nil}); err != nil {
		t.Fatal(err)
	}
	if value = coordinatorTask(t, db, id); value["pullRequestLink"] != nil {
		t.Fatal("link survived removal")
	}
	// A pull request Relay published is tracked by Relay and cannot be overwritten by hand.
	value["publication"] = map[string]any{"url": "https://example.test/org/repo/pull/9", "number": "9", "state": "open"}
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Save(raw, json.RawMessage(`{"type":"activity"}`)); err != nil {
		t.Fatal(err)
	}
	if err = link(valid()); err == nil || !strings.Contains(err.Error(), "already tracks") {
		t.Fatalf("overwrote a tracked pull request: %v", err)
	}
	if value = coordinatorTask(t, db, id); value["pullRequestLink"] != nil {
		t.Fatal("link saved beside a tracked pull request")
	}
}
