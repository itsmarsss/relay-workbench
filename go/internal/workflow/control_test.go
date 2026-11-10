//go:build darwin || linux

package workflow

import (
	"context"
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
