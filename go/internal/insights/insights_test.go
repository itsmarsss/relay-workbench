package insights

import (
	"bytes"
	"encoding/json"
	"math"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestOutcomesMatchLegacyEvidenceRules(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node oracle unavailable")
	}
	attempt := func(stage, status, verdict, model string) map[string]any {
		return map[string]any{"stage": stage, "status": status, "model": model, "harness": "codex", "repositoryId": "repo", "startedAt": "2026-01-01T00:00:00Z", "finishedAt": "2026-01-01T00:00:30Z", "handoff": map[string]any{"verdict": verdict, "findings": []any{}}}
	}
	tasks := []map[string]any{}
	for i := range 5 {
		tasks = append(tasks, map[string]any{"id": string(rune('a' + i)), "status": "completed", "repository": map[string]any{"id": "repo"}, "attempts": []any{attempt("investigate", "complete", "complete", "model"), attempt("implement", "complete", "complete", "model"), attempt("verify", "complete", "complete", "model"), attempt("review", "complete", "complete", "model")}})
	}
	tasks = append(tasks, map[string]any{"id": "pending", "status": "running", "repository": map[string]any{"id": "repo"}, "attempts": []any{attempt("implement", "complete", "complete", "model"), attempt("review", "interrupted", "", "model"), attempt("plan", "running", "", "model")}})
	tasks = append(tasks, map[string]any{"id": "failed", "repository": map[string]any{"id": "repo"}, "attempts": []any{attempt("implement", "complete", "complete", "model"), attempt("verify", "failed", "blocked", "model"), attempt("review", "complete", "changes_requested", "model")}})
	tasks = append(tasks, map[string]any{"id": "demo", "demo": true, "attempts": []any{attempt("plan", "failed", "blocked", "model")}})
	config := map[string]any{"harnesses": map[string]any{"codex": map[string]any{"enabled": true, "model": "model"}}}
	script, _ := filepath.Abs("../../../server/outcomes.js")
	for _, repository := range []string{"", "repo", "other"} {
		input, _ := json.Marshal(map[string]any{"tasks": tasks, "config": config, "repository": repository})
		cmd := exec.Command(node, "--input-type=module", "-e", `import{pathToFileURL}from'node:url';const{routingOutcomes}=await import(pathToFileURL(process.argv[1]));let s='';for await(const c of process.stdin)s+=c;const v=JSON.parse(s);console.log(JSON.stringify(routingOutcomes(v.tasks,v.config,v.repository)));`, script)
		cmd.Stdin = bytes.NewReader(input)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("oracle: %s %v", output, err)
		}
		var want, got map[string]any
		json.Unmarshal(output, &want)
		raw, _ := json.Marshal(Outcomes(tasks, config, repository))
		json.Unmarshal(raw, &got)
		for _, key := range []string{"rows", "recommendations"} {
			a, b := arr(want[key]), arr(got[key])
			if len(a) != len(b) {
				t.Fatal("outcome count mismatch")
			}
			for i := range a {
				old, next := obj(a[i]), obj(b[i])
				if math.Abs(old["confidenceLower"].(float64)-next["confidenceLower"].(float64)) > 1e-14 {
					t.Fatal("confidence mismatch")
				}
				delete(old, "confidenceLower")
				delete(next, "confidenceLower")
			}
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %#v want %#v", got, want)
		}
	}
}
func TestHealthUsesRecordedEvidenceAndIgnoresRepeatedOutput(t *testing.T) {
	now := time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC)
	task := map[string]any{"id": "task", "status": "running", "attempts": []any{map[string]any{"id": "run", "stage": "verify", "status": "running", "startedAt": now.Add(-20 * time.Minute).Format(time.RFC3339)}}}
	events := []json.RawMessage{}
	for _, at := range []time.Time{now.Add(-15 * time.Minute), now.Add(-time.Minute)} {
		raw, _ := json.Marshal(map[string]any{"type": "activity", "attemptId": "run", "at": at.Format(time.RFC3339), "summary": "Still waiting"})
		events = append(events, raw)
	}
	health := Health(task, events, now)
	if health["state"] != "quiet" || health["quiet"] != true {
		t.Fatalf("repetition counted as progress: %#v", health)
	}
	raw, _ := json.Marshal(map[string]any{"type": "check_evidence", "attemptId": "run", "at": now.Format(time.RFC3339), "summary": "Check started", "checks": []any{map[string]any{"status": "running"}}})
	events = append(events, raw)
	if health = Health(task, events, now); health["state"] != "checking" {
		t.Fatal("running check not visible")
	}
	task["status"] = "awaiting_plan"
	if health = Health(task, events, now); health["summary"] != "Waiting for an approach" || health["quiet"] != false {
		t.Fatal("gate mislabeled as quiet")
	}
}

func TestHealthCountsDistinctToolOperationsAsProgress(t *testing.T) {
	now := time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC)
	task := map[string]any{"id": "task", "status": "running", "attempts": []any{map[string]any{"id": "run", "stage": "investigate", "status": "running", "startedAt": now.Add(-20 * time.Minute).Format(time.RFC3339)}}}
	events := []json.RawMessage{}
	for i, file := range []string{"first.go", "second.go"} {
		raw, _ := json.Marshal(map[string]any{"type": "activity", "attemptId": "run", "at": now.Add(time.Duration(-15+14*i) * time.Minute).Format(time.RFC3339), "kind": "tool", "summary": "Read file", "details": file})
		events = append(events, raw)
	}
	if health := Health(task, events, now); health["quiet"] != false || health["lastAt"] != now.Add(-time.Minute).Format(time.RFC3339) {
		t.Fatalf("distinct tool operations lost: %#v", health)
	}
}
