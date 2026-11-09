package task

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"relay.local/relay/internal/store"
	"testing"
	"time"
)

func TestServiceCreatesDraftAndEvent(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := Service{Store: db, Now: func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }}
	created, err := s.Create(map[string]any{"title": "Example", "demo": true}, Defaults())
	if err != nil {
		t.Fatal(err)
	}
	id := textValue(created["id"])
	raw, err := db.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]any
	if err = json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	if created["updatedAt"] != stored["updatedAt"] {
		t.Fatal("creation response did not match persisted task")
	}
	if stored["status"] != "draft" || stored["stage"] != "triage" {
		t.Fatalf("bad draft %s", raw)
	}
	events, err := db.Events(id, 0, 1000)
	if err != nil || len(events) != 1 {
		t.Fatalf("events %s: %v", events, err)
	}
}
func TestInsertNeverOverwritesExistingTask(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	original := json.RawMessage(`{"id":"same","title":"original"}`)
	if _, err = db.InsertTask(original, nil); err != nil {
		t.Fatal(err)
	}
	before, _ := db.Get("same")
	if _, err = db.InsertTask(json.RawMessage(`{"id":"same","title":"replacement"}`), json.RawMessage(`{"type":"created"}`)); !errors.Is(err, store.ErrTaskExists) {
		t.Fatalf("duplicate: %v", err)
	}
	after, _ := db.Get("same")
	if string(before) != string(after) {
		t.Fatal("existing task overwritten")
	}
	events, _ := db.Events("same", 0, 1000)
	if len(events) != 0 {
		t.Fatal("duplicate emitted event")
	}
}
func TestInvalidDraftDoesNotPersist(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = (Service{Store: db}).Create(map[string]any{"title": "", "demo": true}, Defaults()); err == nil {
		t.Fatal("invalid title accepted")
	}
	tasks, err := db.All()
	if err != nil || len(tasks) != 0 {
		t.Fatalf("invalid task persisted: %d %v", len(tasks), err)
	}
}
