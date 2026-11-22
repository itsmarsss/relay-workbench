package assistant

import (
	"encoding/json"
	"strings"
	"testing"
)

// A long task's record passes what agent CLIs accept from a tool; the agent's view stays small and
// still carries the pull request, workspace and recent runs.
func TestCompactTaskFitsAToolResultAndKeepsState(t *testing.T) {
	attempts := []any{}
	for i := 0; i < 40; i++ {
		attempts = append(attempts, map[string]any{"id": "a", "stage": "verify", "status": "complete", "transcript": strings.Repeat("x", 50000), "handoff": map[string]any{"summary": strings.Repeat("s", 5000), "verdict": "complete", "evidence": strings.Repeat("e", 20000)}})
	}
	task := map[string]any{"id": "t", "title": "T", "status": "paused", "stage": "verify", "attempts": attempts,
		"repository":         map[string]any{"id": "r", "name": "World", "strategy": "managed"},
		"workspaceRoot":      "/trees/relay-t/src",
		"publication":        map[string]any{"url": "https://code.example/pull/1", "state": "merged", "body": strings.Repeat("b", 9000)},
		"publicationMonitor": map[string]any{"status": "complete", "finishedAt": "2026-11-20T11:21:29Z", "summary": "merged"}}
	raw, _ := json.Marshal(task)
	view, _ := json.Marshal(compactTask(task))
	if len(raw) < 1_000_000 || len(view) > 40_000 {
		t.Fatalf("raw %d, compact %d", len(raw), len(view))
	}
	for _, want := range []string{`"state":"merged"`, `"workspaceRoot":"/trees/relay-t/src"`, `"finishedAt":"2026-11-20T11:21:29Z"`, `"olderAttempts":30`} {
		if !strings.Contains(string(view), want) {
			t.Fatalf("compact view lost %s: %s", want, view[:400])
		}
	}
}

func TestCompactActivityDropsStreamedOutput(t *testing.T) {
	rows := []json.RawMessage{
		json.RawMessage(`{"at":"1","type":"activity","summary":"Started verification"}`),
		json.RawMessage(`{"at":"2","stream":"stdout","text":"noise"}`),
		json.RawMessage(`{"at":"3","type":"publication","summary":"PR merged"}`),
	}
	got := compactActivity(rows, 10)
	if len(got) != 2 || got[0].(map[string]any)["summary"] != "PR merged" {
		t.Fatalf("activity %#v", got)
	}
}
