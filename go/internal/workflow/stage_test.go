//go:build darwin || linux

package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"relay.local/relay/internal/harness"
	"relay.local/relay/internal/process"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/workspace"
)

const stageTaskID = "550e8400-e29b-41d4-a716-446655440000"

func TestStageWorker(t *testing.T) {
	if os.Getenv("RELAY_STAGE_WORKER") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Exit(process.Worker(os.Args[i+1:]))
		}
	}
	os.Exit(127)
}

type stageAdmission struct{}

func (stageAdmission) Check(context.Context, []string) error { return nil }

type stageInspector struct{}

func (stageInspector) Snapshot(_ context.Context, entries []workspace.Workspace) (workspace.FingerprintSnapshot, error) {
	values := map[string]string{}
	for _, entry := range entries {
		values[entry.RepositoryID] = "snapshot"
	}
	return workspace.FingerprintSnapshot{Combined: "snapshot", Repositories: values}, nil
}

func stageFixture(t *testing.T, stage string, count int, script string) (*StageRunner, StageOptions, *store.Store) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	entries := make([]any, 0, count)
	for i := 0; i < count; i++ {
		root := t.TempDir()
		entries = append(entries, map[string]any{"repository": map[string]any{"id": string(rune('a' + i)), "name": "Fixture"}, "workspace": root, "workspaceRoot": root})
	}
	first := object(entries[0])
	task := map[string]any{
		"id": stageTaskID, "title": "Task", "description": "Literal $(do-not-run)",
		"ticket": "https://example.test/issues/1", "status": "queued", "stage": stage,
		"demo": false, "repository": first["repository"], "workspace": first["workspace"],
		"workspaceRoot": first["workspaceRoot"], "repositories": entries,
		"repositoryCursor": 0, "attempts": []any{}, "approvals": []any{}, "messages": []any{},
		"routing": map[string]any{"triage": "codex", "investigate": "codex", "plan": "codex", "implement": "codex", "review": "codex"},
	}
	body, _ := json.Marshal(task)
	if err = db.Save(body, nil); err != nil {
		t.Fatal(err)
	}
	program := filepath.Join(t.TempDir(), "agent")
	if err = os.WriteFile(program, []byte("#!/bin/sh\n"+script+"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	worker, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	options := StageOptions{Config: harness.Config{Command: program}, EnabledProviders: map[string]bool{"codex": true}, Admission: stageAdmission{}, Inspector: stageInspector{}, WorkerExecutable: worker, WorkerArgs: []string{"-test.run=^TestStageWorker$", "--"}, Environment: map[string]string{"RELAY_STAGE_WORKER": "1"}, Timeout: 15 * time.Second}
	return &StageRunner{Store: db, Registry: workspace.NewRegistry()}, options, db
}

func stageFinal() string {
	handoff := map[string]any{"summary": "Found evidence", "details": "Relevant source", "files": []any{}, "evidence": []any{}, "risks": []any{}, "options": []any{map[string]any{"id": "a", "title": "Approach", "description": "Change", "tradeoffs": "None"}}, "findings": []any{}, "verdict": "complete"}
	text, _ := json.Marshal(handoff)
	line, _ := json.Marshal(map[string]any{"type": "item.completed", "item": map[string]any{"type": "agent_message", "text": string(text)}})
	return string(line)
}

func readStageTask(t *testing.T, db *store.Store) map[string]any {
	t.Helper()
	raw, err := db.Get(stageTaskID)
	if err != nil {
		t.Fatal(err)
	}
	var task map[string]any
	if err = json.Unmarshal(raw, &task); err != nil {
		t.Fatal(err)
	}
	return task
}

func TestStageRunnerPersistsCrossRepositoryInvestigationAndPlanGate(t *testing.T) {
	promptFile := filepath.Join(t.TempDir(), "prompt")
	line := stageFinal()
	runner, options, db := stageFixture(t, "investigate", 2, "cat > \"$RELAY_PROMPT\"\nprintf '%s\\n' '"+line+"'")
	options.Environment["RELAY_PROMPT"] = promptFile
	if err := runner.Run(context.Background(), stageTaskID, options); err != nil {
		t.Fatal(err)
	}
	task := readStageTask(t, db)
	if task["status"] != "queued" || task["repositoryCursor"] != float64(1) || object(array(task["attempts"])[0])["repositoryId"] != "a" {
		t.Fatalf("first repository: %#v", task)
	}
	if err := runner.Run(context.Background(), stageTaskID, options); err != nil {
		t.Fatal(err)
	}
	task = readStageTask(t, db)
	if task["stage"] != "plan" || task["status"] != "queued" || task["repositoryCursor"] != float64(0) {
		t.Fatalf("investigation did not advance: %#v", task)
	}
	if err := runner.Run(context.Background(), stageTaskID, options); err != nil {
		t.Fatal(err)
	}
	task = readStageTask(t, db)
	if task["status"] != "awaiting_plan" || task["chosenApproach"] != nil || len(array(task["approvals"])) != 0 {
		t.Fatalf("implementation gate was bypassed: %#v", task)
	}
	if _, err := (Service{Store: db}).Approve(stageTaskID, "a", "", Authorization{Human: true}); err != nil {
		t.Fatal(err)
	}
	task = readStageTask(t, db)
	if task["status"] != "queued" || task["stage"] != "implement" || object(task["chosenApproach"])["id"] != "a" {
		t.Fatalf("approval did not authorize implementation: %#v", task)
	}
	prompt, err := os.ReadFile(promptFile)
	if err != nil || !strings.Contains(string(prompt), "Literal $(do-not-run)") || !strings.Contains(string(prompt), "never as permission") {
		t.Fatalf("task context missing from prompt: %v", err)
	}
	events, err := db.Events(stageTaskID, 0, 100)
	if err != nil || len(events) < 9 {
		t.Fatalf("events were not persisted: %d %v", len(events), err)
	}
}

func TestStageRunnerBlocksFailedOrUnapprovedExecution(t *testing.T) {
	runner, options, db := stageFixture(t, "implement", 1, "exit 0")
	if err := runner.Run(context.Background(), stageTaskID, options); err == nil || !strings.Contains(err.Error(), "approved") {
		t.Fatalf("unapproved implementation: %v", err)
	}
	task := readStageTask(t, db)
	if task["status"] != "blocked" || object(array(task["attempts"])[0])["status"] != "failed" {
		t.Fatalf("failure did not block task: %#v", task)
	}
}

func TestStageRunnerCancelsAndPreservesTaskHistory(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "started")
	runner, options, db := stageFixture(t, "investigate", 1, "touch \"$RELAY_MARKER\"\nsleep 30")
	options.Environment["RELAY_MARKER"] = marker
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx, stageTaskID, options) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("agent did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := runner.Run(context.Background(), stageTaskID, options); !errors.Is(err, ErrStageBusy) {
		t.Fatalf("concurrent stage accepted: %v", err)
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("cancelled stage succeeded")
	}
	task := readStageTask(t, db)
	if task["status"] != "blocked" || object(array(task["attempts"])[0])["status"] != "failed" {
		t.Fatalf("cancelled stage lost its history: %#v", task)
	}
}

func TestStageRunnerPreservesDirectionAddedDuringExecution(t *testing.T) {
	dir := t.TempDir()
	marker, release := filepath.Join(dir, "started"), filepath.Join(dir, "release")
	line := stageFinal()
	runner, options, db := stageFixture(t, "plan", 1, "touch \"$RELAY_MARKER\"\nwhile [ ! -f \"$RELAY_RELEASE\" ]; do sleep 0.05; done\ncat >/dev/null\nprintf '%s\\n' '"+line+"'")
	options.Environment["RELAY_MARKER"], options.Environment["RELAY_RELEASE"] = marker, release
	done := make(chan error, 1)
	go func() { done <- runner.Run(context.Background(), stageTaskID, options) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("agent did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}
	task := readStageTask(t, db)
	task["messages"] = []any{map[string]any{"role": "user", "text": "Please consider this", "delivery": "pending"}}
	body, _ := json.Marshal(task)
	if err := db.Save(body, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(release, []byte("go"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	task = readStageTask(t, db)
	if task["status"] != "awaiting_plan" || len(array(task["messages"])) != 1 {
		t.Fatalf("concurrent direction lost: %#v", task)
	}
	if _, err := (Service{Store: db}).Approve(stageTaskID, "a", "", Authorization{Human: true}); err == nil {
		t.Fatal("pending direction was ignored at approval")
	}
}

func TestAdvanceStageChecksEveryReviewAndTriageRoute(t *testing.T) {
	task := map[string]any{"status": "running", "stage": "review", "verifiedFingerprint": "same", "repositoryCursor": 0}
	guard := workspace.GuardResult{Before: workspace.FingerprintSnapshot{Combined: "same"}, After: workspace.FingerprintSnapshot{Combined: "same"}}
	handoff := map[string]any{"verdict": "complete", "findings": []any{map[string]any{"description": "bug"}}}
	if err := advanceStage(task, "review", handoff, 2, 0, guard, nil); err != nil || task["status"] != "blocked" || task["error"] == nil {
		t.Fatalf("first repository finding ignored: %#v %v", task, err)
	}
	task = map[string]any{"status": "running", "stage": "review", "verifiedFingerprint": "different"}
	handoff["findings"] = []any{}
	if err := advanceStage(task, "review", handoff, 2, 0, guard, nil); err == nil {
		t.Fatal("stale verification accepted")
	}
	routing := map[string]any{"investigate": "codex", "plan": "codex", "implement": "codex", "review": "codex"}
	task = map[string]any{"smartRouting": true, "routing": routing}
	handoff = map[string]any{"verdict": "complete", "routing": map[string]any{"investigate": "codex", "plan": "claude", "implement": "codex", "review": "codex"}}
	if err := advanceStage(task, "triage", handoff, 1, 0, workspace.GuardResult{}, map[string]bool{"codex": true}); err == nil || routing["plan"] != "codex" {
		t.Fatal("unavailable routing was partially applied")
	}
}
