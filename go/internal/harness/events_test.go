package harness

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"relay.local/relay/internal/legacytest"
	"strings"
	"testing"
)

type eventCase struct {
	Provider string `json:"provider"`
	Line     string `json:"line"`
}

func TestEventDecodingMatchesLegacy(t *testing.T) {
	node, _ := exec.LookPath("node")
	cases := []eventCase{}
	add := func(provider string, value any) {
		raw, _ := json.Marshal(value)
		cases = append(cases, eventCase{provider, string(raw)})
	}
	cases = append(cases, eventCase{"codex", "plain output"})
	add("codex", map[string]any{"type": "relay.activity", "summary": "Reading", "details": "file"})
	add("codex", map[string]any{"type": "relay.error", "error": "problem"})
	add("codex", map[string]any{"type": "item.completed", "item": map[string]any{"type": "agent_message", "text": "Hello"}})
	add("codex", map[string]any{"type": "item.completed", "item": map[string]any{"type": "agent_message", "text": `{"summary":"Done","details":"context"}`}})
	add("codex", map[string]any{"type": "item.started", "item": map[string]any{"type": "command_execution", "command": "git status"}})
	add("codex", map[string]any{"type": "item.completed", "item": map[string]any{"type": "command_execution", "command": "git status", "exit_code": 1, "aggregated_output": "failed"}})
	add("codex", map[string]any{"type": "item.completed", "item": map[string]any{"type": "file_change", "changes": []any{map[string]any{"path": "a", "type": "edit"}}}})
	add("codex", map[string]any{"type": "turn.failed", "error": map[string]any{"message": "failed"}})
	add("claude", map[string]any{"type": "result", "structured_output": map[string]any{"summary": "Done", "details": "notes"}})
	add("claude", map[string]any{"type": "result", "result": "plain"})
	add("claude", map[string]any{"type": "result", "is_error": true, "errors": []any{"a", "b"}})
	add("claude", map[string]any{"type": "user", "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "content": "ok"}, map[string]any{"type": "tool_result", "is_error": true, "content": map[string]any{"text": "denied"}}}}})
	add("claude", map[string]any{"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "thinking"}, map[string]any{"type": "tool_use", "name": "Read", "input": map[string]any{"file": "a"}}}}})
	add("pi", map[string]any{"type": "message_end", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "one"}, map[string]any{"type": "text", "text": "two"}}}})
	add("pi", map[string]any{"type": "message_end", "message": map[string]any{"role": "assistant", "stopReason": "error", "errorMessage": "denied"}})
	add("pi", map[string]any{"type": "tool_execution_start", "toolName": "read", "args": map[string]any{"path": "file"}})
	add("pi", map[string]any{"type": "tool_execution_end", "toolName": "read", "isError": true, "result": map[string]any{"text": "denied"}})
	add("pi", map[string]any{"type": "unknown"})
	add("claude", map[string]any{"type": "result"})
	add("claude", map[string]any{"type": "result", "structured_output": nil})
	add("claude", map[string]any{"type": "user", "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "content": nil}}}})
	add("claude", map[string]any{"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "tool_use", "name": "Read"}}}})
	add("codex", map[string]any{"type": "item.started", "item": map[string]any{"type": "command_execution"}})
	add("codex", map[string]any{"type": "item.started", "item": map[string]any{"type": "command_execution", "command": nil}})
	add("pi", map[string]any{"type": "tool_execution_start"})
	add("pi", map[string]any{"type": "tool_execution_end", "toolName": "", "result": nil})
	cases = append(cases, eventCase{"claude", `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Inspect","input":{"2":"two","1":"one","markup":"<img & test>","unicode":"\u2028","large":1e20,"small":1e-7,"negativeZero":-0}}]}}`})
	cases = append(cases, eventCase{"pi", `{"type":"tool_execution_start","toolName":"read","args":{"z":"\u003cscript\u003e","x":"a\nline","number":1e21}}`})
	cases = append(cases, eventCase{"claude", `{"type":"user","message":{"content":[{"type":"tool_result","content":{"a":"\u003cvalue\u003e","n":0.000001}}]}}`})
	payload, _ := json.Marshal(cases)
	path, err := filepath.Abs("../../../server/harness.js")
	if err != nil {
		t.Fatal(err)
	}
	script := `import {pathToFileURL} from 'node:url';const {decodeEvent}=await import(pathToFileURL(process.argv[1]));let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(c=>decodeEvent(c.provider,c.line))));`
	cmd := exec.Command(node, "--input-type=module", "-e", script, path)
	cmd.Stdin = bytes.NewReader(payload)
	out, err := legacytest.Output(t, "harness-events-1", cmd, true)
	if err != nil {
		t.Fatalf("oracle: %s %v", out, err)
	}
	var expected []map[string]any
	if err = json.Unmarshal(out, &expected); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		raw, _ := json.Marshal(Decode(c.Provider, c.Line))
		var actual map[string]any
		_ = json.Unmarshal(raw, &actual)
		if !reflect.DeepEqual(actual, expected[i]) {
			t.Errorf("case %d provider %s got %#v want %#v", i, c.Provider, actual, expected[i])
		}
	}
}
func TestEventOutputIsBoundedAndPreservesLiteralText(t *testing.T) {
	line := strings.Repeat("a", 1300) + "$(do-not-run)"
	event := Decode("codex", line)
	if len(event["activity"].(string)) != 1200 || event["details"] != line {
		t.Fatal("output lost or not bounded")
	}
}
func FuzzEventDecoderNeverPanics(f *testing.F) {
	f.Add("codex", `{"type":"item.completed","item":{"type":"agent_message","text":"done"}}`)
	f.Add("pi", `null`)
	f.Fuzz(func(t *testing.T, provider, line string) { _ = Decode(provider, line) })
}
