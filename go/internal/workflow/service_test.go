package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/workspace"
	"testing"
	"time"
)

type racingStore struct {
	*store.Store
	beforeCommit func()
}

func (s racingStore) CompareAndSwapWithMeta(id string, expected, next, event json.RawMessage, guards map[string]store.MetaSnapshot) (json.RawMessage, error) {
	if s.beforeCommit != nil {
		s.beforeCommit()
	}
	return s.Store.CompareAndSwapWithMeta(id, expected, next, event, guards)
}
func saved(t *testing.T, db *store.Store, task map[string]any) {
	t.Helper()
	raw, err := json.Marshal(task)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Save(raw, nil); err != nil {
		t.Fatal(err)
	}
}
func TestDecisionServiceCommitsApproachAndEvent(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	saved(t, db, planTask())
	service := Service{Store: db, Now: func() time.Time { return time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC) }}
	result, err := service.Approve("task", "a", "note", Authorization{Human: true})
	if err != nil {
		t.Fatal(err)
	}
	var task map[string]any
	if err = json.Unmarshal(result, &task); err != nil {
		t.Fatal(err)
	}
	if task["status"] != "queued" || task["stage"] != "implement" {
		t.Fatalf("task: %s", result)
	}
	events, err := db.Events("task", 0, 1000)
	if err != nil || len(events) != 1 {
		t.Fatalf("events: %s %v", events, err)
	}
}
func TestDecisionServiceRejectsRevokedAutoRace(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	saved(t, db, planTask())
	key := "automation:task"
	if err = db.SetMeta(key, `{"enabled":true,"scope":"reviewed","authorizationId":"current"}`); err != nil {
		t.Fatal(err)
	}
	service := Service{Store: racingStore{Store: db, beforeCommit: func() {
		if err := db.SetMeta(key, `{"enabled":false,"scope":"reviewed","authorizationId":"changed"}`); err != nil {
			t.Error(err)
		}
	}}}
	if _, err = service.Approve("task", "a", "", Authorization{AutomationID: "current", Scope: "reviewed"}); !errors.Is(err, store.ErrMetadataChanged) {
		t.Fatalf("revocation: %v", err)
	}
	raw, _ := db.Get("task")
	var task map[string]any
	_ = json.Unmarshal(raw, &task)
	if task["status"] != "awaiting_plan" {
		t.Fatal("revoked decision committed")
	}
	events, _ := db.Events("task", 0, 1000)
	if len(events) != 0 {
		t.Fatal("revoked decision emitted event")
	}
}
func TestDecisionServiceRejectsConcurrentTaskChanges(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	saved(t, db, planTask())
	service := Service{Store: racingStore{Store: db, beforeCommit: func() { task := planTask(); task["title"] = "updated"; saved(t, db, task) }}}
	if _, err = service.Approve("task", "a", "", Authorization{Human: true}); !errors.Is(err, store.ErrTaskChanged) {
		t.Fatalf("stale decision: %v", err)
	}
	events, _ := db.Events("task", 0, 1000)
	if len(events) != 0 {
		t.Fatal("stale approval emitted event")
	}
}

type fakeInspector struct {
	snapshot workspace.FingerprintSnapshot
	onScan   func()
	calls    int
}

func (f *fakeInspector) Snapshot(_ context.Context, _ []workspace.Workspace) (workspace.FingerprintSnapshot, error) {
	f.calls++
	if f.onScan != nil {
		f.onScan()
	}
	return f.snapshot, nil
}
func taskWithRoots(t *testing.T) (map[string]any, []string) {
	t.Helper()
	task := finalTask()
	one, two := t.TempDir(), t.TempDir()
	entries := array(task["repositories"])
	object(entries[0])["workspaceRoot"] = one
	object(entries[1])["workspaceRoot"] = two
	return task, []string{one, two}
}
func TestDecisionServiceAcceptsOnlyVerifiedCrossRepoSnapshot(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	task, roots := taskWithRoots(t)
	saved(t, db, task)
	service := Service{Store: db}
	registry := workspace.NewRegistry()
	lease, err := registry.Acquire("task", roots)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	inspector := &fakeInspector{snapshot: workspace.FingerprintSnapshot{Combined: "changed", Repositories: map[string]string{"one": "f1", "two": "f2"}}}
	if _, err = service.AcceptVerified(context.Background(), "task", Authorization{Human: true}, lease, inspector); err == nil {
		t.Fatal("stale review accepted")
	}
	inspector.snapshot.Combined = "combined"
	result, err := service.AcceptVerified(context.Background(), "task", Authorization{Human: true}, lease, inspector)
	if err != nil {
		t.Fatal(err)
	}
	var resultTask map[string]any
	_ = json.Unmarshal(result, &resultTask)
	if resultTask["status"] != "completed" {
		t.Fatalf("status %s", result)
	}
}
func TestDecisionServiceRejectsReplacedWorkspaceDuringInspection(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	task, roots := taskWithRoots(t)
	saved(t, db, task)
	registry := workspace.NewRegistry()
	lease, err := registry.Acquire("task", roots)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	inspector := &fakeInspector{snapshot: workspace.FingerprintSnapshot{Combined: "combined", Repositories: map[string]string{"one": "f1", "two": "f2"}}, onScan: func() {
		if err := os.Rename(roots[0], roots[0]+"-old"); err != nil {
			t.Error(err)
		}
		if err := os.Mkdir(roots[0], 0700); err != nil {
			t.Error(err)
		}
	}}
	if _, err = (Service{Store: db}).AcceptVerified(context.Background(), "task", Authorization{Human: true}, lease, inspector); !errors.Is(err, workspace.ErrInvalidLease) {
		t.Fatalf("replaced workspace: %v", err)
	}
	raw, _ := db.Get("task")
	var current map[string]any
	_ = json.Unmarshal(raw, &current)
	if current["status"] != "awaiting_final" {
		t.Fatal("replaced workspace was accepted")
	}
}
func TestDecisionServiceRejectsWrongOwnerBeforeScanning(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	task, roots := taskWithRoots(t)
	saved(t, db, task)
	lease, err := workspace.NewRegistry().Acquire("other", roots)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	inspector := &fakeInspector{}
	if _, err = (Service{Store: db}).AcceptVerified(context.Background(), "task", Authorization{Human: true}, lease, inspector); !errors.Is(err, workspace.ErrInvalidLease) {
		t.Fatalf("wrong owner: %v", err)
	}
	if inspector.calls != 0 {
		t.Fatal("scanned without a lease")
	}
}

func TestDecisionServiceRejectsAutoRevokedDuringInspection(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	task, roots := taskWithRoots(t)
	saved(t, db, task)
	key := "automation:task"
	if err = db.SetMeta(key, `{"enabled":true,"scope":"reviewed","authorizationId":"current"}`); err != nil {
		t.Fatal(err)
	}
	lease, err := workspace.NewRegistry().Acquire("task", roots)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	inspector := &fakeInspector{snapshot: workspace.FingerprintSnapshot{Combined: "combined", Repositories: map[string]string{"one": "f1", "two": "f2"}}, onScan: func() {
		if err := db.SetMeta(key, `{"enabled":false,"scope":"reviewed","authorizationId":"revoked"}`); err != nil {
			t.Error(err)
		}
	}}
	_, err = (Service{Store: db}).AcceptVerified(context.Background(), "task", Authorization{AutomationID: "current", Scope: "reviewed"}, lease, inspector)
	if !errors.Is(err, store.ErrMetadataChanged) {
		t.Fatalf("revoked during inspection: %v", err)
	}
	raw, _ := db.Get("task")
	var current map[string]any
	_ = json.Unmarshal(raw, &current)
	if current["status"] != "awaiting_final" {
		t.Fatal("revoked Auto accepted task")
	}
}

func TestDecisionServiceRejectsNilInspectorAndCancellation(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	task, roots := taskWithRoots(t)
	saved(t, db, task)
	lease, err := workspace.NewRegistry().Acquire("task", roots)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	var inspector *fakeInspector
	if _, err = (Service{Store: db}).AcceptVerified(context.Background(), "task", Authorization{Human: true}, lease, inspector); err == nil {
		t.Fatal("nil inspector accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	inspector = &fakeInspector{snapshot: workspace.FingerprintSnapshot{Combined: "combined", Repositories: map[string]string{"one": "f1", "two": "f2"}}, onScan: cancel}
	if _, err = (Service{Store: db}).AcceptVerified(ctx, "task", Authorization{Human: true}, lease, inspector); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled scan: %v", err)
	}
}
