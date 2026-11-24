package harness

import "testing"

// Codex's own reconnect notices are progress, not failures; a real error still is one.
func TestCodexReconnectNoticesAreNotFailures(t *testing.T) {
	notice := Decode("codex", `{"type":"error","message":"Reconnecting... 2/5 (stream disconnected before completion: Transport error)"}`)
	if notice["error"] != nil || notice["activity"] == nil {
		t.Fatalf("reconnect notice: %#v", notice)
	}
	waiting := Decode("codex", `{"type":"error","message":"Reconnecting... waiting for network (Connection failed)"}`)
	if waiting["error"] != nil {
		t.Fatalf("waiting notice: %#v", waiting)
	}
	failure := Decode("codex", `{"type":"error","message":"quota exceeded"}`)
	if failure["error"] != "quota exceeded" {
		t.Fatalf("real error: %#v", failure)
	}
	if done := Decode("codex", `{"type":"turn.completed","usage":{}}`); done["turnCompleted"] != true {
		t.Fatalf("turn completion: %#v", done)
	}
}
