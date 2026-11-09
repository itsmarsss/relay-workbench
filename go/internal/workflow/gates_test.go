package workflow

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func planTask() map[string]any {
	return map[string]any{"id": "task", "preset": "bugfix", "status": "awaiting_plan", "stage": "plan", "messages": []any{}, "approvals": []any{}, "attempts": []any{map[string]any{"id": "plan", "stage": "plan", "status": "complete", "role": "worker", "handoff": map[string]any{"verdict": "complete", "options": []any{map[string]any{"id": "a", "title": "Approach A", "description": "Do it", "tradeoffs": "Tradeoff"}}}}}}
}
func finalTask() map[string]any {
	return map[string]any{"id": "task", "status": "awaiting_final", "stage": "review", "messages": []any{}, "approvals": []any{}, "reviewComments": []any{}, "demo": false, "verifiedFingerprint": "combined", "reviewedFingerprint": "combined", "repository": map[string]any{"id": "one"}, "repositories": []any{map[string]any{"repository": map[string]any{"id": "one"}}, map[string]any{"repository": map[string]any{"id": "two"}}}}
}
func clone(task map[string]any) map[string]any {
	raw, _ := json.Marshal(task)
	var result map[string]any
	_ = json.Unmarshal(raw, &result)
	return result
}
func TestApproachApprovalRequiresCurrentChoiceAndAuthority(t *testing.T) {
	task := planTask()
	before := clone(task)
	now := time.Date(2026, 1, 2, 3, 4, 5, 123000000, time.UTC)
	result, err := ApprovePlan(task, "a", "  note  ", Authorization{Human: true}, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(task, before) {
		t.Fatal("input mutated")
	}
	if result.Task["status"] != "queued" || result.Task["stage"] != "implement" || text(object(result.Task["chosenApproach"])["id"]) != "a" || result.Event["source"] != "user" {
		t.Fatalf("result: %#v", result)
	}
	approval := object(array(result.Task["approvals"])[0])
	if approval["note"] != "note" || approval["at"] != "2026-01-02T03:04:05.123Z" {
		t.Fatalf("approval: %#v", approval)
	}
	for _, modify := range []func(map[string]any){func(t map[string]any) { t["preset"] = "investigate" }, func(t map[string]any) { t["status"] = "running" }, func(t map[string]any) { t["messages"] = []any{map[string]any{"delivery": "pending"}} }, func(t map[string]any) { t["attempts"] = []any{} }, func(t map[string]any) { t["messages"] = nil }, func(t map[string]any) { t["approvals"] = nil }} {
		candidate := clone(task)
		modify(candidate)
		snapshot := clone(candidate)
		if _, err := ApprovePlan(candidate, "a", "", Authorization{Human: true}, nil, now); err == nil {
			t.Fatalf("invalid task accepted: %#v", candidate)
		}
		if !reflect.DeepEqual(candidate, snapshot) {
			t.Fatal("failed gate mutated task")
		}
	}
	if _, err = ApprovePlan(task, "missing", "", Authorization{Human: true}, nil, now); err == nil {
		t.Fatal("unknown approach accepted")
	}
	if _, err = ApprovePlan(task, "a", strings.Repeat("😀", 5001), Authorization{Human: true}, nil, now); err == nil {
		t.Fatal("oversize note accepted")
	}
}
func TestAutoApprovalRequiresCurrentExplicitDelegation(t *testing.T) {
	task := planTask()
	now := time.Now()
	state := map[string]any{"enabled": true, "scope": "reviewed", "authorizationId": "current", "error": nil}
	for _, auth := range []Authorization{{}, {AutomationID: "old"}, {AutomationID: "current", Scope: "draft_pr"}, {Human: true, AutomationID: "current"}} {
		if _, err := ApprovePlan(task, "a", "", auth, state, now); err == nil {
			t.Fatalf("invalid authority accepted: %#v", auth)
		}
	}
	result, err := ApprovePlan(task, "a", "", Authorization{AutomationID: "current", Scope: "reviewed"}, state, now)
	if err != nil || result.Event["source"] != "relay" {
		t.Fatalf("delegation: %#v %v", result, err)
	}
	state["enabled"] = false
	if _, err = ApprovePlan(task, "a", "", Authorization{AutomationID: "current"}, state, now); err == nil {
		t.Fatal("revoked delegation accepted")
	}
}
func TestFinalAcceptanceRequiresFreshVerifiedReviewedWork(t *testing.T) {
	task := finalTask()
	before := clone(task)
	fingerprints := Fingerprints{Combined: "combined", Repositories: map[string]string{"one": "f1", "two": "f2"}}
	result, err := AcceptFinal(task, fingerprints, Authorization{Human: true}, nil, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(task, before) {
		t.Fatal("input mutated")
	}
	if result.Task["status"] != "completed" || result.Event["source"] != "user" {
		t.Fatalf("result %#v", result)
	}
	entries := array(result.Task["repositories"])
	if object(entries[0])["acceptedFingerprint"] != "f1" || object(entries[1])["acceptedFingerprint"] != "f2" {
		t.Fatal("missing repository fingerprints")
	}
	for _, modify := range []func(map[string]any){func(t map[string]any) { t["status"] = "running" }, func(t map[string]any) { t["reviewComments"] = []any{map[string]any{"status": "open"}} }, func(t map[string]any) { t["messages"] = []any{map[string]any{"delivery": "pending"}} }, func(t map[string]any) { t["verifiedFingerprint"] = "stale" }, func(t map[string]any) { t["reviewedFingerprint"] = "" }, func(t map[string]any) { t["messages"] = nil }} {
		candidate := clone(task)
		modify(candidate)
		snapshot := clone(candidate)
		if _, err := AcceptFinal(candidate, fingerprints, Authorization{Human: true}, nil, time.Now()); err == nil {
			t.Fatalf("invalid final state accepted: %#v", candidate)
		}
		if !reflect.DeepEqual(candidate, snapshot) {
			t.Fatal("failed gate mutated task")
		}
	}
	if _, err = AcceptFinal(task, Fingerprints{Combined: "stale", Repositories: fingerprints.Repositories}, Authorization{Human: true}, nil, time.Now()); err == nil {
		t.Fatal("stale workspace accepted")
	}
	if _, err = AcceptFinal(task, Fingerprints{Combined: "combined", Repositories: map[string]string{"one": "f1"}}, Authorization{Human: true}, nil, time.Now()); err == nil {
		t.Fatal("missing repository fingerprint accepted")
	}
}
func TestCompletedPlanMatchesLegacySelection(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for legacy oracle")
	}
	base := planTask()
	cases := []map[string]any{base, clone(base)}
	debug := object(array(cases[1]["attempts"])[0])
	debug["role"] = "debug"
	next := clone(base)
	next["followUpContext"] = map[string]any{"id": "follow", "startedAt": "2026-01-01T00:00:00Z"}
	object(array(next["attempts"])[0])["followUpId"] = "other"
	cases = append(cases, next)
	next = clone(next)
	object(array(next["attempts"])[0])["followUpId"] = "follow"
	cases = append(cases, next)
	next = clone(next)
	delete(object(array(next["attempts"])[0]), "followUpId")
	object(array(next["attempts"])[0])["startedAt"] = "2026-01-02T00:00:00Z"
	cases = append(cases, next)
	next = clone(next)
	object(array(next["attempts"])[0])["startedAt"] = "2025-01-02T00:00:00Z"
	cases = append(cases, next)
	raw, _ := json.Marshal(cases)
	path, err := filepath.Abs("../../../public/workflow-plan.js")
	if err != nil {
		t.Fatal(err)
	}
	js := `import {pathToFileURL} from 'node:url';const {completedPlan}=await import(pathToFileURL(process.argv[1]));let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(t=>completedPlan(t)??null)));`
	cmd := exec.Command(node, "--input-type=module", "-e", js, path)
	cmd.Stdin = bytes.NewReader(raw)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("oracle: %s %v", out, err)
	}
	var expected []map[string]any
	if err = json.Unmarshal(out, &expected); err != nil {
		t.Fatal(err)
	}
	for i, task := range cases {
		if got := CompletedPlan(task); !reflect.DeepEqual(got, expected[i]) {
			t.Errorf("case %d got %#v want %#v", i, got, expected[i])
		}
	}
}
func FuzzGatesNeverMutateInputOrPanic(f *testing.F) {
	f.Add([]byte(`{"status":"awaiting_plan","messages":[],"approvals":[],"attempts":[]}`))
	f.Add([]byte(`{"status":"awaiting_final","messages":null}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		var task map[string]any
		if json.Unmarshal(raw, &task) != nil || task == nil {
			return
		}
		before := clone(task)
		_, _ = ApprovePlan(task, "a", "", Authorization{Human: true}, nil, time.Now())
		_, _ = AcceptFinal(task, Fingerprints{}, Authorization{Human: true}, nil, time.Now())
		if !reflect.DeepEqual(task, before) {
			t.Fatal("input mutated")
		}
	})
}
