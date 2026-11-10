package memory

import (
	"path/filepath"
	"relay.local/relay/internal/store"
	"testing"
)

func TestApprovalScopeExpiryAndStaleMemoryEdits(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	body := map[string]any{"scope": "project", "targetId": "repo", "kind": "observation", "title": "Build", "content": "Use the documented checks", "status": "active"}
	proposed, err := Save(db, "", body, true)
	if err != nil {
		t.Fatal(err)
	}
	if rows, _ := Select(db, "task", []string{"repo"}); len(rows) != 0 {
		t.Fatal("agent suggestion was active")
	}
	approved, err := Save(db, proposed.ID, map[string]any{"revision": float64(proposed.Revision), "status": "active"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if rows, _ := Select(db, "task", []string{"repo"}); len(rows) != 1 {
		t.Fatal("approved scoped memory missing")
	}
	if rows, _ := Select(db, "task", []string{"other"}); len(rows) != 0 {
		t.Fatal("project memory escaped scope")
	}
	if _, err = Save(db, proposed.ID, map[string]any{"revision": float64(proposed.Revision), "status": "disabled"}, false); err == nil {
		t.Fatal("stale update accepted")
	}
	if err = Delete(db, approved.ID, approved.Revision); err != nil {
		t.Fatal(err)
	}
	if rows, _ := Select(db, "task", []string{"repo"}); len(rows) != 0 {
		t.Fatal("deleted memory was active")
	}
}

func TestDeleteErasesRecordAndStalePatchCannotRecreate(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	row, err := Save(db, "", map[string]any{"title": "Preference", "content": "private observation"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if err = Delete(db, row.ID, row.Revision+1); err == nil {
		t.Fatal("stale delete accepted")
	}
	if err = Delete(db, row.ID, row.Revision); err != nil {
		t.Fatal(err)
	}
	if _, exists, _ := db.GetMeta("memory:" + row.ID); exists {
		t.Fatal("deleted data retained")
	}
	if _, err = Save(db, row.ID, map[string]any{"revision": float64(row.Revision), "title": "Resurrect", "content": "x"}, false); err == nil {
		t.Fatal("stale update resurrected memory")
	}
	if _, err = Save(db, "", map[string]any{"revision": float64(99), "title": "Forged", "content": "x"}, false); err == nil {
		t.Fatal("create accepted revision injection")
	}
}
