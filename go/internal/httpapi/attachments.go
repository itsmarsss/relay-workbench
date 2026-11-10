package httpapi

import (
	"io"
	"mime"
	"net/http"
	"strings"

	"relay.local/relay/internal/attachments"
)

func (s *Server) attachmentRoute(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/attachments" && !strings.HasPrefix(r.URL.Path, "/api/attachments/") {
		return false
	}
	if r.Method == "POST" && r.URL.Path == "/api/attachments" {
		if !s.authorized(r) {
			respond(w, 403, map[string]string{"error": "Session token required"})
			return true
		}
		if encoding := r.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
			respond(w, 415, map[string]string{"error": "Compressed uploads are unsupported"})
			return true
		}
		kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil {
			respond(w, 415, map[string]string{"error": "Image content type required"})
			return true
		}
		r.Body = http.MaxBytesReader(w, r.Body, attachments.MaxBytes)
		data, err := io.ReadAll(r.Body)
		if err != nil {
			respond(w, 413, map[string]string{"error": "Image exceeds 10 MB"})
			return true
		}
		value, err := attachments.Save(s.store, data, kind)
		if err != nil {
			respond(w, 400, map[string]string{"error": err.Error()})
		} else {
			respond(w, 201, value)
		}
		return true
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		respond(w, 405, map[string]string{"error": "Unsupported attachment method"})
		return true
	}
	data, info, err := attachments.Read(s.store, strings.TrimPrefix(r.URL.Path, "/api/attachments/"))
	if err != nil {
		respond(w, 404, map[string]string{"error": "Image not found"})
		return true
	}
	w.Header().Set("Content-Type", info.Type)
	w.Header().Set("Content-Disposition", "inline")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if r.Method != "HEAD" {
		_, _ = w.Write(data)
	}
	return true
}
