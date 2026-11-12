package httpapi

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"relay.local/relay/internal/storage"
)

func TestBoardOrderRequiresTokenAndRanksListedTasks(t *testing.T) {
	app, db := setup(t)
	token := hex.EncodeToString(app.token[:])
	other := "550e8400-e29b-41d4-a716-446655440001"
	for _, task := range []string{id, other} {
		if err := db.Save(json.RawMessage(`{"id":"`+task+`","title":"Example","status":"draft"}`), json.RawMessage(`{"type":"activity"}`)); err != nil {
			t.Fatal(err)
		}
	}
	order := `{"order":["` + other + `","` + id + `"]}`
	if w := requestBody(app, "PUT", "/api/board/order", "", "", "", "application/json", order); w.Code != 403 {
		t.Fatalf("unauthenticated order: %d", w.Code)
	}
	if w := requestBody(app, "PUT", "/api/board/order", token, "", "https://example.test", "application/json", order); w.Code != 403 {
		t.Fatalf("cross-origin order: %d", w.Code)
	}
	if w := requestBody(app, "POST", "/api/board/order", token, "", "", "application/json", order); w.Code != 405 {
		t.Fatalf("POST order: %d", w.Code)
	}
	if w := requestBody(app, "PUT", "/api/board/order", token, "", "", "text/plain", order); w.Code == 200 {
		t.Fatal("order accepted without a JSON content type")
	}
	for _, invalid := range []string{`{}`, `{"order":null}`, `{"order":"` + id + `"}`, `{"order":[1]}`, `{"order":["../state"]}`, `{"order":["` + id + `","` + id + `"]}`, `{"order":[],"extra":1}`, `[]`} {
		if w := requestBody(app, "PUT", "/api/board/order", token, "", "", "application/json", invalid); w.Code != 400 {
			t.Fatalf("%s accepted: %d %s", invalid, w.Code, w.Body.String())
		}
	}
	if app.boardOrder() != nil {
		t.Fatal("a rejected order was saved")
	}
	if w := requestBody(app, "PUT", "/api/board/order", token, "", "", "application/json", order); w.Code != 200 {
		t.Fatalf("order: %d %s", w.Code, w.Body.String())
	}
	var listed struct {
		Tasks []struct {
			ID   string `json:"id"`
			Rank *int   `json:"boardRank"`
		} `json:"tasks"`
	}
	list := request(app, "GET", "/api/tasks", "127.0.0.1:4311", "", "")
	if err := json.Unmarshal(list.Body.Bytes(), &listed); err != nil {
		var rows []struct {
			ID   string `json:"id"`
			Rank *int   `json:"boardRank"`
		}
		if err = json.Unmarshal(list.Body.Bytes(), &rows); err != nil {
			t.Fatalf("tasks %s %v", list.Body.String(), err)
		}
		listed.Tasks = rows
	}
	ranks := map[string]int{}
	for _, row := range listed.Tasks {
		if row.Rank != nil {
			ranks[row.ID] = *row.Rank
		}
	}
	if !reflect.DeepEqual(ranks, map[string]int{other: 0, id: 1}) {
		t.Fatalf("ranks %v from %s", ranks, list.Body.String())
	}
	// Clearing the order returns every card to its default place.
	if w := requestBody(app, "PUT", "/api/board/order", token, "", "", "application/json", `{"order":[]}`); w.Code != 200 {
		t.Fatalf("clear: %d", w.Code)
	}
	if list = request(app, "GET", "/api/tasks", "127.0.0.1:4311", "", ""); strings.Contains(list.Body.String(), "boardRank") {
		t.Fatalf("rank survived clearing: %s", list.Body.String())
	}
}

func TestWorkspaceSizesMeasureOnlyTaskOwnedDirectories(t *testing.T) {
	app, db := setup(t)
	token := hex.EncodeToString(app.token[:])
	owned, attached := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(owned, "build.bin"), make([]byte, 8192), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(attached, "mine.bin"), make([]byte, 8192), 0600); err != nil {
		t.Fatal(err)
	}
	other := "550e8400-e29b-41d4-a716-446655440001"
	save := func(task map[string]any) {
		t.Helper()
		raw, err := json.Marshal(task)
		if err != nil {
			t.Fatal(err)
		}
		if err = db.Save(raw, json.RawMessage(`{"type":"activity"}`)); err != nil {
			t.Fatal(err)
		}
	}
	save(map[string]any{"id": id, "title": "Owned", "status": "draft", "workspaceRoot": owned, "repository": map[string]any{"id": "r", "strategy": "worktree", "path": "/source"}})
	save(map[string]any{"id": other, "title": "Attached", "status": "draft", "workspaceRoot": attached, "repository": map[string]any{"id": "r", "strategy": "attach", "path": attached}})
	var measured []string
	app.usage = storage.NewUsage(func(ctx context.Context, path string, limit int) (storage.ScanResult, error) {
		measured = append(measured, path)
		return storage.Measure(ctx, path, limit)
	})
	if w := request(app, "GET", "/api/workspaces/sizes", "127.0.0.1:4311", "", ""); w.Code != 403 {
		t.Fatalf("unauthenticated sizes: %d", w.Code)
	}
	if w := requestBody(app, "POST", "/api/workspaces/sizes", token, "", "", "application/json", "{}"); w.Code != 405 {
		t.Fatalf("POST sizes: %d", w.Code)
	}
	var report struct {
		Sizes map[string]struct {
			Bytes    uint64 `json:"allocatedBytes,string"`
			Complete bool   `json:"complete"`
			At       string `json:"measuredAt"`
		} `json:"sizes"`
		Measuring []string `json:"measuring"`
		Pending   int      `json:"pending"`
	}
	read := func() {
		t.Helper()
		w := requestBody(app, "GET", "/api/workspaces/sizes", token, "", "", "", "")
		report.Sizes, report.Measuring = nil, nil
		if err := json.Unmarshal(w.Body.Bytes(), &report); w.Code != 200 || err != nil {
			t.Fatalf("sizes %d %s %v", w.Code, w.Body.String(), err)
		}
	}
	// The first read answers at once and measures in the background.
	read()
	if len(report.Sizes) != 0 || !reflect.DeepEqual(report.Measuring, []string{id}) || report.Pending != 1 {
		t.Fatalf("first read %#v", report)
	}
	for deadline := time.Now().Add(5 * time.Second); report.Pending > 0 && time.Now().Before(deadline); read() {
		time.Sleep(10 * time.Millisecond)
	}
	size, ok := report.Sizes[id]
	if !ok || size.Bytes < 8192 || !size.Complete || size.At == "" || len(report.Sizes) != 1 || len(report.Measuring) != 0 {
		t.Fatalf("measured %#v", report)
	}
	if !reflect.DeepEqual(measured, []string{owned}) {
		t.Fatalf("measured directories %v", measured)
	}
}

func TestWorkspaceDirectoriesCoverManagedContainersAndSkipUserCheckouts(t *testing.T) {
	const task = "550e8400-e29b-41d4-a716-446655440000"
	managed := map[string]any{"id": "m", "strategy": "managed", "path": "/code/source", "workspacePath": "/code/trees/{workspaceName}/src"}
	cases := []struct {
		name string
		task map[string]any
		want []string
	}{
		{"managed checkout counts its per-task directory", map[string]any{"id": task, "workspaceRoot": "/code/trees/relay-" + task + "/src", "repository": managed}, []string{"/code/trees/relay-" + task}},
		{"managed checkout elsewhere counts itself", map[string]any{"id": task, "workspaceRoot": "/elsewhere/relay-" + task + "/deep/src", "repository": managed}, []string{"/elsewhere/relay-" + task + "/deep/src"}},
		{"a shared parent is never counted", map[string]any{"id": task, "workspaceRoot": "/code/trees/shared/src", "repository": managed}, []string{"/code/trees/shared/src"}},
		{"template ending in the task directory", map[string]any{"id": task, "workspaceRoot": "/code/trees/relay-" + task, "repository": map[string]any{"strategy": "managed", "workspacePath": "/code/trees/{workspaceName}"}}, []string{"/code/trees/relay-" + task}},
		{"attached checkout", map[string]any{"id": task, "workspaceRoot": "/code/source", "repository": map[string]any{"strategy": "attach", "path": "/code/source"}}, []string{}},
		{"source checkout", map[string]any{"id": task, "workspaceRoot": "/code/source/", "repository": map[string]any{"strategy": "worktree", "path": "/code/source"}}, []string{}},
		{"relative root", map[string]any{"id": task, "workspaceRoot": "trees/x", "repository": map[string]any{"strategy": "worktree"}}, []string{}},
		{"no workspace", map[string]any{"id": task, "repository": map[string]any{"strategy": "worktree"}}, []string{}},
		{"single entry reads the task", map[string]any{"id": task, "workspaceRoot": "/state/worktrees/" + task, "repository": map[string]any{"strategy": "worktree", "path": "/code/source"}, "repositories": []any{map[string]any{"repository": map[string]any{"strategy": "worktree"}}}}, []string{"/state/worktrees/" + task}},
		{"each repository once", map[string]any{"id": task, "workspaceRoot": "/ignored", "repositories": []any{
			map[string]any{"workspaceRoot": "/code/trees/relay-" + task + "-0/src", "repository": managed},
			map[string]any{"workspaceRoot": "/state/worktrees/" + task + "-1", "repository": map[string]any{"strategy": "worktree", "path": "/code/other"}},
			map[string]any{"workspaceRoot": "/state/worktrees/" + task + "-1/", "repository": map[string]any{"strategy": "worktree", "path": "/code/other"}},
		}}, []string{"/code/trees/relay-" + task + "-0", "/state/worktrees/" + task + "-1"}},
	}
	for _, test := range cases {
		if got := workspaceDirectories(test.task); !reflect.DeepEqual(got, test.want) {
			t.Errorf("%s: %v, want %v", test.name, got, test.want)
		}
	}
}
