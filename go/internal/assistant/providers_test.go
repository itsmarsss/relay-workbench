//go:build darwin || linux

package assistant

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"relay.local/relay/internal/harness"
	"relay.local/relay/internal/task"
)

func TestCodexToolProtocolPreservesPermissionBoundary(t *testing.T) {
	s, _, _ := fixture(t)
	chat, _ := s.Create("Tools", "")
	sent := []map[string]any{}
	closed := false
	output := newStream(func(string, []ToolCall) error { return nil })
	c := codexChat{service: s, chat: chat, thread: "thread", output: output, send: func(v any) error { sent = append(sent, v.(map[string]any)); return nil }, closeInput: func() error { closed = true; return nil }}
	consume := func(v any) error { raw, _ := json.Marshal(v); return c.consume(context.Background(), string(raw)) }
	if err := consume(map[string]any{"id": 8, "method": "item/commandExecution/requestApproval", "params": map[string]any{}}); err != nil {
		t.Fatal(err)
	}
	if sent[0]["error"] == nil {
		t.Fatal("native approval was granted")
	}
	if err := consume(map[string]any{"id": 9, "method": "item/tool/call", "params": map[string]any{"threadId": "thread", "callId": "one", "tool": "list_tasks", "arguments": map[string]any{}}}); err != nil {
		t.Fatal(err)
	}
	if obj(sent[1]["result"])["success"] != true || len(output.calls) != 1 || output.calls[0].Status != "complete" {
		t.Fatalf("tool failed: %#v", sent)
	}
	side, _ := s.Create("Side", "550e8400-e29b-41d4-a716-446655440000")
	c.chat = side
	if err := consume(map[string]any{"id": 10, "method": "item/tool/call", "params": map[string]any{"threadId": "thread", "callId": "two", "tool": "create_draft", "arguments": map[string]any{"task": map[string]any{}}}}); err != nil {
		t.Fatal(err)
	}
	if obj(sent[2]["result"])["success"] != false {
		t.Fatal("side chat created draft")
	}
	if err := consume(map[string]any{"method": "item/started", "params": map[string]any{"threadId": "thread", "item": map[string]any{"type": "commandExecution"}}}); err == nil {
		t.Fatal("native command accepted")
	}
	if err := consume(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "thread", "turn": map[string]any{"status": "failed"}}}); err == nil || closed {
		t.Fatal("failed turn completed")
	}
	if err := consume(map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{"threadId": "thread", "delta": "Answer"}}); err != nil {
		t.Fatal(err)
	}
	if err := consume(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "thread", "turn": map[string]any{"status": "completed"}}}); err != nil || !closed || !c.completed || output.finish() != nil {
		t.Fatalf("completion: %v", err)
	}
}

func TestCodexHandshakeDisablesNativeEnvironment(t *testing.T) {
	s, _, _ := fixture(t)
	chat, _ := s.Create("Tools", "")
	sent := []map[string]any{}
	c := codexChat{service: s, chat: chat, directory: t.TempDir(), config: harness.Config{}, send: func(v any) error { sent = append(sent, v.(map[string]any)); return nil }}
	if err := c.consume(context.Background(), `{"id":1,"result":{}}`); err != nil {
		t.Fatal(err)
	}
	p := obj(sent[1]["params"])
	if p["sandbox"] != "read-only" || p["approvalPolicy"] != "never" || len(p["environments"].([]any)) != 0 || len(p["dynamicTools"].([]any)) == 0 {
		t.Fatalf("unsafe handshake: %#v", p)
	}
	args := strings.Join(codexChatArgs(), " ")
	for _, required := range []string{"mcp_servers={}", "features.shell_tool=false", "features.plugins=false", "features.apps=false", "features.multi_agent=false", "web_search=\"disabled\""} {
		if !strings.Contains(args, required) {
			t.Fatal(required)
		}
	}
}

func TestPiStreamTracksToolCallsAndFailedAnswers(t *testing.T) {
	s := newStream(func(string, []ToolCall) error { return nil })
	for _, line := range []string{
		`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}`,
		`{"type":"tool_execution_start","toolCallId":"one","toolName":"list_tasks","args":{}}`,
		`{"type":"tool_execution_end","toolCallId":"one","isError":false}`,
		`{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"Hello, developer"}]}}`,
		`{"type":"agent_end"}`,
	} {
		if err := s.consumePi(line); err != nil {
			t.Fatal(err)
		}
	}
	if s.finish() != nil || s.final != "Hello, developer" || s.calls[0].Status != "complete" {
		t.Fatalf("stream: %#v", s)
	}
	_ = s.consumePi(`{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"unavailable"}}`)
	if s.finish() == nil {
		t.Fatal("provider failure accepted")
	}
}

// Opt-in integration: uses installed credentials with disposable Relay state.
func TestChatProviderSmoke(t *testing.T) {
	provider := os.Getenv("RELAY_CHAT_SMOKE_PROVIDER")
	if provider == "" {
		t.Skip("opt-in provider smoke")
	}
	command, err := exec.LookPath(provider)
	if err != nil {
		t.Fatal(err)
	}
	s, db, _ := fixture(t)
	configuration := task.ConfigurationService{Store: db}
	config, _ := configuration.Read()
	agent := obj(obj(config.Value["harnesses"])[provider])
	agent["command"] = command
	agent["enabled"] = true
	agent["model"] = ""
	agent["effort"] = ""
	if _, err = configuration.Replace(config.Revision, config.Value); err != nil {
		t.Fatal(err)
	}
	chat, _ := s.Create("Smoke", "")
	_, err = s.Send(chat.ID, map[string]any{"revision": float64(chat.Revision), "provider": provider, "question": "Call list_tasks once, then briefly say how many tasks are present. Do not call any other tool."})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(100 * time.Second)
	for time.Now().Before(deadline) {
		current, _ := s.Get(chat.ID)
		if len(current.Messages) > 0 && current.Messages[0].Status != "running" {
			m := current.Messages[0]
			if m.Status != "complete" || len(m.ToolCalls) == 0 || m.Answer == "" {
				t.Fatalf("smoke: %#v", m)
			}
			t.Logf("%s: %s", provider, m.Answer)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("provider smoke timed out")
}
