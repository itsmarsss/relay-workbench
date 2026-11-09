package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
)

func TestMetadataPreservesRawReceiptsAndLiteralPrefixes(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for key, value := range map[string]string{"memory:1": `{"title":"kept"}`, "quiet:1": "2026-01-01T00:00:00Z", "literal%_x": "one", "literalANYx": "other", "Memory:2": "different case"} {
		if err = s.SetMeta(key, value); err != nil {
			t.Fatal(err)
		}
	}
	value, exists, err := s.GetMeta("quiet:1")
	if err != nil || !exists || value != "2026-01-01T00:00:00Z" {
		t.Fatalf("receipt: %q %v %v", value, exists, err)
	}
	entries, err := s.ListMeta("literal%_")
	if err != nil || len(entries) != 1 || entries[0].Value != "one" {
		t.Fatalf("prefix: %#v %v", entries, err)
	}
	caseEntries, err := s.ListMeta("memory:")
	if err != nil || len(caseEntries) != 1 || caseEntries[0].Key != "memory:1" {
		t.Fatalf("case-sensitive prefix: %#v %v", caseEntries, err)
	}
	if err = s.DeleteMeta("memory:1"); err != nil {
		t.Fatal(err)
	}
	if _, exists, err = s.GetMeta("memory:1"); err != nil || exists {
		t.Fatalf("deleted metadata: %v %v", exists, err)
	}
}
func TestMetadataUpdatesAreAtomic(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var wg sync.WaitGroup
	failures := make(chan error, 40)
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			failures <- s.UpdateMeta("counter", func(value string, exists bool) (string, error) {
				n := 0
				if exists {
					n, _ = strconv.Atoi(value)
				}
				return strconv.Itoa(n + 1), nil
			})
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	value, _, err := s.GetMeta("counter")
	if err != nil || value != "40" {
		t.Fatalf("counter %q %v", value, err)
	}
	sentinel := errors.New("no update")
	if err = s.UpdateMeta("counter", func(string, bool) (string, error) { return "", sentinel }); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	if value, _, _ = s.GetMeta("counter"); value != "40" {
		t.Fatal("failed update persisted")
	}
}
func TestEventOnlyAndDeleteTaskKeepOtherTasks(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Save(task("one", "first"), nil); err != nil {
		t.Fatal(err)
	}
	if err = s.Save(task("two", "second"), nil); err != nil {
		t.Fatal(err)
	}
	event, err := s.Event("one", json.RawMessage(`{"type":"activity","summary":"hello"}`))
	if err != nil {
		t.Fatal(err)
	}
	var entry map[string]any
	if err = json.Unmarshal(event, &entry); err != nil || entry["seq"] != float64(1) || entry["taskId"] != "one" {
		t.Fatalf("event %s %v", event, err)
	}
	if err = s.DeleteTask("one"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Get("one"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("task not deleted")
	}
	events, err := s.Events("one", 0, 1000)
	if err != nil || len(events) != 0 {
		t.Fatalf("events not removed: %s %v", events, err)
	}
	if _, err = s.Get("two"); err != nil {
		t.Fatal("unrelated task deleted")
	}
}
