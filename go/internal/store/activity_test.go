package store

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
)

func TestRecentActivityDoesNotMoveProgressOnIdenticalHeartbeats(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for i := 0; i < 300; i++ {
		raw, _ := json.Marshal(map[string]any{"type": "activity", "attemptId": "run", "at": i, "summary": "Same operation"})
		if _, err := db.Event("task", raw); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := db.RecentActivity("task")
	if err != nil || len(rows) != 1 {
		t.Fatalf("duplicate activity survived: %d %v", len(rows), err)
	}
	var first map[string]any
	json.Unmarshal(rows[0], &first)
	if first["at"] != float64(0) {
		t.Fatal("heartbeat moved meaningful time")
	}
	for _, file := range []string{"one.go", "two.go"} {
		raw, _ := json.Marshal(map[string]any{"type": "activity", "attemptId": "run", "summary": "Read file", "details": file})
		if _, err := db.Event("task", raw); err != nil {
			t.Fatal(err)
		}
	}
	if rows, err = db.RecentActivity("task"); err != nil || len(rows) != 3 {
		t.Fatalf("distinct tool operations collapsed: %d %v", len(rows), err)
	}
}

func TestRecentActivityKeepsTheLatestDistinctOperations(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for i := 0; i < 250; i++ {
		for repeat := 0; repeat < 2; repeat++ {
			raw, _ := json.Marshal(map[string]any{"type": "activity", "summary": fmt.Sprintf("Operation %d", i), "at": i*2 + repeat})
			if _, err = db.Event("task", raw); err != nil {
				t.Fatal(err)
			}
		}
	}
	rows, err := db.RecentActivity("task")
	if err != nil || len(rows) != 200 {
		t.Fatalf("invalid page: %d %v", len(rows), err)
	}
	for index, raw := range rows {
		var event map[string]any
		json.Unmarshal(raw, &event)
		if event["at"] != float64((index+50)*2) {
			t.Fatalf("lost boundary or first clock: %s", raw)
		}
	}
}
