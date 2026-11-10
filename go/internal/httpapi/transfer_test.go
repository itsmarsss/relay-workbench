package httpapi

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/hex"
	"io"
	"net/http/httptest"
	"testing"
)

func TestStateExportHTTPBoundary(t *testing.T) {
	app, _ := setup(t)
	token := hex.EncodeToString(app.token[:])
	for _, test := range []struct {
		method, body, token string
		code                int
	}{{"POST", "{}", "", 403}, {"GET", "{}", token, 405}, {"POST", `{"path":"/outside"}`, token, 400}, {"POST", "{}", token, 200}} {
		r := httptest.NewRequest(test.method, "http://127.0.0.1:4311/api/state/export", bytes.NewBufferString(test.body))
		r.Header.Set("X-Relay-Token", test.token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		if w.Code != test.code {
			t.Fatalf("%s: %d %s", test.method, w.Code, w.Body.String())
		}
		if test.code == 200 {
			if w.Header().Get("Content-Type") != "application/gzip" {
				t.Fatal("invalid download type")
			}
			compressed, err := gzip.NewReader(w.Body)
			if err != nil {
				t.Fatal(err)
			}
			archive := tar.NewReader(compressed)
			found := false
			for {
				h, err := archive.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				if h.Name == "manifest.json" {
					found = true
				}
			}
			compressed.Close()
			if !found {
				t.Fatal("no manifest")
			}
		}
	}
}
