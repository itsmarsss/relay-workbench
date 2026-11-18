package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

type terminalController interface {
	Terminal(context.Context, string, string, map[string]any) (any, error)
	TerminalStream(context.Context, string, string, func(map[string]any) error) error
}

func (s *Server) terminalRoute(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/tasks/"), "/")
	if !strings.HasPrefix(r.URL.Path, "/api/tasks/") || len(parts) != 2 || !taskID.MatchString(parts[0]) {
		return false
	}
	operations := map[string]string{"terminal": "snapshot", "terminal-preview": "snapshot", "terminal-input": "input", "terminal-window": "window", "takeover": "takeover", "return-control": "release", "terminal-stream": "stream", "agent-terminal": "agent"}
	op, ok := operations[parts[1]]
	if !ok {
		return false
	}
	if !s.authorized(r) {
		respond(w, 403, map[string]string{"error": "Session token required"})
		return true
	}
	controller, ok := s.workflow.(terminalController)
	if !ok {
		respond(w, 503, map[string]string{"error": "Terminal service unavailable"})
		return true
	}
	method := "POST"
	if op == "snapshot" || op == "stream" {
		method = "GET"
	}
	if r.Method != method {
		respond(w, 405, map[string]string{"error": "Unsupported terminal method"})
		return true
	}
	if op == "stream" {
		select {
		case s.streams <- struct{}{}:
			defer func() { <-s.streams }()
		default:
			respond(w, 429, map[string]string{"error": "Too many streams"})
			return true
		}
		session := r.URL.Query().Get("session")
		if len(session) > 100 || !strings.HasPrefix(session, "relay-") {
			respond(w, 400, map[string]string{"error": "Invalid terminal session"})
			return true
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			respond(w, 503, map[string]string{"error": "Streaming unavailable"})
			return true
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(200)
		flusher.Flush()
		send := func(value map[string]any) error {
			data, err := json.Marshal(value)
			if err != nil {
				return err
			}
			if _, err = fmt.Fprintf(w, "data: %s\n\n", data); err == nil {
				flusher.Flush()
			}
			return err
		}
		err := controller.TerminalStream(r.Context(), parts[0], session, send)
		if r.Context().Err() == nil {
			message := "Terminal closed."
			if err != nil {
				message = err.Error()
			}
			_ = send(map[string]any{"type": "closed", "message": message})
		}
		return true
	}
	body := map[string]any{}
	if r.Method == "POST" {
		var err error
		body, err = requestObject(w, r)
		if err != nil {
			respond(w, 400, map[string]string{"error": "Invalid terminal request"})
			return true
		}
	}
	value, err := controller.Terminal(r.Context(), parts[0], op, body)
	result(w, value, err, 200)
	return true
}
