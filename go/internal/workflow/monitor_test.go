//go:build darwin || linux

package workflow

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
	"strings"
	"testing"
)

func monitorHandoff(url string, feedback []any) string {
	var event map[string]any
	_ = json.Unmarshal([]byte(publicationHandoff("complete")), &event)
	item := object(event["item"])
	var value map[string]any
	_ = json.Unmarshal([]byte(text(item["text"])), &value)
	object(value["publication"])["url"] = url
	value["feedback"] = feedback
	raw, _ := json.Marshal(value)
	item["text"] = string(raw)
	raw, _ = json.Marshal(event)
	return string(raw)
}
func monitorFixture(t *testing.T) (*Coordinator, *store.Store, string, string) {
	t.Helper()
	c, db, id, _, program := acceptedPublicationFixture(t)
	value := coordinatorTask(t, db, id)
	var event map[string]any
	_ = json.Unmarshal([]byte(publicationHandoff("complete")), &event)
	var handoff map[string]any
	_ = json.Unmarshal([]byte(text(object(event["item"])["text"])), &handoff)
	value["publication"] = handoff["publication"]
	saved(t, db, value)
	return c, db, id, program
}
func TestMonitorUsesFallbackAndKeepsPollsOutOfRunHistory(t *testing.T) {
	c, db, id, program := monitorFixture(t)
	value := coordinatorTask(t, db, id)
	object(value["routing"])["investigate"] = "claude"
	saved(t, db, value)
	before := len(array(value["attempts"]))
	if err := os.WriteFile(program, []byte("#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '"+monitorHandoff("https://code.example/team/repo/pull/7", []any{})+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		raw, _ := db.Get(id)
		if _, err := c.Monitor(context.Background(), id, store.TaskRevision(raw), "repo"); err != nil {
			t.Fatal(err)
		}
		waitCoordinator(t, c, id)
	}
	value = coordinatorTask(t, db, id)
	if object(value["publicationMonitor"])["status"] != "complete" || len(array(value["attempts"])) != before || len(array(value["deliveryRuns"])) != 0 {
		t.Fatalf("monitor state: %#v", value)
	}
	if value["status"] != "completed" {
		t.Fatal("poll changed workflow state")
	}
}
func TestMonitorRejectsDifferentPullRequestAndSourceEdits(t *testing.T) {
	for _, kind := range []string{"different_pr", "source_edit", "incomplete"} {
		t.Run(kind, func(t *testing.T) {
			c, db, id, program := monitorFixture(t)
			url := "https://code.example/team/repo/pull/7"
			action := ""
			if kind == "different_pr" {
				url = "https://code.example/team/repo/pull/8"
			}
			if kind == "source_edit" {
				action = "printf changed > file.txt\n"
			}
			output := monitorHandoff(url, []any{})
			if kind == "incomplete" {
				output = "not a handoff"
			}
			if err := os.WriteFile(program, []byte("#!/bin/sh\ncat >/dev/null\n"+action+"printf '%s\\n' '"+output+"'\n"), 0700); err != nil {
				t.Fatal(err)
			}
			raw, _ := db.Get(id)
			if _, err := c.Monitor(context.Background(), id, store.TaskRevision(raw), "repo"); err != nil {
				t.Fatal(err)
			}
			waitCoordinator(t, c, id)
			value := coordinatorTask(t, db, id)
			if object(value["publicationMonitor"])["status"] != "blocked" || object(value["publication"])["url"] != "https://code.example/team/repo/pull/7" {
				t.Fatalf("invalid observation accepted: %#v", value)
			}
			if kind == "source_edit" {
				data, _ := os.ReadFile(filepath.Join(text(value["workspaceRoot"]), "file.txt"))
				if string(data) != "changed" {
					t.Fatal("unexpected edits were discarded")
				}
			}
		})
	}
}
func TestRemoteFeedbackRequiresLivePermissionAndDeduplicatesRevision(t *testing.T) {
	c, db, id, _ := monitorFixture(t)
	value := coordinatorTask(t, db, id)
	value["feedbackAutomation"] = map[string]any{"enabled": true}
	saved(t, db, value)
	key := feedbackKey("review-comment-1", "revision-1")
	receipt := &feedbackReceipt{repositoryID: "repo", keys: []string{key}}
	apply := func() error {
		raw, _ := db.Get(id)
		_, err := c.control(context.Background(), id, "request-changes", map[string]any{"taskRevision": store.TaskRevision(raw), "message": "Address recorded feedback"}, receipt)
		return err
	}
	value["feedbackAutomation"] = map[string]any{"enabled": false}
	saved(t, db, value)
	if err := apply(); err == nil {
		t.Fatal("revoked feedback permission accepted")
	}
	value["feedbackAutomation"] = map[string]any{"enabled": true}
	saved(t, db, value)
	if err := apply(); err != nil {
		t.Fatal(err)
	}
	value = coordinatorTask(t, db, id)
	if object(value["feedbackHandled"])[key] != true || value["status"] != "paused" || value["stage"] != "implement" || value["reviewedFingerprint"] != nil {
		t.Fatal("feedback did not invalidate review")
	}
	if err := apply(); err == nil || !strings.Contains(err.Error(), "already handled") {
		t.Fatalf("duplicate receipt: %v", err)
	}
	next := feedbackKey("review-comment-1", "revision-2")
	if key == next {
		t.Fatal("feedback revisions collide")
	}
	config, _ := (task.ConfigurationService{Store: db}).Read()
	if config.Value == nil {
		t.Fatal("config unavailable")
	}
}

func TestMonitorWatchesALinkedPullRequestWithoutActingOnIt(t *testing.T) {
	c, db, id, _, program := acceptedPublicationFixture(t)
	value := coordinatorTask(t, db, id)
	// Finished by hand: blocked in Relay, never accepted, with the pull request linked.
	value["status"], value["stage"], value["approvals"], value["verifiedFingerprint"], value["reviewedFingerprint"] = "blocked", "verify", []any{}, nil, nil
	link := map[string]any{"url": "https://code.example/team/repo/pull/7", "number": "7", "state": "open", "checks": "unknown", "review": "unknown", "checkedAt": "", "draft": true}
	value["pullRequestLink"] = link
	object(array(value["repositories"])[0])["pullRequestLink"] = link
	saved(t, db, value)
	body := revisionBody(t, db, id)
	body["repositoryId"], body["enabled"] = "repo", true
	if _, err := c.Control(context.Background(), id, "feedback", body); err == nil {
		t.Fatal("feedback automation was enabled on a task Relay never accepted")
	}
	body = revisionBody(t, db, id)
	body["repositoryId"], body["enabled"] = "repo", true
	if _, err := c.Control(context.Background(), id, "publication", body); err != nil {
		t.Fatal("watching a linked pull request refused:", err)
	}
	feedback := []any{map[string]any{"id": "c1", "revision": "r1", "kind": "repair", "summary": "Fix it", "details": "Please"}}
	if err := os.WriteFile(program, []byte("#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '"+monitorHandoff("https://code.example/team/repo/pull/7", feedback)+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ := db.Get(id)
	if _, err := c.Monitor(context.Background(), id, store.TaskRevision(raw), "repo"); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value = coordinatorTask(t, db, id)
	monitor := object(value["publicationMonitor"])
	if monitor["status"] != "complete" || monitor["enabled"] != true {
		t.Fatalf("linked pull request not observed: %#v", monitor)
	}
	observed := object(value["pullRequestLink"])
	if text(observed["url"]) != "https://code.example/team/repo/pull/7" || text(observed["checkedAt"]) == "" || text(observed["state"]) == "" {
		t.Fatalf("observation not recorded on the link: %#v", observed)
	}
	if value["publication"] != nil || value["status"] != "blocked" || len(array(value["approvals"])) != 0 {
		t.Fatalf("watching changed the task's gates: publication=%v status=%v", value["publication"], value["status"])
	}
	if value["feedbackHandled"] != nil || len(array(value["messages"])) != len(array(coordinatorTask(t, db, id)["messages"])) {
		t.Fatal("feedback was acted on")
	}
	// A different pull request in the agent's answer is refused, as for a published one.
	if err := os.WriteFile(program, []byte("#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '"+monitorHandoff("https://code.example/team/repo/pull/8", []any{})+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ = db.Get(id)
	if _, err := c.Monitor(context.Background(), id, store.TaskRevision(raw), "repo"); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	if monitor = object(coordinatorTask(t, db, id)["publicationMonitor"]); monitor["status"] != "blocked" {
		t.Fatalf("a different pull request was accepted: %#v", monitor)
	}
}
