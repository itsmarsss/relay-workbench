//go:build darwin || linux

package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"relay.local/relay/internal/process"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
	"strings"
	"testing"
	"time"
)

func TestWorkerHelper(t *testing.T) {
	if os.Getenv("RELAY_ASSISTANT_TEST") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Exit(process.Worker(os.Args[i+1:]))
		}
	}
	os.Exit(127)
}

type actions struct{ calls int }

func (a *actions) Control(context.Context, string, string, map[string]any) (any, error) {
	a.calls++
	return map[string]any{"ok": true}, nil
}
func (a *actions) Start(string) (map[string]any, error)  { a.calls++; return map[string]any{}, nil }
func (a *actions) Resume(string) (map[string]any, error) { a.calls++; return map[string]any{}, nil }
func (a *actions) Pause(string) error                    { a.calls++; return nil }
func (a *actions) Running() int                          { return 0 }
func (a *actions) Discover(context.Context, string, map[string]any) (any, error) {
	return map[string]any{}, nil
}
func fixture(t *testing.T) (*Service, *store.Store, *actions) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	worker, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	a := &actions{}
	s, err := New(db, worker, []string{"-test.run=^TestWorkerHelper$", "--"}, map[string]string{"RELAY_ASSISTANT_TEST": "1"}, a)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close(); db.Close() })
	return s, db, a
}
func TestConversationsSurviveRestartAndRecoverInterruptedMessages(t *testing.T) {
	s, db, _ := fixture(t)
	c, err := s.Create("Persistent", "")
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.update(c.ID, func(c *Chat) error {
		c.Messages = append(c.Messages, Message{ID: "m", Question: "saved", Status: "running"})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	restored, err := New(db, s.Worker, s.WorkerArgs, s.Environment, s.Actions)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	c, err = restored.Get(c.ID)
	if err != nil || len(c.Messages) != 1 || c.Messages[0].Status != "interrupted" {
		t.Fatalf("restart: %#v %v", c, err)
	}
	if _, err = s.Handle(context.Background(), "DELETE", c.ID, "", map[string]any{"revision": float64(c.Revision - 1)}); !errors.Is(err, store.ErrMetadataChanged) {
		t.Fatal("stale deletion accepted")
	}
	if _, err = s.Handle(context.Background(), "DELETE", c.ID, "", map[string]any{"revision": float64(c.Revision)}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Get(c.ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("conversation survived deletion")
	}
}
func TestProposalsRequireFreshHumanDecisionAndLivePermission(t *testing.T) {
	s, db, a := fixture(t)
	c, _ := s.Create("Workspace", "")
	id := "550e8400-e29b-41d4-a716-446655440000"
	if err := db.Save(json.RawMessage(`{"id":"`+id+`","title":"Task","status":"draft"}`), nil); err != nil {
		t.Fatal(err)
	}
	input := map[string]any{"taskId": id, "operation": "start", "reason": "Start requested draft", "body": map[string]any{}}
	value, err := s.call(context.Background(), c, "propose_task_change", input)
	if err != nil {
		t.Fatal(err)
	}
	p := value.(Proposal)
	if a.calls != 0 {
		t.Fatal("agent executed proposal")
	}
	result, err := s.Decide(context.Background(), c.ID, map[string]any{"proposalId": p.ID, "decision": "approve"})
	if err != nil || result.Status != "applied" || a.calls != 1 {
		t.Fatalf("%#v %v", result, err)
	}
	if _, err = s.Decide(context.Background(), c.ID, map[string]any{"proposalId": p.ID, "decision": "approve"}); err == nil {
		t.Fatal("proposal executed twice")
	}
	value, err = s.call(context.Background(), c, "propose_task_change", input)
	if err != nil {
		t.Fatal(err)
	}
	p = value.(Proposal)
	configService := task.ConfigurationService{Store: db}
	config, _ := configService.Read()
	obj(obj(config.Value["workspaceAgent"])["permissions"])["proposeTasks"] = false
	if _, err = configService.Replace(config.Revision, config.Value); err != nil {
		t.Fatal(err)
	}
	result, err = s.Decide(context.Background(), c.ID, map[string]any{"proposalId": p.ID, "decision": "approve"})
	if err != nil || result.Status != "failed" || a.calls != 1 {
		t.Fatal("revoked proposal ran")
	}
	side, _ := s.Create("Task side", id)
	if _, err = s.call(context.Background(), side, "create_draft", map[string]any{"task": map[string]any{}}); err == nil {
		t.Fatal("side chat created draft")
	}
	if _, err = s.call(context.Background(), side, "propose_task_change", input); err == nil {
		t.Fatal("side chat proposed mutation")
	}
	if _, err = s.call(context.Background(), side, "get_task", map[string]any{"taskId": "other"}); err == nil {
		t.Fatal("side task scope escaped")
	}
}
func TestStreamingPersistsTextToolEventsAndCancellation(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(map[bool]string{true: "cancel", false: "complete"}[cancel], func(t *testing.T) {
			s, db, _ := fixture(t)
			script := filepath.Join(t.TempDir(), "agent")
			source := "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '" + `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}` + "'\n"
			if cancel {
				source += "sleep 60\n"
			} else {
				source += "printf '%s\\n' '" + `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call","name":"mcp__relay__list_tasks","input":{}}]}}` + "' '" + `{"type":"result","is_error":false,"result":"Hello, developer."}` + "'\n"
			}
			if err := os.WriteFile(script, []byte(source), 0700); err != nil {
				t.Fatal(err)
			}
			service := task.ConfigurationService{Store: db}
			config, _ := service.Read()
			obj(obj(config.Value["harnesses"])["claude"])["command"] = script
			if _, err := service.Replace(config.Revision, config.Value); err != nil {
				t.Fatal(err)
			}
			c, _ := s.Create("Chat", "")
			_, err := s.Send(c.ID, map[string]any{"revision": float64(c.Revision), "question": "Literal $(do-not-run)"})
			if err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(8 * time.Second)
			for {
				current, _ := s.Get(c.ID)
				if len(current.Messages) > 0 && current.Messages[0].Answer != "" {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("stream did not persist")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if cancel {
				if _, err = s.Handle(context.Background(), "POST", c.ID, "stop", map[string]any{}); err != nil {
					t.Fatal(err)
				}
			}
			for {
				current, _ := s.Get(c.ID)
				m := current.Messages[0]
				if m.Status != "running" {
					if cancel && m.Status != "interrupted" {
						t.Fatalf("not cancelled: %#v", m)
					}
					if !cancel && (m.Status != "complete" || m.Answer != "Hello, developer." || len(m.ToolCalls) != 1) {
						t.Fatalf("invalid response: %#v", m)
					}
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("response never settled")
				}
				time.Sleep(10 * time.Millisecond)
			}
		})
	}
}
func TestSourceToolsRejectEscapesAndPreserveWork(t *testing.T) {
	s, db, _ := fixture(t)
	root := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
		if data, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%s %v", data, err)
		}
	}
	git("init", "-q")
	os.WriteFile(filepath.Join(root, "source.txt"), []byte("first\nneedle here\n"), 0600)
	git("add", "source.txt")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "test: fixture")
	os.WriteFile(filepath.Join(root, "source.txt"), []byte("dirty\nneedle here\n"), 0600)
	outside := filepath.Join(t.TempDir(), "secret")
	os.WriteFile(outside, []byte("secret"), 0600)
	os.Symlink(outside, filepath.Join(root, "link"))
	value := map[string]any{"id": "550e8400-e29b-41d4-a716-446655440000", "title": "Task", "status": "running", "workspaceRoot": root, "repository": map[string]any{"id": "repo"}}
	raw, _ := json.Marshal(value)
	db.Save(raw, nil)
	chat, _ := s.Create("Task", text(value["id"]))
	ctx := context.Background()
	for _, path := range []string{"../secret", ".git/config", outside, "link"} {
		if _, err := s.call(ctx, chat, "read_file", map[string]any{"repositoryId": "repo", "path": path}); err == nil {
			t.Fatalf("source escape accepted: %s", path)
		}
	}
	result, err := s.call(ctx, chat, "read_file", map[string]any{"repositoryId": "repo", "path": "source.txt"})
	if err != nil || !strings.Contains(text(obj(result)["text"]), "dirty") {
		t.Fatalf("%#v %v", result, err)
	}
	data, _ := os.ReadFile(filepath.Join(root, "source.txt"))
	if !strings.HasPrefix(string(data), "dirty") {
		t.Fatal("source changed")
	}
}

func TestMCPWireAcceptsJSONRPCAndHidesWritesInSideChat(t *testing.T) {
	s, _, _ := fixture(t)
	chat, _ := s.Create("Wire", "")
	directory, err := os.MkdirTemp("", "relay-mcp-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(directory)
	socket := filepath.Join(directory, "mcp.sock")
	stop, err := s.serveTools(context.Background(), socket, "secret", chat, "")
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	input := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_tasks","arguments":{}}}
`)
	var output, diagnostic strings.Builder
	if status := MCPClient([]string{socket, "secret"}, input, &output, &diagnostic); status != 0 {
		t.Fatalf("wire failed: %d %s", status, diagnostic.String())
	}
	if !strings.Contains(output.String(), `"tools"`) || strings.Contains(output.String(), `"error"`) {
		t.Fatal(output.String())
	}
	output.Reset()
	if status := MCPClient([]string{socket, "wrong"}, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`), &output, &diagnostic); status == 0 {
		t.Fatal("wrong capability accepted")
	}
}
