package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
)

func TestCompareAndSwapRejectsStaleConcurrentUpdates(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Save(task("id", "before"), nil); err != nil {
		t.Fatal(err)
	}
	original, err := s.Get("id")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := s.CompareAndSwap("id", original, task("id", fmt.Sprint(i)), json.RawMessage(`{"type":"approval"}`))
			results <- err
		}(i)
	}
	wg.Wait()
	close(results)
	success, stale := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrTaskChanged) {
			stale++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || stale != 19 {
		t.Fatalf("success %d stale %d", success, stale)
	}
	events, err := s.Events("id", 0, 1000)
	if err != nil || len(events) != 1 {
		t.Fatalf("events %d: %v", len(events), err)
	}
}
func TestCompareAndSwapPreservesIdentityAndRejectsMissing(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Save(task("id", "before"), nil); err != nil {
		t.Fatal(err)
	}
	original, _ := s.Get("id")
	if _, err = s.CompareAndSwap("id", original, task("other", "after"), nil); err == nil {
		t.Fatal("identity change accepted")
	}
	current, _ := s.Get("id")
	if string(current) != string(original) {
		t.Fatal("identity failure mutated task")
	}
	if _, err = s.CompareAndSwap("missing", nil, task("missing", "x"), nil); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing task: %v", err)
	}
}

func TestCompareAndSwapRollsBackWhenEventFails(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required to generate fixture")
	}
	dir := t.TempDir()
	if err = os.WriteFile(filepath.Join(dir, markerName), []byte(markerContent), 0600); err != nil {
		t.Fatal(err)
	}
	js := `import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,body TEXT NOT NULL); CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'event rejected'); END;");db.prepare('INSERT INTO tasks(id,body) VALUES(?,?)').run('id',JSON.stringify({id:'id',title:'before'}));db.close();`
	if output, err := exec.Command(node, "--input-type=module", "-e", js, filepath.Join(dir, "relay.sqlite")).CombinedOutput(); err != nil {
		t.Fatalf("fixture %s: %v", output, err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	original, err := s.Get("id")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.CompareAndSwap("id", original, task("id", "after"), json.RawMessage(`{"type":"approval"}`)); err == nil {
		t.Fatal("event failure accepted")
	}
	current, err := s.Get("id")
	if err != nil || string(current) != string(original) {
		t.Fatalf("rollback lost original: %s %v", current, err)
	}
}

func TestCompareAndSwapRejectsRevokedMetadata(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Save(task("id", "before"), nil); err != nil {
		t.Fatal(err)
	}
	original, _ := s.Get("id")
	key := "automation:id"
	if err = s.SetMeta(key, `{"enabled":true,"authorizationId":"old"}`); err != nil {
		t.Fatal(err)
	}
	value, exists, err := s.GetMeta(key)
	if err != nil {
		t.Fatal(err)
	}
	guards := map[string]MetaSnapshot{key: {Value: value, Exists: exists}}
	if err = s.SetMeta(key, `{"enabled":false,"authorizationId":"new"}`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CompareAndSwapWithMeta("id", original, task("id", "after"), json.RawMessage(`{"type":"approval"}`), guards); !errors.Is(err, ErrMetadataChanged) {
		t.Fatalf("revoked delegation: %v", err)
	}
	current, _ := s.Get("id")
	if string(current) != string(original) {
		t.Fatal("revoked delegation mutated task")
	}
	events, err := s.Events("id", 0, 1000)
	if err != nil || len(events) != 0 {
		t.Fatalf("event created: %s %v", events, err)
	}
}
func TestCompareAndSwapDistinguishesMissingFromEmptyMetadata(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Save(task("id", "before"), nil); err != nil {
		t.Fatal(err)
	}
	original, _ := s.Get("id")
	if err = s.SetMeta("key", ""); err != nil {
		t.Fatal(err)
	}
	_, err = s.CompareAndSwapWithMeta("id", original, task("id", "after"), nil, map[string]MetaSnapshot{"key": {Exists: false}})
	if !errors.Is(err, ErrMetadataChanged) {
		t.Fatalf("missing and empty metadata treated alike: %v", err)
	}
}
