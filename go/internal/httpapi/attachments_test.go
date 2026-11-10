package httpapi

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/png"
	"net/http/httptest"
	"relay.local/relay/internal/attachments"
	"testing"
)

func TestAttachmentHTTPBoundaries(t *testing.T) {
	app, _ := setup(t)
	token := hex.EncodeToString(app.token[:])
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	upload := func(body []byte, kind, key, encoding string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://127.0.0.1:4311/api/attachments", bytes.NewReader(body))
		r.Header.Set("Content-Type", kind)
		r.Header.Set("X-Relay-Token", key)
		r.Header.Set("Content-Encoding", encoding)
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		return w
	}
	for _, test := range []struct {
		body                []byte
		kind, key, encoding string
		code                int
	}{{data.Bytes(), "image/png", "", "", 403}, {data.Bytes(), "text/html", token, "", 400}, {[]byte("broken"), "image/png", token, "", 400}, {data.Bytes(), "image/png", token, "gzip", 415}, {make([]byte, attachments.MaxBytes+1), "image/png", token, "", 413}} {
		if w := upload(test.body, test.kind, test.key, test.encoding); w.Code != test.code {
			t.Fatalf("got %d want %d: %s", w.Code, test.code, w.Body.String())
		}
	}
	w := upload(data.Bytes(), "image/png", token, "")
	var value attachments.Image
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &value) != nil {
		t.Fatal(w.Body.String())
	}
	for _, method := range []string{"GET", "HEAD"} {
		r := httptest.NewRequest(method, "http://127.0.0.1:4311"+value.URL, nil)
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" {
			t.Fatal(w.Code, w.Body.String())
		}
		if method == "GET" && !bytes.Equal(w.Body.Bytes(), data.Bytes()) {
			t.Fatal("image bytes changed")
		}
		if method == "HEAD" && w.Body.Len() != 0 {
			t.Fatal("HEAD returned a body")
		}
	}
}
