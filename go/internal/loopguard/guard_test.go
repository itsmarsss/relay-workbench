package loopguard

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"relay.local/relay/internal/legacytest"
	"testing"
)

type input struct {
	Task    map[string]any `json:"task"`
	Attempt map[string]any `json:"attempt"`
}
type output struct {
	Changed bool           `json:"changed"`
	Task    map[string]any `json:"task"`
}

func run(id, verdict, fp string) map[string]any {
	return map[string]any{"id": id, "stage": "verify", "repositoryId": "r", "fingerprint": fp, "handoff": map[string]any{"verdict": verdict, "summary": "Test failed", "evidence": []any{"same evidence"}}}
}
func TestIdenticalFailureGuardMatchesLegacy(t *testing.T) {
	node, _ := exec.LookPath("node")
	a, b, c := run("a", "blocked", "hash"), run("b", "blocked", "hash"), run("c", "blocked", "hash")
	cases := []input{
		{map[string]any{"status": "running", "attempts": []any{a}}, a},
		{map[string]any{"status": "running", "attempts": []any{a, b}}, b},
		{map[string]any{"status": "running", "attempts": []any{a, b, c}, "recovery": map[string]any{"active": true}}, c},
		{map[string]any{"status": "running", "attempts": []any{a, b, c}, "blockerDecision": map[string]any{"id": "existing"}}, c},
		{map[string]any{"status": "running", "attempts": []any{a, b, c}, "loopGuardAcknowledgedAt": 2}, c},
		{map[string]any{"status": "running", "attempts": []any{a, b}}, run("c", "blocked", "different")},
		{map[string]any{"status": "running", "attempts": []any{a, b}}, run("c", "blocked", "demo")},
		{map[string]any{"status": "running", "attempts": []any{a, b}}, run("c", "complete", "hash")},
	}
	payload, _ := json.Marshal(cases)
	path, err := filepath.Abs("../../../server/loop-guard.js")
	if err != nil {
		t.Fatal(err)
	}
	js := `import {pathToFileURL} from 'node:url';const {applyLoopGuard}=await import(pathToFileURL(process.argv[1]));let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(x=>({changed:applyLoopGuard(x.task,x.attempt),task:x.task}))));`
	cmd := exec.Command(node, "--input-type=module", "-e", js, path)
	cmd.Stdin = bytes.NewReader(payload)
	out, err := legacytest.Output(t, "loopguard-guard-1", cmd, true)
	if err != nil {
		t.Fatalf("oracle: %s %v", out, err)
	}
	var expected []output
	if err = json.Unmarshal(out, &expected); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		raw, _ := json.Marshal(c)
		var normalized input
		if err = json.Unmarshal(raw, &normalized); err != nil {
			t.Fatal(err)
		}
		changed := Apply(normalized.Task, normalized.Attempt)
		actualRaw, _ := json.Marshal(output{changed, normalized.Task})
		var actual output
		if err = json.Unmarshal(actualRaw, &actual); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(actual, expected[i]) {
			t.Errorf("case %d got %#v want %#v", i, actual, expected[i])
		}
	}
}

func TestMalformedEvidenceCannotCauseFalseLoop(t *testing.T) {
	a := run("a", "blocked", "hash")
	h := object(a["handoff"])
	h["evidence"] = map[string]any{"unexpected": true}
	task := map[string]any{"attempts": []any{a, a, a}}
	if Apply(task, a) {
		t.Fatal("malformed evidence created loop")
	}
	h["verdict"] = []any{"blocked"}
	if Apply(task, a) {
		t.Fatal("malformed verdict accepted")
	}
}

func FuzzApplyNeverPanics(f *testing.F) {
	f.Add([]byte(`{"task":{"attempts":[]},"attempt":{"handoff":{"verdict":"blocked","summary":"x","evidence":[]},"fingerprint":"x"}}`))
	f.Add([]byte(`{"task":null,"attempt":{"handoff":{"verdict":[]},"fingerprint":"x"}}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		var value input
		if json.Unmarshal(raw, &value) != nil {
			return
		}
		_ = Apply(value.Task, value.Attempt)
	})
}

func TestOnlyIdenticalEvidenceTriggersGuard(t *testing.T) {
	a := run("a", "blocked", "hash")
	b := run("b", "blocked", "hash")
	object(a["handoff"])["summary"] = "\uFEFF TEST FAILED \uFEFF"
	task := map[string]any{"attempts": []any{a, b}}
	if !Apply(task, b) {
		t.Fatal("identical failure with whitespace and case was missed")
	}
	object(a["handoff"])["evidence"] = []any{"different"}
	delete(task, "loopGuard")
	if Apply(task, b) {
		t.Fatal("different evidence caused loop")
	}
	object(a["handoff"])["evidence"] = []any{"same evidence"}
	object(a["handoff"])["summary"] = "İ"
	object(b["handoff"])["summary"] = "i"
	if Apply(task, b) {
		t.Fatal("unicode folding caused a false match")
	}
}
