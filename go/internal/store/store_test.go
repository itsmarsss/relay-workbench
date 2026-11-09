package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func task(id, title string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"id": id, "title": title, "status": "draft", "unknown": map[string]any{"kept": true}})
	return b
}
func TestIsolatedMarkerAndExclusiveLock(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "relay.sqlite"), []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir); err == nil || !strings.Contains(err.Error(), "nonempty") {
		t.Fatalf("expected refusal: %v", err)
	}
	contents, _ := os.ReadFile(filepath.Join(dir, "relay.sqlite"))
	if string(contents) != "untouched" {
		t.Fatal("existing data changed")
	}
	empty := filepath.Join(t.TempDir(), "state")
	s, err := Open(empty)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Open(empty); err == nil {
		t.Fatal("second writer allowed")
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(empty)
	if err != nil {
		t.Fatal(err)
	}
	if err = reopened.Close(); err != nil {
		t.Fatal(err)
	}
}
func TestSaveGetEventsAndNotifications(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ch, unsubscribe := s.Subscribe()
	defer unsubscribe()
	id := "abc'; DROP TABLE tasks; --"
	if err = s.Save(task(id, "one"), json.RawMessage(`{"type":"activity","message":"hello"}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ch:
	default:
		t.Fatal("missing event notification")
	}
	got, err := s.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err = json.Unmarshal(got, &object); err != nil {
		t.Fatal(err)
	}
	if object["title"] != "one" || object["unknown"] == nil {
		t.Fatalf("lost data: %s", got)
	}
	events, err := s.Events(id, 0, 1000)
	if err != nil || len(events) != 1 {
		t.Fatalf("events: %s %v", events, err)
	}
	var event struct {
		Seq    int64  `json:"seq"`
		TaskID string `json:"taskId"`
	}
	if err = json.Unmarshal(events[0], &event); err != nil || event.Seq <= 0 || event.TaskID != id {
		t.Fatalf("bad event: %s %v", events[0], err)
	}
	if next, err := s.Events(id, event.Seq, 1000); err != nil || len(next) != 0 {
		t.Fatalf("cursor: %s %v", next, err)
	}
	if err = s.Save(task(id, "two"), json.RawMessage(`[]`)); err == nil {
		t.Fatal("invalid event accepted")
	}
	got, _ = s.Get(id)
	if !strings.Contains(string(got), `"one"`) {
		t.Fatal("invalid save changed task")
	}
	if _, err = s.Get("missing"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing: %v", err)
	}
}
func TestConcurrentSavesAreSerialized(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var wg sync.WaitGroup
	errs := make(chan error, 30)
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); errs <- s.Save(task(fmt.Sprint(i), "ok"), nil) }(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	all, err := s.All()
	if err != nil || len(all) != 30 {
		t.Fatalf("got %d tasks: %v", len(all), err)
	}
}
func TestLegacySQLiteFixtureRoundTrip(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required to generate a legacy fixture")
	}
	dir := t.TempDir()
	if err = os.WriteFile(filepath.Join(dir, markerName), []byte(markerContent), 0600); err != nil {
		t.Fatal(err)
	}
	source := `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);"); db.prepare('INSERT INTO tasks(id,body) VALUES(?,?)').run('old',JSON.stringify({id:'old',title:'legacy',status:'draft'})); db.prepare('INSERT INTO events(task_id,body) VALUES(?,?)').run('old',JSON.stringify({type:'activity',taskId:'old'})); db.close();`
	cmd := exec.Command(node, "--input-type=module", "-e", source, filepath.Join(dir, "relay.sqlite"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %s %v", out, err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Get("old"); err != nil {
		t.Fatal(err)
	}
	if err = s.Save(task("new", "new task"), json.RawMessage(`{"type":"activity"}`)); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	check := `import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(process.argv[1],{readOnly:true}); const tasks=db.prepare('SELECT body FROM tasks ORDER BY id').all().map(r=>JSON.parse(r.body)); const events=db.prepare('SELECT body FROM events').all().map(r=>JSON.parse(r.body)); if(tasks.length!==2 || tasks[0].id!=='new' || tasks[1].id!=='old' || events.length!==2 || events[1].taskId!=='new') process.exitCode=1; db.close();`
	cmd = exec.Command(node, "--input-type=module", "-e", check, filepath.Join(dir, "relay.sqlite"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("legacy read: %s %v", out, err)
	}
}

func TestDatabaseSymlinkIsRejected(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, markerName), []byte(markerContent), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "other.sqlite")
	if err := os.WriteFile(target, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "relay.sqlite")); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir); err == nil {
		t.Fatal("followed database symlink")
	}
	contents, _ := os.ReadFile(target)
	if string(contents) != "keep" {
		t.Fatal("modified symlink target")
	}
}
func TestTransactionRollsBackTaskWhenEventInsertFails(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required to generate a legacy fixture")
	}
	dir := t.TempDir()
	if err = os.WriteFile(filepath.Join(dir, markerName), []byte(markerContent), 0600); err != nil {
		t.Fatal(err)
	}
	source := `import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,body TEXT NOT NULL); CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'event rejected'); END;"); db.close();`
	if out, err := exec.Command(node, "--input-type=module", "-e", source, filepath.Join(dir, "relay.sqlite")).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %s %v", out, err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Save(task("id", "must roll back"), json.RawMessage(`{"type":"activity"}`)); err == nil {
		t.Fatal("event rejection not reported")
	}
	if _, err = s.Get("id"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("task was not rolled back: %v", err)
	}
}

func TestDatabaseHardLinkIsRejected(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, markerName), []byte(markerContent), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "other.sqlite")
	if err := os.WriteFile(target, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(target, filepath.Join(dir, "relay.sqlite")); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}
	if _, err := Open(dir); err == nil {
		t.Fatal("accepted hard-linked database")
	}
	contents, _ := os.ReadFile(target)
	if string(contents) != "keep" {
		t.Fatal("modified shared database")
	}
}

func TestSaveUsesLegacyTimestampAndEventOverrides(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Save(task("id", "one"), json.RawMessage(`{"type":"activity"}`)); err != nil {
		t.Fatal(err)
	}
	saved, err := s.Get("id")
	if err != nil {
		t.Fatal(err)
	}
	var taskValue map[string]any
	if err = json.Unmarshal(saved, &taskValue); err != nil {
		t.Fatal(err)
	}
	events, err := s.Events("id", 0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err = json.Unmarshal(events[0], &event); err != nil {
		t.Fatal(err)
	}
	timestamp, ok := taskValue["updatedAt"].(string)
	if !ok || event["at"] != timestamp || len(timestamp) != 24 || !strings.HasSuffix(timestamp, "Z") {
		t.Fatalf("timestamps differ: task %s event %s", saved, events[0])
	}
	if err = s.Save(task("id", "two"), json.RawMessage(`{"type":"activity","taskId":"override","at":"fixed"}`)); err != nil {
		t.Fatal(err)
	}
	events, err = s.Events("id", 0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(events[1], &event); err != nil {
		t.Fatal(err)
	}
	if event["taskId"] != "override" || event["at"] != "fixed" {
		t.Fatalf("lost legacy overrides: %s", events[1])
	}
}

func TestVisitorStopsWithoutHoldingStoreLock(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Save(task("one", "example"), nil); err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("visitor stopped")
	if err = s.Visit(func(Task) error { return sentinel }); !errors.Is(err, sentinel) {
		t.Fatalf("visitor error: %v", err)
	}
	if _, err = s.Get("one"); err != nil {
		t.Fatal(err)
	}
}
func BenchmarkVisitSummaries(b *testing.B) {
	s, err := Open(filepath.Join(b.TempDir(), "state"))
	if err != nil {
		b.Fatal(err)
	}
	defer s.Close()
	for i := 0; i < 300; i++ {
		if err = s.Save(task(fmt.Sprint(i), strings.Repeat("x", 2048)), nil); err != nil {
			b.Fatal(err)
		}
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err = s.Visit(func(raw Task) error {
			var v struct {
				ID string `json:"id"`
			}
			return json.Unmarshal(raw, &v)
		}); err != nil {
			b.Fatal(err)
		}
	}
}

func TestJournalSymlinkIsRejected(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, markerName), []byte(markerContent), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "journal")
	if err := os.WriteFile(target, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "relay.sqlite-journal")); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir); err == nil {
		t.Fatal("accepted linked journal")
	}
	contents, _ := os.ReadFile(target)
	if string(contents) != "keep" {
		t.Fatal("modified linked journal")
	}
}

func TestOwnershipHoldsStoreOpenAndAllowsCheckpointWrites(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	finish := make(chan struct{})
	operation := make(chan error, 1)
	go func() {
		operation <- s.WithOwnership(func(_ string, verify func() error) error {
			if err := s.Save(task("id", "checkpoint"), nil); err != nil {
				return err
			}
			close(entered)
			<-finish
			return verify()
		})
	}()
	<-entered
	closed := make(chan error, 1)
	go func() { closed <- s.Close() }()
	select {
	case err := <-closed:
		t.Fatalf("closed during operation: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(finish)
	if err = <-operation; err != nil {
		t.Fatal(err)
	}
	if err = <-closed; err != nil {
		t.Fatal(err)
	}
}
func TestOwnershipRejectsReplacedMarker(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	marker := filepath.Join(dir, markerName)
	if err = os.Rename(marker, marker+"-old"); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(marker, []byte(markerContent), 0600); err != nil {
		t.Fatal(err)
	}
	if err = s.WithOwnership(func(string, func() error) error { t.Fatal("operation ran with replaced marker"); return nil }); err == nil {
		t.Fatal("replaced marker accepted")
	}
}
