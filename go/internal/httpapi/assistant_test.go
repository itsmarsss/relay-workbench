package httpapi

import (
	"context"
	"encoding/hex"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeAssistant struct{ calls int }

func (a *fakeAssistant) Handle(_ context.Context, method, id, op string, body map[string]any) (any, error) {
	a.calls++
	return map[string]any{"id": id, "operation": op}, nil
}
func TestConversationHTTPBoundary(t *testing.T) {
	app, _ := setup(t)
	a := &fakeAssistant{}
	app.SetAssistant(a)
	token := hex.EncodeToString(app.token[:])
	for _, entry := range []struct {
		method, path, body, key, origin string
		status                          int
	}{
		{"GET", "/api/chats", "", "", "", 403},
		{"POST", "/api/chats", `{"name":"New"}`, token, "https://example.invalid", 403},
		{"POST", "/api/chats", `{} {}`, token, "", 400},
		{"GET", "/api/chats/id/send", "", token, "", 405},
		{"POST", "/api/chats/id/unknown", `{}`, token, "", 405},
		{"POST", "/api/chats/id/send", `{}`, token, "", 200},
		{"GET", "/api/chats", "", "" + token, "", 200},
	} {
		r := httptest.NewRequest(entry.method, "http://127.0.0.1:4311"+entry.path, strings.NewReader(entry.body))
		r.Header.Set("X-Relay-Token", entry.key)
		r.Header.Set("Origin", entry.origin)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		if w.Code != entry.status {
			t.Fatalf("%s: %d %s", entry.path, w.Code, w.Body.String())
		}
	}
	if a.calls != 2 {
		t.Fatalf("unexpected invocations %d", a.calls)
	}
}
