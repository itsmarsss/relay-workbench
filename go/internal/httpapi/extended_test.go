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
