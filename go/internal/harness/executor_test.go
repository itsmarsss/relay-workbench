//go:build darwin || linux

package harness

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"relay.local/relay/internal/process"
	"relay.local/relay/internal/storage"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/workspace"
)

const taskID = "550e8400-e29b-41d4-a716-446655440000"
const attemptID = "550e8400-e29b-41d4-a716-446655440001"

func TestExecutorWorker(t *testing.T) {
	if os.Getenv("RELAY_EXECUTOR_WORKER") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Exit(process.Worker(os.Args[i+1:]))
		}
	}
	os.Exit(127)
}

type fakeAdmission struct{ err error }

func (a fakeAdmission) Check(context.Context, []string) error { return a.err }

type fakeInspector struct {
	snapshots []workspace.FingerprintSnapshot
	index     int
}

func (f *fakeInspector) Snapshot(context.Context, []workspace.Workspace) (workspace.FingerprintSnapshot, error) {
	if f.index >= len(f.snapshots) {
		return workspace.FingerprintSnapshot{}, errors.New("unexpected scan")
	}
	value := f.snapshots[f.index]
	f.index++
	return value, nil
}
func fixture(t *testing.T, stage, script string) (RunRequest, *store.Store) {
	t.Helper()
	root := t.TempDir()
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	route := map[string]any{stage: "codex"}
	task := map[string]any{"id": taskID, "status": "running", "stage": stage, "routing": route, "demo": false, "repository": map[string]any{"id": "repo"}, "workspaceRoot": root, "workspace": root}
	if stage == "implement" || stage == "review" {
		task["chosenApproach"] = map[string]any{"id": "approved"}
		task["approvals"] = []any{map[string]any{"type": "approach", "option": map[string]any{"id": "approved"}}}
	}
	raw, _ := json.Marshal(task)
	if err = db.Save(raw, nil); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(t.TempDir(), "fake-agent")
	if err = os.WriteFile(executable, []byte("#!/bin/sh\n"+script+"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	worker, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	lease, err := workspace.NewRegistry().Acquire(taskID, []string{root})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lease.Release)
	snap := workspace.FingerprintSnapshot{Combined: "same", Repositories: map[string]string{"repo": "same"}}
	return RunRequest{Store: db, TaskID: taskID, AttemptID: attemptID, Stage: stage, Provider: "codex", Config: Config{Command: executable}, Prompt: "untrusted ticket text $(not executed)", Cwd: root, ActiveRepositoryID: "repo", Workspaces: []workspace.Workspace{{RepositoryID: "repo", Root: root}}, Lease: lease, Admission: fakeAdmission{}, Inspector: &fakeInspector{snapshots: []workspace.FingerprintSnapshot{snap, snap}}, WorkerExecutable: worker, WorkerArgs: []string{"-test.run=^TestExecutorWorker$", "--"}, Environment: map[string]string{"RELAY_EXECUTOR_WORKER": "1"}, Timeout: 10 * time.Second, OnEvent: func(context.Context, map[string]any) error { return nil }}, db
}
func validFinal() string {
	value := map[string]any{"summary": "Done", "details": "Evidence", "files": []any{}, "evidence": []any{}, "risks": []any{}, "options": []any{map[string]any{"id": "a", "title": "A", "description": "Do it", "tradeoffs": "None"}}, "findings": []any{}, "verdict": "complete"}
	raw, _ := json.Marshal(value)
	event, _ := json.Marshal(map[string]any{"type": "item.completed", "item": map[string]any{"type": "agent_message", "text": string(raw)}})
	return string(event)
}
func TestExecuteStreamsAndPreservesValidatedArtifacts(t *testing.T) {
	line := validFinal()
	request, db := fixture(t, "plan", "cat >/dev/null\nprintf '%s\\n' '"+line+"'")
	var mu sync.Mutex
	events := []map[string]any{}
	request.OnEvent = func(_ context.Context, event map[string]any) error {
		raw, err := json.Marshal(event)
		if err != nil {
			return err
		}
		if _, err = db.Event(taskID, raw); err != nil {
			return err
		}
		mu.Lock()
		defer mu.Unlock()
		events = append(events, event)
		return nil
	}
	result, err := Execute(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(result.Handoff) || result.Guard.Before.Combined != "same" || result.Guard.After.Combined != "same" {
		t.Fatalf("result %#v", result)
	}
	if len(events) < 2 {
		t.Fatalf("missing transcript or activity: %#v", events)
	}
	persisted, err := db.Events(taskID, 0, 100)
	if err != nil || len(persisted) != len(events) {
		t.Fatalf("streamed events were not persisted: %d, %v", len(persisted), err)
	}
	for _, name := range []string{"prompt.txt", "handoff.schema.json", "stdout.jsonl", "stderr.txt", "handoff.json"} {
		info, err := os.Stat(filepath.Join(result.ArtifactDirectory, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatalf("artifact mode %s", info.Mode())
		}
	}
}
func TestExecuteBlocksUnapprovedOrLowSpaceBeforeAgentStarts(t *testing.T) {
	request, db := fixture(t, "implement", "exit 0")
	raw, _ := db.Get(taskID)
	var task map[string]any
	_ = json.Unmarshal(raw, &task)
	task["chosenApproach"] = nil
	updated, _ := json.Marshal(task)
	if err := db.Save(updated, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := Execute(context.Background(), request); err == nil || !strings.Contains(err.Error(), "approved") {
		t.Fatalf("unapproved execution: %v", err)
	}
	task["chosenApproach"] = map[string]any{"id": "approved"}
	task["approvals"] = []any{map[string]any{"type": "approach", "option": map[string]any{"id": "different"}}}
	updated, _ = json.Marshal(task)
	if err := db.Save(updated, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := Execute(context.Background(), request); err == nil || !strings.Contains(err.Error(), "approved") {
		t.Fatalf("mismatched approval accepted: %v", err)
	}
	task["approvals"] = []any{map[string]any{"type": "approach", "option": map[string]any{"id": "approved"}}}
	updated, _ = json.Marshal(task)
	if err := db.Save(updated, nil); err != nil {
		t.Fatal(err)
	}
	request.Admission = fakeAdmission{err: storage.ErrLowSpace}
	result, err := Execute(context.Background(), request)
	if !errors.Is(err, storage.ErrLowSpace) || result.ArtifactDirectory != "" {
		t.Fatalf("low space launched agent: %#v %v", result, err)
	}
}
func TestExecuteRejectsReadOnlyWorkspaceChanges(t *testing.T) {
	request, _ := fixture(t, "plan", "cat >/dev/null\nprintf '%s\\n' '"+validFinal()+"'")
	request.Inspector = &fakeInspector{snapshots: []workspace.FingerprintSnapshot{{Combined: "before", Repositories: map[string]string{"repo": "before"}}, {Combined: "after", Repositories: map[string]string{"repo": "after"}}}}
	result, err := Execute(context.Background(), request)
	if !errors.Is(err, workspace.ErrReadOnlyChanged) || result.Handoff != nil {
		t.Fatalf("read-only mutation accepted: %#v %v", result, err)
	}
	if _, err = os.Stat(filepath.Join(result.ArtifactDirectory, "stdout.jsonl")); err != nil {
		t.Fatal("diagnostic output was lost")
	}
}
func TestExecuteRequiresStructuredFinalAndPropagatesAgentError(t *testing.T) {
	request, _ := fixture(t, "plan", "cat >/dev/null\nprintf '%s\\n' 'ordinary output'")
	result, err := Execute(context.Background(), request)
	if err == nil || result.Handoff != nil {
		t.Fatal("missing handoff accepted")
	}
	request, _ = fixture(t, "plan", "cat >/dev/null\nprintf '%s\\n' '{\"type\":\"turn.failed\",\"error\":{\"message\":\"actual failure\"}}'\nprintf '%s\\n' '"+validFinal()+"'")
	result, err = Execute(context.Background(), request)
	if err == nil || !strings.Contains(err.Error(), "actual failure") || result.Handoff != nil {
		t.Fatalf("agent error lost: %v", err)
	}
}

func TestExecuteRejectsWorkspaceSetDifferentFromTask(t *testing.T) {
	request, _ := fixture(t, "plan", "exit 0")
	request.Workspaces[0].Root = t.TempDir()
	if result, err := Execute(context.Background(), request); err == nil || result.ArtifactDirectory != "" || !strings.Contains(err.Error(), "workspace set changed") {
		t.Fatalf("different workspace accepted: %#v %v", result, err)
	}
}

func TestPublicationAgentRequiresCurrentFinalApproval(t *testing.T) {
	request, db := fixture(t, "publish", "cat >/dev/null\nprintf '%s\\n' '"+validFinal()+"'")
	request.Auxiliary = true
	raw, _ := db.Get(taskID)
	var task map[string]any
	_ = json.Unmarshal(raw, &task)
	task["status"], task["stage"] = "completed", "review"
	task["routing"] = map[string]any{"implement": "codex"}
	task["chosenApproach"] = map[string]any{"id": "a"}
	task["verifiedFingerprint"], task["reviewedFingerprint"] = "same", "same"
	task["delivery"] = map[string]any{"id": attemptID, "status": "running", "harness": "codex"}
	task["approvals"] = []any{map[string]any{"type": "approach", "option": map[string]any{"id": "a"}}}
	updated, _ := json.Marshal(task)
	if err := db.Save(updated, nil); err != nil {
		t.Fatal(err)
	}
	if result, err := Execute(context.Background(), request); err == nil || result.ArtifactDirectory != "" || !strings.Contains(err.Error(), "accepted") {
		t.Fatalf("unaccepted work published: %#v %v", result, err)
	}
	task["approvals"] = append(task["approvals"].([]any), map[string]any{"type": "final", "fingerprint": "same"})
	updated, _ = json.Marshal(task)
	if err := db.Save(updated, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := Execute(context.Background(), request); err != nil {
		t.Fatal(err)
	}
}
func TestFinalHandoffAcceptsFencesAndRejectsMalformedData(t *testing.T) {
	raw, _ := json.Marshal("```json\n{\"summary\":\"x\"}\n```")
	if _, err := finalHandoff(raw, "plan"); err == nil {
		t.Fatal("incomplete handoff accepted")
	}
	if _, err := finalHandoff(json.RawMessage(`"not-json"`), "plan"); err == nil {
		t.Fatal("invalid JSON accepted")
	}
}
