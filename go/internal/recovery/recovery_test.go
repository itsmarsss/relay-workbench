package recovery

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

type testCase struct {
	Operation string         `json:"operation"`
	Task      map[string]any `json:"task"`
	Handoff   map[string]any `json:"handoff"`
	Reason    string         `json:"reason"`
	Limit     int            `json:"limit"`
	Explicit  bool           `json:"explicit"`
}
type outcome struct {
	Changed bool           `json:"changed"`
	Task    map[string]any `json:"task"`
}

func handoff(summary string) map[string]any {
	return map[string]any{"summary": summary, "details": "diagnosis", "evidence": []any{"log"}, "risks": []any{"risk"}, "options": []any{}, "verdict": "blocked"}
}
func attempt(id, role string, repo any) map[string]any {
	return map[string]any{"id": id, "stage": "implement", "role": role, "repositoryId": repo, "harness": "codex", "sessionId": "session-" + id, "handoff": handoff("failed")}
}
func baseTask() map[string]any {
	return map[string]any{"stage": "implement", "status": "blocked", "repositoryCursor": 0, "round": 0, "attempts": []any{attempt("first", "implement", nil)}}
}
func clone(t map[string]any) map[string]any {
	b, _ := json.Marshal(t)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}
func TestRecoveryTransitionsMatchLegacy(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for legacy oracle")
	}
	cases := []testCase{}
	add := func(operation string, task map[string]any, h map[string]any, limit int, explicit bool) {
		cases = append(cases, testCase{operation, task, h, "continue diagnosis", limit, explicit})
	}
	add("inplace", baseTask(), nil, 0, false)
	task := baseTask()
	delete(last(list(task["attempts"])), "sessionId")
	add("inplace", task, nil, 0, false)
	task = baseTask()
	last(list(task["attempts"]))["role"] = "debug"
	add("inplace", task, nil, 0, false)
	task = baseTask()
	last(list(task["attempts"]))["harness"] = "checks"
	add("inplace", task, nil, 0, false)
	task = baseTask()
	task["localRecovery"] = map[string]any{"key": "implement:0:0", "attempts": 1}
	add("inplace", task, nil, 0, false)
	task = baseTask()
	task["recovery"] = map[string]any{"prior": "kept"}
	add("inplace", task, nil, 0, false)
	add("blocked", baseTask(), handoff("failed"), 2, false)
	task = baseTask()
	task["recovery"] = map[string]any{"key": "implement:0", "attempts": 1, "reason": "failed", "sourceAttemptId": "first"}
	add("blocked", task, handoff("failed"), 2, false)
	task = baseTask()
	task["recovery"] = map[string]any{"key": "implement:0", "attempts": 2, "reason": "failed", "sourceAttemptId": "first"}
	add("blocked", task, handoff("failed"), 3, false)
	task = baseTask()
	task["attempts"] = []any{attempt("first", "implement", nil), attempt("debug", "debug", nil)}
	h := handoff("design choice")
	h["options"] = []any{map[string]any{"id": "design-a"}}
	add("blocked", task, h, 2, false)
	add("blocked", clone(task), h, 2, true)
	task = baseTask()
	task["repositories"] = []any{map[string]any{"repository": map[string]any{"id": "one"}}, map[string]any{"repository": map[string]any{"id": "two"}}}
	task["repositoryCursor"] = 1
	task["attempts"] = []any{attempt("first", "implement", "one"), attempt("second", "implement", "two")}
	add("blocked", task, handoff("failed"), 2, false)
	add("blocked", baseTask(), handoff("failed"), 0, false)
	payload, _ := json.Marshal(cases)
	path, err := filepath.Abs("../../../server/recovery.js")
	if err != nil {
		t.Fatal(err)
	}
	js := `import {pathToFileURL} from 'node:url';const {recoverInPlace,recoverBlocked}=await import(pathToFileURL(process.argv[1]));let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(c=>({changed:c.operation==='inplace'?recoverInPlace(c.task,c.reason):recoverBlocked(c.task,c.handoff,c.limit,c.explicit),task:c.task}))));`
	cmd := exec.Command(node, "--input-type=module", "-e", js, path)
	cmd.Stdin = bytes.NewReader(payload)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("oracle: %s %v", out, err)
	}
	var expected []outcome
	if err = json.Unmarshal(out, &expected); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		raw, _ := json.Marshal(c)
		var decoded testCase
		if err = json.Unmarshal(raw, &decoded); err != nil {
			t.Fatal(err)
		}
		changed := false
		if c.Operation == "inplace" {
			changed = InPlace(decoded.Task, c.Reason)
		} else {
			changed, err = Blocked(decoded.Task, decoded.Handoff, c.Limit, c.Explicit)
			if err != nil {
				t.Fatal(err)
			}
		}
		raw, _ = json.Marshal(outcome{changed, decoded.Task})
		var actual outcome
		_ = json.Unmarshal(raw, &actual)
		if !reflect.DeepEqual(actual, expected[i]) {
			t.Errorf("case %d got %#v want %#v", i, actual, expected[i])
		}
	}
}
func TestInPlaceDoesNotRepeatInSameStageRound(t *testing.T) {
	task := baseTask()
	if !InPlace(task, "failure") {
		t.Fatal("expected continuation")
	}
	if InPlace(task, "again") {
		t.Fatal("repeated same continuation")
	}
	task["round"] = float64(1)
	if !InPlace(task, "new round") {
		t.Fatal("new round should have a chance")
	}
}

type resumeCase struct {
	Task    map[string]any `json:"task"`
	Stage   string         `json:"stage"`
	Harness string         `json:"harness"`
	Repo    any            `json:"repo"`
	HasRepo bool           `json:"hasRepo"`
}
type resumeResult struct {
	Attempt map[string]any `json:"attempt"`
	Context map[string]any `json:"context"`
}

func TestContinuationAndSessionSelectionMatchLegacy(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for legacy oracle")
	}
	tasks := []resumeCase{}
	first := attempt("first", "implement", nil)
	delete(first, "handoff")
	first["status"] = "failed"
	task := baseTask()
	task["attempts"] = []any{first}
	tasks = append(tasks, resumeCase{task, "implement", "codex", nil, true})
	task = clone(task)
	delete(object(list(task["attempts"])[0]), "repositoryId")
	tasks = append(tasks, resumeCase{task, "implement", "codex", nil, false}, resumeCase{task, "implement", "codex", nil, true})
	task = baseTask()
	task["attempts"] = []any{attempt("first", "implement", nil), attempt("debug", "debug", nil)}
	task["recovery"] = map[string]any{"key": "implement:0", "phase": "continue", "active": false, "sourceAttemptId": "first", "reason": "failure", "lastDiagnosis": map[string]any{"summary": "fixed"}}
	tasks = append(tasks, resumeCase{task, "implement", "codex", nil, true})
	task = clone(task)
	object(task["recovery"])["active"] = true
	tasks = append(tasks, resumeCase{task, "implement", "codex", nil, true})
	task = baseTask()
	one := attempt("one", "implement", "one")
	two := attempt("two", "implement", "two")
	delete(one, "handoff")
	one["status"] = "failed"
	delete(two, "handoff")
	two["status"] = "failed"
	task["attempts"] = []any{one, two}
	tasks = append(tasks, resumeCase{task, "implement", "codex", "one", true}, resumeCase{task, "implement", "codex", "two", true})
	payload, _ := json.Marshal(tasks)
	path, err := filepath.Abs("../../../server/recovery.js")
	if err != nil {
		t.Fatal(err)
	}
	js := `import {pathToFileURL} from 'node:url';const {resumableAttempt,continuationContext}=await import(pathToFileURL(process.argv[1]));let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(c=>{const repo=c.hasRepo?c.repo:undefined;return {attempt:resumableAttempt(c.task,c.stage,c.harness,repo)??null,context:continuationContext(c.task,c.stage,repo)??null}})));`
	cmd := exec.Command(node, "--input-type=module", "-e", js, path)
	cmd.Stdin = bytes.NewReader(payload)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("oracle: %s %v", out, err)
	}
	var expected []resumeResult
	if err = json.Unmarshal(out, &expected); err != nil {
		t.Fatal(err)
	}
	for i, c := range tasks {
		raw, _ := json.Marshal(c)
		var normalized resumeCase
		_ = json.Unmarshal(raw, &normalized)
		actual := resumeResult{Resumable(normalized.Task, normalized.Stage, normalized.Harness, RepositoryRef{normalized.Repo, normalized.HasRepo}), Continuation(normalized.Task, normalized.Stage, normalized.Repo)}
		raw, _ = json.Marshal(actual)
		var result resumeResult
		_ = json.Unmarshal(raw, &result)
		if !reflect.DeepEqual(result, expected[i]) {
			t.Errorf("case %d got %#v want %#v", i, result, expected[i])
		}
	}
}
func TestDebuggerFallbackPreservesConfiguredOrder(t *testing.T) {
	task := baseTask()
	task["recovery"] = map[string]any{"active": true, "attempts": float64(2)}
	got := Harnesses(task, "codex", []Harness{{"codex", true}, {"claude", true}, {"pi", true}, {"disabled", false}})
	if !reflect.DeepEqual(got, []string{"claude", "pi", "codex"}) {
		t.Fatalf("fallback: %#v", got)
	}
}

func FuzzRecoveryNeverPanics(f *testing.F) {
	f.Add([]byte(`{"task":{"stage":"implement","attempts":[]},"handoff":{"summary":"blocked","options":[]}}`))
	f.Add([]byte(`{"task":null,"handoff":null}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		var c testCase
		if json.Unmarshal(raw, &c) != nil {
			return
		}
		_ = InPlace(c.Task, "test")
		_, _ = Blocked(c.Task, c.Handoff, 2, false)
		_ = Resumable(c.Task, "implement", "codex", RepositoryRef{})
		_ = Continuation(c.Task, "implement", nil)
	})
}
