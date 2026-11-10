package httpapi

import (
	"context"
	"io"
	"net/http"
	"os"
	"time"

	"relay.local/relay/internal/transfer"
)

func (s *Server) transferRoute(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/state/export" {
		return false
	}
	if !s.authorized(r) {
		respond(w, 403, map[string]string{"error": "Session token required"})
		return true
	}
	if r.Method != "POST" {
		respond(w, 405, map[string]string{"error": "Use POST to export state"})
		return true
	}
	select {
	case s.transfers <- struct{}{}:
		defer func() { <-s.transfers }()
	default:
		respond(w, 409, map[string]string{"error": "An export is already running"})
		return true
	}
	body, err := requestObject(w, r)
	if err != nil || len(body) != 0 {
		respond(w, 400, map[string]string{"error": "Export takes no options"})
		return true
	}
	file, err := os.CreateTemp("", "relay-state-*.tar.gz")
	if err != nil {
		respond(w, 500, map[string]string{"error": "Could not prepare export"})
		return true
	}
	defer os.Remove(file.Name())
	defer file.Close()
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	if err = transfer.Export(ctx, s.store, file); err != nil {
		respond(w, 409, map[string]string{"error": err.Error()})
		return true
	}
	if _, err = file.Seek(0, 0); err != nil {
		respond(w, 500, map[string]string{"error": "Could not read export"})
		return true
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="relay-state.tar.gz"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.Copy(w, file)
	return true
}
