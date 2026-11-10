package transfer

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"relay.local/relay/internal/assistant"
	"relay.local/relay/internal/attachments"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/workflow"
)

func TestRestoreRejectsCorruptionAndConcurrentInstall(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "source"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var archive bytes.Buffer
	if err := Export(context.Background(), db, &archive); err != nil {
		t.Fatal(err)
	}
	broken := append([]byte(nil), archive.Bytes()...)
	broken[len(broken)-5] ^= 0xff
	destination := filepath.Join(t.TempDir(), "corrupt")
	if err := Restore(context.Background(), bytes.NewReader(broken), destination); err == nil {
		t.Fatal("corrupt gzip accepted")
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatal("corrupt archive installed")
	}
	destination = filepath.Join(t.TempDir(), "concurrent")
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- Restore(context.Background(), bytes.NewReader(archive.Bytes()), destination)
		}()
	}
	wg.Wait()
	close(results)
	succeeded := 0
	for err := range results {
		if err == nil {
			succeeded++
		}
	}
	if succeeded != 1 {
		t.Fatalf("successful installs = %d", succeeded)
	}
	restored, err := store.Open(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
}

func TestImportRecordsRollsBackInvalidTail(t *testing.T) {
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	records := "{\"kind\":\"meta\",\"id\":\"retained\",\"value\":\"ok\"}\n{\"kind\":\"invalid\"}\n"
	if err := db.ImportRecords(context.Background(), strings.NewReader(records), nil); err == nil {
		t.Fatal("invalid tail accepted")
	}
	if _, exists, err := db.GetMeta("retained"); err != nil || exists {
		t.Fatal("partial import retained")
	}
}

func TestArchiveRoundTripQuarantinesWritersAndGrants(t *testing.T) {
	root := filepath.Join(t.TempDir(), "source")
	db, err := store.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	config := task.ConfigurationService{Store: db}
	created, err := config.CreateTask(map[string]any{"title": "Retained", "demo": true})
	if err != nil {
		t.Fatal(err)
	}
	id := str(created["id"])
	created["status"], created["stage"], created["workspaceRoot"] = "running", "implement", "/another/instance/worktree"
	created["automation"] = map[string]any{"enabled": true}
	created["chosenApproach"] = map[string]any{"id": "unsafe"}
	raw, _ := json.Marshal(created)
	if err = db.Save(raw, json.RawMessage(`{"type":"evidence","summary":"Retained activity"}`)); err != nil {
		t.Fatal(err)
	}
	if err = db.SetMeta("automation:"+id, `{"enabled":true}`); err != nil {
		t.Fatal(err)
	}
	if err = db.SetMeta("terminal:"+id, `{"active":true,"capability":"secret"}`); err != nil {
		t.Fatal(err)
	}
	if err = db.SetMeta("workspace-conversations", `[{"id":"default","title":"General"}]`); err != nil {
		t.Fatal(err)
	}
	if err = db.SetMeta("workspace-agent", `[{"id":"m","question":"Saved question","answer":"Partial answer","status":"running"}]`); err != nil {
		t.Fatal(err)
	}
	var picture bytes.Buffer
	png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	saved, err := attachments.Save(db, picture.Bytes(), "image/png")
	if err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	if err = Export(context.Background(), db, &archive); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "restored")
	if err = Restore(context.Background(), bytes.NewReader(archive.Bytes()), dest); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(dest)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	raw, err = restored.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	json.Unmarshal(raw, &value)
	if value["status"] != "imported" || value["stage"] != "archived" || value["workspaceRoot"] != nil || value["chosenApproach"] != nil || obj(value["migration"])["readOnly"] != true {
		t.Fatalf("unsafe restored task: %#v", value)
	}
	for _, key := range []string{"automation:" + id, "terminal:" + id} {
		if _, exists, _ := restored.GetMeta(key); exists {
			t.Fatalf("grant retained: %s", key)
		}
	}
	events, err := restored.Events(id, 0, 100)
	if err != nil || len(events) != 2 {
		t.Fatalf("events: %d %v", len(events), err)
	}
	chat, exists, err := restored.GetMeta("assistant:chat:legacy-default")
	var conversation assistant.Chat
	json.Unmarshal([]byte(chat), &conversation)
	if err != nil || !exists || conversation.Name != "General" || conversation.Messages[0].Status != "interrupted" || conversation.Messages[0].ToolCalls == nil {
		t.Fatal("conversation did not migrate")
	}
	if _, _, err = attachments.Read(restored, filepath.Base(saved.URL)); err != nil {
		t.Fatal(err)
	}
	settings, err := (task.ConfigurationService{Store: restored}).Read()
	if err != nil {
		t.Fatal(err)
	}
	for _, provider := range []string{"codex", "claude", "pi"} {
		if obj(obj(settings.Value["harnesses"])[provider])["enabled"] != false {
			t.Fatal("provider remained enabled")
		}
	}
	worker, _ := os.Executable()
	coordinator, err := workflow.NewCoordinator(restored, worker, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer coordinator.Close()
	if _, err = coordinator.Start(id); err == nil {
		t.Fatal("imported task started")
	}
	if _, err = coordinator.Control(context.Background(), id, "replan", map[string]any{"taskRevision": store.TaskRevision(raw), "message": "Start"}); err == nil {
		t.Fatal("imported task mutated")
	}
	result, err := coordinator.Control(context.Background(), id, "recreate", map[string]any{"taskRevision": store.TaskRevision(raw)})
	if err != nil {
		t.Fatal(err)
	}
	fresh := result.(map[string]any)
	if fresh["status"] != "draft" || fresh["id"] == id || fresh["workspaceRoot"] != nil {
		t.Fatal("fresh task reused workspace")
	}
	if err = Restore(context.Background(), bytes.NewReader(archive.Bytes()), dest); err == nil {
		t.Fatal("overwrote destination")
	}
}

func malformedArchive(t *testing.T, name string, kind byte) []byte {
	t.Helper()
	var output bytes.Buffer
	compressed := gzip.NewWriter(&output)
	archive := tar.NewWriter(compressed)
	err := archive.WriteHeader(&tar.Header{Name: name, Typeflag: kind, Mode: 0600, Size: 0, Linkname: "/outside"})
	if err != nil {
		t.Fatal(err)
	}
	archive.Close()
	compressed.Close()
	return output.Bytes()
}
func TestRestoreRejectsTraversalLinksMissingInventoryAndCancellation(t *testing.T) {
	for _, test := range []struct {
		name string
		kind byte
	}{{"../escape", tar.TypeReg}, {"/absolute", tar.TypeReg}, {"attachments/../escape", tar.TypeReg}, {"config.json", tar.TypeSymlink}, {"config.json", tar.TypeReg}} {
		dest := filepath.Join(t.TempDir(), "new-state")
		err := Restore(context.Background(), bytes.NewReader(malformedArchive(t, test.name, test.kind)), dest)
		if err == nil {
			t.Fatalf("accepted %s", test.name)
		}
		if _, err = os.Stat(dest); !os.IsNotExist(err) {
			t.Fatal("failed import installed destination")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := Restore(ctx, strings.NewReader("anything"), filepath.Join(t.TempDir(), "new")); err == nil {
		t.Fatal("cancelled restore succeeded")
	}
}
func TestLegacyExportIsReadOnlyAndRefusesRunningSource(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node legacy oracle unavailable")
	}
	root := t.TempDir()
	script := `const {DatabaseSync}=require('node:sqlite');const path=require('node:path');const db=new DatabaseSync(path.join(process.argv[1],'relay.sqlite'));db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,body TEXT NOT NULL);CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);');db.prepare('INSERT INTO tasks VALUES (?,?)').run('550e8400-e29b-41d4-a716-446655440000',JSON.stringify({id:'550e8400-e29b-41d4-a716-446655440000',title:'Legacy',status:'draft',demo:true,attempts:[],approvals:[],messages:[]}));db.close();`
	if output, err := exec.Command(node, "-e", script, root).CombinedOutput(); err != nil {
		t.Fatalf("legacy fixture: %s %v", output, err)
	}
	before, err := os.ReadFile(filepath.Join(root, "relay.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	if err = ExportLegacy(context.Background(), root, &archive); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(filepath.Join(root, "relay.sqlite"))
	if !bytes.Equal(before, after) {
		t.Fatal("legacy source changed")
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 {
		t.Fatal("legacy export wrote source files")
	}
	if err = os.WriteFile(filepath.Join(root, "server.lock"), []byte("123"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = ExportLegacy(context.Background(), root, &bytes.Buffer{}); err == nil {
		t.Fatal("exported running source")
	}
	if err = Restore(context.Background(), bytes.NewReader(archive.Bytes()), filepath.Join(t.TempDir(), "migrated")); err != nil {
		t.Fatal(err)
	}
}
