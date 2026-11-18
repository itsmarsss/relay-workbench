//go:build darwin || linux

package assistant

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"relay.local/relay/internal/task"
)

type reservingActions struct {
	actions
	reserved, released int
	last               string
}

func (a *reservingActions) ReserveWorkspace(context.Context, string) (func(), error) {
	a.reserved++
	return func() { a.released++ }, nil
}
func (a *reservingActions) Control(_ context.Context, _ string, operation string, body map[string]any) (any, error) {
	a.calls++
	a.last = operation + ":" + text(body["action"])
	return map[string]any{"status": "completed"}, nil
}

func waitMessage(t *testing.T, s *Service, id string, index int) Message {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		current, _ := s.Get(id)
		if len(current.Messages) > index && current.Messages[index].Status != "running" {
			return current.Messages[index]
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("operator did not answer")
	return Message{}
}

func TestOperatorRunsWithNativeToolsAndContinuesItsSession(t *testing.T) {
	s, db, _ := fixture(t)
	a := &reservingActions{}
	s.Actions = a
	if err := db.Save(json.RawMessage(`{"id":"task-1","title":"Task","status":"completed"}`), nil); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "args")
	script := filepath.Join(t.TempDir(), "claude")
	source := "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' \"$*\" >> " + log + "\npwd >> " + log + "\n" +
		"printf '%s\\n' '" + `{"type":"system","subtype":"init","session_id":"sess-1"}` + "' '" + `{"type":"result","is_error":false,"result":"Done.","session_id":"sess-1"}` + "'\n"
	if err := os.WriteFile(script, []byte(source), 0700); err != nil {
		t.Fatal(err)
	}
	service := task.ConfigurationService{Store: db}
	config, _ := service.Read()
	obj(obj(config.Value["harnesses"])["claude"])["command"] = script
	if _, err := service.Replace(config.Revision, config.Value); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateMode("x", "", "superuser"); err == nil {
		t.Fatal("accepted an unknown mode")
	}
	chat, err := s.CreateMode("Operator", "", operatorMode)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Send(chat.ID, map[string]any{"revision": float64(chat.Revision), "question": "Rebase my branch"}); err != nil {
		t.Fatal(err)
	}
	if m := waitMessage(t, s, chat.ID, 0); m.Status != "complete" || m.Answer != "Done." {
		t.Fatalf("operator turn failed: %#v", m)
	}
	current, _ := s.Get(chat.ID)
	if current.SessionID != "sess-1" {
		t.Fatalf("session was not kept: %q", current.SessionID)
	}
	if _, err = s.Send(chat.ID, map[string]any{"revision": float64(current.Revision), "question": "And push it"}); err != nil {
		t.Fatal(err)
	}
	waitMessage(t, s, chat.ID, 1)
	data, _ := os.ReadFile(log)
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 4 {
		t.Fatalf("unexpected invocations: %q", lines)
	}
	first, second := lines[0], lines[2]
	if strings.Contains(first, "--tools") || strings.Contains(first, "--strict-mcp-config") || !strings.Contains(first, "bypassPermissions") || !strings.Contains(first, "--disallowedTools") || strings.Contains(first, "--resume") {
		t.Fatalf("first turn was not a full operator: %s", first)
	}
	if !strings.Contains(second, "--resume sess-1") {
		t.Fatalf("second turn did not continue the session: %s", second)
	}
	if !strings.HasSuffix(lines[1], filepath.Join("state", "operator")) {
		t.Fatalf("workspace operator ran outside its directory: %s", lines[1])
	}
	// Other providers cannot run as the operator.
	current, _ = s.Get(chat.ID)
	if _, err = s.Send(chat.ID, map[string]any{"revision": float64(current.Revision), "question": "Hi", "provider": "codex"}); err == nil {
		t.Fatal("non-Claude operator accepted")
	}
	// Task actions are an operator power, not an Ask Relay one.
	plain, _ := s.Create("Ask", "")
	if _, err = s.call(context.Background(), plain, "run_task_action", map[string]any{"taskId": "task-1", "action": "update_branch"}); err == nil {
		t.Fatal("a read-only chat ran a task action")
	}
	for _, definition := range s.chatTools(plain) {
		if definition.Name == "run_task_action" {
			t.Fatal("a read-only chat lists task actions")
		}
	}
	result, err := s.call(context.Background(), current, "run_task_action", map[string]any{"taskId": "task-1", "action": "update_branch"})
	if err != nil || a.last != "update-branch:start" || obj(result)["status"] != "completed" {
		t.Fatalf("update branch action failed: %v %#v %s", err, result, a.last)
	}
	if _, err = s.call(context.Background(), current, "run_task_action", map[string]any{"taskId": "task-1", "action": "accept"}); err == nil {
		t.Fatal("the operator accepted a task")
	}
	if _, err = s.call(context.Background(), current, "run_task_action", map[string]any{"taskId": "task-1", "action": "followup"}); err == nil {
		t.Fatal("a follow-up without a message was sent")
	}
}

func TestTaskOperatorHoldsTheWorkspaceForItsTurn(t *testing.T) {
	s, db, _ := fixture(t)
	a := &reservingActions{}
	s.Actions = a
	workspace := t.TempDir()
	raw, _ := json.Marshal(map[string]any{"id": "task-1", "title": "Task", "status": "completed", "workspace": workspace, "repository": map[string]any{"id": "repo"}})
	if err := db.Save(raw, nil); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "cwd")
	script := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(script, []byte("#!/bin/sh\ncat >/dev/null\npwd > "+log+"\nprintf '%s\\n' '"+`{"type":"result","is_error":false,"result":"Fixed."}`+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	service := task.ConfigurationService{Store: db}
	config, _ := service.Read()
	obj(obj(config.Value["harnesses"])["claude"])["command"] = script
	if _, err := service.Replace(config.Revision, config.Value); err != nil {
		t.Fatal(err)
	}
	chat, err := s.CreateMode("Operator", "task-1", operatorMode)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Send(chat.ID, map[string]any{"revision": float64(chat.Revision), "question": "Fix the lint error"}); err != nil {
		t.Fatal(err)
	}
	if m := waitMessage(t, s, chat.ID, 0); m.Status != "complete" {
		t.Fatalf("task operator failed: %#v", m)
	}
	cwd, _ := os.ReadFile(log)
	resolved, _ := filepath.EvalSymlinks(workspace)
	if strings.TrimSpace(string(cwd)) != resolved {
		t.Fatalf("task operator ran in %s, not the task workspace", cwd)
	}
	if a.reserved != 1 || a.released != 1 {
		t.Fatalf("workspace lease not held for the turn: %d/%d", a.reserved, a.released)
	}
}
