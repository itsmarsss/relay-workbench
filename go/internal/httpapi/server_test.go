package httpapi

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"relay.local/relay/internal/storage"
	"relay.local/relay/internal/store"
)

const id = "550e8400-e29b-41d4-a716-446655440000"

func setup(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	web := t.TempDir()
	if err := os.WriteFile(filepath.Join(web, "index.html"), []byte("<h1>preview</h1>"), 0600); err != nil {
		t.Fatal(err)
	}
	app, err := New(db, 4311, web)
	if err != nil {
		t.Fatal(err)
	}
	return app, db
}
func request(app *Server, method, path, host, origin, site string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://127.0.0.1:4311"+path, nil)
	req.Host = host
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if site != "" {
		req.Header.Set("Sec-Fetch-Site", site)
	}
	w := httptest.NewRecorder()
	app.ServeHTTP(w, req)
	return w
}
func TestLocalOriginAndReadOnlyBoundary(t *testing.T) {
	app, _ := setup(t)
	for _, tc := range []struct {
		method, host, origin, site string
		want                       int
	}{
		{"GET", "127.0.0.1:4311", "", "", 200}, {"GET", "example.com:4311", "", "", 403},
		{"GET", "127.0.0.1:4311", "https://example.com", "", 403}, {"GET", "127.0.0.1:4311", "", "cross-site", 403},
		{"POST", "127.0.0.1:4311", "http://127.0.0.1:4311", "same-origin", 403},
	} {
		w := request(app, tc.method, "/api/tasks", tc.host, tc.origin, tc.site)
		if w.Code != tc.want {
			t.Fatalf("%+v got %d: %s", tc, w.Code, w.Body.String())
		}
		if w.Header().Get("X-Frame-Options") != "DENY" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Fatal("missing framing protections")
		}
	}
}
func TestTasksAndEventsSanitizeAndRejectInvalidCursors(t *testing.T) {
	app, db := setup(t)
	raw := json.RawMessage(`{"id":"` + id + `","title":"Example","status":"running","repository":{"id":"r","name":"Repo","path":"private-path"},"attempts":[{"id":"run","stage":"implement","harness":"codex","status":"running","secret":"never expose","handoff":{"summary":"Working"}}]}`)
	if err := db.Save(raw, json.RawMessage(`{"type":"activity"}`)); err != nil {
		t.Fatal(err)
	}
	w := request(app, "GET", "/api/tasks", "127.0.0.1:4311", "", "")
	if w.Code != 200 || strings.Contains(w.Body.String(), "private-path") || strings.Contains(w.Body.String(), "never expose") || !strings.Contains(w.Body.String(), "Working") {
		t.Fatalf("summary %d %s", w.Code, w.Body.String())
	}
	w = request(app, "GET", "/api/tasks/"+id+"/events?after=0", "127.0.0.1:4311", "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"seq":1`) {
		t.Fatalf("events %d %s", w.Code, w.Body.String())
	}
	for _, path := range []string{"/api/tasks/" + id + "/events?after=-1", "/api/tasks/not-an-id"} {
		if w = request(app, "GET", path, "127.0.0.1:4311", "", ""); w.Code != 400 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
	w = request(app, "POST", "/api/tasks/"+id+"/start", "127.0.0.1:4311", "", "")
	if w.Code != 405 {
		t.Fatal("workflow mutation accepted")
	}
}
func TestAssetsCannotEscapeRoot(t *testing.T) {
	app, _ := setup(t)
	target := filepath.Join(t.TempDir(), "private")
	if err := os.WriteFile(target, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(app.webDir, "main.js")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/main.js", "/../private", "/config.json"} {
		w := request(app, "GET", path, "127.0.0.1:4311", "", "")
		if w.Code != 404 || strings.Contains(w.Body.String(), "secret") {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
	}
}

type eventWriter struct {
	h      http.Header
	writes chan string
}

func (w *eventWriter) Header() http.Header         { return w.h }
func (w *eventWriter) WriteHeader(int)             {}
func (w *eventWriter) Write(b []byte) (int, error) { w.writes <- string(b); return len(b), nil }
func (w *eventWriter) Flush()                      {}
func TestEventStreamNotifiesAndTerminates(t *testing.T) {
	app, db := setup(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("GET", "http://127.0.0.1:4311/api/events", nil).WithContext(ctx)
	req.Host = "127.0.0.1:4311"
	w := &eventWriter{h: make(http.Header), writes: make(chan string, 3)}
	done := make(chan struct{})
	go func() { app.ServeHTTP(w, req); close(done) }()
	select {
	case <-w.writes:
	case <-time.After(time.Second):
		t.Fatal("stream did not connect")
	}
	if err := db.Save(json.RawMessage(`{"id":"`+id+`","title":"T","status":"draft"}`), nil); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-w.writes:
		if !strings.Contains(event, "data:") {
			t.Fatalf("bad event %q", event)
		}
	case <-time.After(time.Second):
		t.Fatal("missing event")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("stream did not stop")
	}
}

func requestBody(app *Server, method, path, token, revision, origin, contentType, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://127.0.0.1:4311"+path, strings.NewReader(body))
	req.Host = "127.0.0.1:4311"
	if token != "" {
		req.Header.Set("X-Relay-Token", token)
	}
	if revision != "" {
		req.Header.Set("If-Match", revision)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	app.ServeHTTP(w, req)
	return w
}
func TestAuthenticatedConfigAndDraftCreation(t *testing.T) {
	app, db := setup(t)
	bootstrap := request(app, "GET", "/api/bootstrap", "127.0.0.1:4311", "", "")
	if bootstrap.Code != 200 {
		t.Fatalf("bootstrap: %d %s", bootstrap.Code, bootstrap.Body.String())
	}
	var data struct {
		Token    string `json:"token"`
		Revision string `json:"configRevision"`
	}
	if err := json.Unmarshal(bootstrap.Body.Bytes(), &data); err != nil || len(data.Token) != 64 || data.Revision == "" {
		t.Fatalf("bootstrap %s %v", bootstrap.Body.String(), err)
	}
	for _, token := range []string{"", "00", strings.Repeat("0", 64)} {
		w := requestBody(app, "POST", "/api/tasks", token, "", "", "application/json", `{"title":"No","demo":true}`)
		if w.Code != 403 {
			t.Fatalf("invalid token accepted: %d", w.Code)
		}
	}
	w := requestBody(app, "POST", "/api/tasks", data.Token, "", "https://example.com", "application/json", `{"title":"No","demo":true}`)
	if w.Code != 403 {
		t.Fatal("cross-origin mutation accepted")
	}
	config := `{"repositories":[{"id":"one","name":"One","path":"/example/one"},{"id":"two","name":"Two","path":"/example/two"}]}`
	w = requestBody(app, "PUT", "/api/config", data.Token, data.Revision, "", "application/json", config)
	if w.Code != 200 {
		t.Fatalf("config %d %s", w.Code, w.Body.String())
	}
	var updated struct {
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &updated); err != nil || updated.Revision == data.Revision {
		t.Fatalf("revision: %s %v", w.Body.String(), err)
	}
	w = requestBody(app, "PUT", "/api/config", data.Token, data.Revision, "", "application/json", config)
	if w.Code != 409 {
		t.Fatalf("stale config accepted: %d %s", w.Code, w.Body.String())
	}
	draft := `{"title":"Cross repo","repositoryId":"one","repositoryIds":["one","two"],"dependencies":[{"repositoryId":"two","dependsOn":"one"}]}`
	w = requestBody(app, "POST", "/api/tasks", data.Token, "", "", "application/json; charset=utf-8", draft)
	if w.Code != 201 {
		t.Fatalf("create %d %s", w.Code, w.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	id, _ := created["id"].(string)
	if created["status"] != "draft" || len(created["repositories"].([]any)) != 2 {
		t.Fatalf("invalid draft: %s", w.Body.String())
	}
	events, err := db.Events(id, 0, 1000)
	if err != nil || len(events) != 1 {
		t.Fatalf("creation event: %s %v", events, err)
	}
	w = requestBody(app, "POST", "/api/tasks/"+id+"/start", data.Token, "", "", "application/json", `{}`)
	if w.Code != 405 {
		t.Fatal("unported workflow execution enabled")
	}
}
func TestMutationBodyLimitsAndSessionRotation(t *testing.T) {
	app, db := setup(t)
	token := hex.EncodeToString(app.token[:])
	for _, tc := range []struct{ contentType, body string }{{"text/plain", `{}`}, {"application/json", `[]`}, {"application/json", `{} {}`}, {"application/json", strings.Repeat("x", 1024*1024+1)}} {
		w := requestBody(app, "POST", "/api/tasks", token, "", "", tc.contentType, tc.body)
		if w.Code != 400 {
			t.Fatalf("invalid body accepted: %d", w.Code)
		}
	}
	next, err := New(db, 4311, app.webDir)
	if err != nil {
		t.Fatal(err)
	}
	if next.token == app.token {
		t.Fatal("session token reused")
	}
	w := requestBody(next, "POST", "/api/tasks", token, "", "", "application/json", `{"title":"old token","demo":true}`)
	if w.Code != 403 {
		t.Fatal("old session token accepted")
	}
}
func TestConcurrentConfigurationMutationsRejectStaleRevision(t *testing.T) {
	app, _ := setup(t)
	initial := request(app, "GET", "/api/bootstrap", "127.0.0.1:4311", "", "")
	var data struct {
		Token    string `json:"token"`
		Revision string `json:"configRevision"`
	}
	if err := json.Unmarshal(initial.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	statuses := make(chan int, 10)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := requestBody(app, "PUT", "/api/config", data.Token, data.Revision, "", "application/json", `{}`)
			statuses <- w.Code
		}()
	}
	wg.Wait()
	close(statuses)
	success, stale := 0, 0
	for status := range statuses {
		if status == 200 {
			success++
		} else if status == 409 {
			stale++
		} else {
			t.Fatalf("unexpected status %d", status)
		}
	}
	if success != 1 || stale != 9 {
		t.Fatalf("success %d stale %d", success, stale)
	}
}

func TestStoragePressureAndAuthenticatedPolicyUpdates(t *testing.T) {
	app, _ := setup(t)
	pressure := request(app, "GET", "/api/storage/pressure", "127.0.0.1:4311", "", "")
	if pressure.Code != 200 {
		t.Fatalf("pressure %d %s", pressure.Code, pressure.Body.String())
	}
	var report struct {
		Revision  string `json:"revision"`
		Admission bool   `json:"admissionEnforced"`
		Cleanup   bool   `json:"automaticCleanup"`
		Pressure  struct {
			Space struct {
				Total uint64 `json:"totalBytes,string"`
			} `json:"space"`
		} `json:"pressure"`
	}
	if err := json.Unmarshal(pressure.Body.Bytes(), &report); err != nil || report.Revision == "" || report.Pressure.Space.Total == 0 || report.Admission || report.Cleanup {
		t.Fatalf("report %s %v", pressure.Body.String(), err)
	}
	token := hex.EncodeToString(app.token[:])
	body := `{"enabled":true,"warningPercent":12,"criticalPercent":3,"warningBytes":10737418240,"criticalBytes":2147483648,"monitoredPaths":[]}`
	if w := requestBody(app, "PUT", "/api/storage/policy", "", report.Revision, "", "application/json", body); w.Code != 403 {
		t.Fatalf("unauthenticated update: %d", w.Code)
	}
	for _, invalid := range []string{`{"enabled":true,"warningPercent":12,"criticalPercent":3,"warningBytes":10,"criticalBytes":2,"monitoredPaths":null}`, `{"enabled":null,"warningPercent":12,"criticalPercent":3,"warningBytes":10,"criticalBytes":2,"monitoredPaths":[]}`, `{"enabled":true,"warningPercent":12,"criticalPercent":3,"warningBytes":null,"criticalBytes":2,"monitoredPaths":[]}`, `{"enabled":true,"warningPercent":12.5,"criticalPercent":3,"warningBytes":10,"criticalBytes":2,"monitoredPaths":[]}`, `{"enabled":true,"warningPercent":12,"criticalPercent":3,"warningBytes":10,"criticalBytes":2,"monitoredPaths":[],"extra":1}`} {
		if w := requestBody(app, "PUT", "/api/storage/policy", token, report.Revision, "", "application/json", invalid); w.Code != 400 {
			t.Fatalf("invalid policy accepted: %d %s", w.Code, w.Body.String())
		}
	}
	updated := requestBody(app, "PUT", "/api/storage/policy", token, report.Revision, "", "application/json", body)
	if updated.Code != 200 {
		t.Fatalf("update %d %s", updated.Code, updated.Body.String())
	}
	stale := requestBody(app, "PUT", "/api/storage/policy", token, report.Revision, "", "application/json", body)
	if stale.Code != 409 {
		t.Fatalf("stale policy accepted: %d", stale.Code)
	}
}

func TestStorageScanOnlyInspectsConfiguredPath(t *testing.T) {
	app, _ := setup(t)
	token := hex.EncodeToString(app.token[:])
	pressure := request(app, "GET", "/api/storage/pressure", "127.0.0.1:4311", "", "")
	var initial struct {
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal(pressure.Body.Bytes(), &initial); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "cache.bin"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{"enabled": true, "warningPercent": 10, "criticalPercent": 3, "warningBytes": 10 * storage.GiB, "criticalBytes": 2 * storage.GiB, "monitoredPaths": []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	updated := requestBody(app, "PUT", "/api/storage/policy", token, initial.Revision, "", "application/json", string(body))
	if updated.Code != 200 {
		t.Fatalf("policy: %d %s", updated.Code, updated.Body.String())
	}
	var policy struct {
		Revision string `json:"revision"`
	}
	if err = json.Unmarshal(updated.Body.Bytes(), &policy); err != nil {
		t.Fatal(err)
	}
	path := "/api/storage/scan?index=0&revision=" + policy.Revision
	if w := request(app, "GET", path, "127.0.0.1:4311", "", ""); w.Code != 403 {
		t.Fatal("unauthenticated scan accepted")
	}
	if w := requestBody(app, "HEAD", path, token, "", "", "", ""); w.Code != 405 {
		t.Fatal("HEAD unexpectedly ran a scan")
	}

	w := requestBody(app, "GET", path, token, "", "", "", "")
	if w.Code != 200 {
		t.Fatalf("scan %d %s", w.Code, w.Body.String())
	}
	var result struct {
		Path string             `json:"path"`
		Scan storage.ScanResult `json:"scan"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.Path != root || result.Scan.Files != 1 || result.Scan.LogicalBytes != 7 {
		t.Fatalf("scan result %s %v", w.Body.String(), err)
	}
	if w = requestBody(app, "GET", "/api/storage/scan?index=1&revision="+policy.Revision, token, "", "", "", ""); w.Code != 400 {
		t.Fatal("unconfigured path accepted")
	}
	if w = requestBody(app, "GET", "/api/storage/scan?index=0&revision="+initial.Revision, token, "", "", "", ""); w.Code != 409 {
		t.Fatal("stale path scan accepted")
	}
	if _, err = os.Stat(filepath.Join(root, "cache.bin")); err != nil {
		t.Fatal("scan modified file")
	}
}
