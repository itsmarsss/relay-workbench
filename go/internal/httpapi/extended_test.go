package httpapi

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

type extendedCoordinator struct {
	fakeCoordinator
	calls int
}

func (c *extendedCoordinator) Workload() (int, int) { return 2, 1 }

func TestHealthIncludesActivePRMonitoring(t *testing.T) {
	app, _ := setup(t)
	app.SetCoordinator(&extendedCoordinator{})
	w := request(app, "GET", "/api/health", "127.0.0.1:4311", "", "")
	var value struct{ Running, Monitoring int }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &value) != nil || value.Running != 2 || value.Monitoring != 1 {
		t.Fatalf("incorrect workload response: %s", w.Body.String())
	}
}

func (c *extendedCoordinator) Control(_ context.Context, id, op string, body map[string]any) (any, error) {
	c.calls++
	return map[string]any{"id": id, "operation": op}, nil
}
func (c *extendedCoordinator) Discover(_ context.Context, op string, body map[string]any) (any, error) {
	c.calls++
	return map[string]any{"operation": op}, nil
}
func TestExtendedBoundaries(t *testing.T) {
	app, db := setup(t)
	c := &extendedCoordinator{}
	app.SetCoordinator(c)
	token := hex.EncodeToString(app.token[:])
	do := func(method, path, body, key string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1:4311"+path, strings.NewReader(body))
		r.Header.Set("X-Relay-Token", key)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		return w
	}
	for _, path := range []string{"/api/tasks/" + id, "/api/tasks/" + id + "/request-changes", "/api/models/discover", "/api/repositories/discover", "/api/memories"} {
		method := "POST"
		if path == "/api/tasks/"+id {
			method = "PATCH"
		}
		w := do(method, path, "{}", "")
		if w.Code != 403 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
	if c.calls != 0 {
		t.Fatal("unauthenticated operation executed")
	}
	w := do("POST", "/api/memories", `{"title":"Test","content":"Content"}`, token)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var row struct {
		ID       string
		Revision int
	}
	if json.Unmarshal(w.Body.Bytes(), &row) != nil {
		t.Fatal("invalid record")
	}
	if w = do("PATCH", "/api/memories/"+row.ID, `{"revision":0,"content":"stale"}`, token); w.Code != 409 {
		t.Fatal("stale edit accepted")
	}
	if w = do("POST", "/api/memories", `{"title":"x","content":"y","approvedRevision":1}`, token); w.Code != 409 {
		t.Fatal("approval field injection accepted")
	}
	if w = do("DELETE", "/api/memories/"+row.ID, `{"revision":1}`, token); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if rows, _ := db.ListMeta("memory:"); len(rows) != 0 {
		t.Fatal("deleted memory retained")
	}
	if w = do("PATCH", "/api/tasks/"+id, `{} {}`, token); w.Code != 400 {
		t.Fatal("trailing JSON accepted")
	}
}

func TestWorkflowInsightsReadRecordedEvidence(t *testing.T) {
	app, db := setup(t)
	task := map[string]any{"id": id, "title": "Evidence fixture"}
	task["status"] = "awaiting_plan"
	task["attempts"] = []any{map[string]any{"id": "run", "stage": "investigate", "harness": "codex", "model": "fixture-model", "status": "complete", "handoff": map[string]any{"verdict": "complete"}}}
	raw, _ := json.Marshal(task)
	if err := db.Save(raw, json.RawMessage(`{"type":"handoff"}`)); err != nil {
		t.Fatal(err)
	}
	w := request(app, "GET", "/api/tasks/"+id, "127.0.0.1:4311", "", "")
	var detail map[string]json.RawMessage
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &detail) != nil {
		t.Fatalf("task: %d %s", w.Code, w.Body.String())
	}
	var health map[string]any
	if json.Unmarshal(detail["health"], &health) != nil || health["state"] != "awaiting_plan" || health["quiet"] != false {
		t.Fatalf("health: %s", detail["health"])
	}
	w = request(app, "GET", "/api/outcomes", "127.0.0.1:4311", "", "")
	var outcomes struct {
		Rows []struct{ Successful int }
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &outcomes) != nil || len(outcomes.Rows) != 1 || outcomes.Rows[0].Successful != 1 {
		t.Fatalf("outcomes: %d %s", w.Code, w.Body.String())
	}
	w = request(app, "GET", "/api/outcomes?repositoryId=missing", "127.0.0.1:4311", "", "")
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &outcomes) != nil || len(outcomes.Rows) != 0 {
		t.Fatalf("filtered outcomes: %d %s", w.Code, w.Body.String())
	}
}
