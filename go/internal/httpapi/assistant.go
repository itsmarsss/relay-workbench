package httpapi

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
)

type Assistant interface {
	Handle(context.Context, string, string, string, map[string]any) (any, error)
}

func (s *Server) SetAssistant(value Assistant) { s.assistant = value }
func (s *Server) assistantRoute(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/chats" && !strings.HasPrefix(r.URL.Path, "/api/chats/") {
		return false
	}
	if !s.authorized(r) {
		respond(w, 403, map[string]string{"error": "Session token required"})
		return true
	}
	if s.assistant == nil {
		respond(w, 503, map[string]string{"error": "Assistant unavailable"})
		return true
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/chats"), "/")
	id, operation := "", ""
	if len(parts) > 1 {
		id = parts[1]
	}
	if len(parts) > 2 {
		operation = parts[2]
	}
	if len(parts) > 3 || len(id) > 80 || strings.ContainsAny(id, ".\\") {
		respond(w, 400, map[string]string{"error": "Invalid conversation route"})
		return true
	}
	if (operation != "" && (r.Method != "POST" || operation != "send" && operation != "stop" && operation != "proposal")) || (operation == "" && r.Method != "GET" && r.Method != "POST" && r.Method != "PATCH" && r.Method != "DELETE") {
		respond(w, 405, map[string]string{"error": "Unsupported conversation method"})
		return true
	}
	body := map[string]any{}
	if r.Method == "GET" {
		body["taskId"] = r.URL.Query().Get("taskId")
	} else {
		var err error
		body, err = requestObject(w, r)
		if err != nil {
			respond(w, 400, map[string]string{"error": "Invalid conversation request"})
			return true
		}
	}
	value, err := s.assistant.Handle(r.Context(), r.Method, id, operation, body)
	status := 200
	if err != nil {
		status = 409
		if errors.Is(err, os.ErrNotExist) {
			status = 404
		}
		value = map[string]string{"error": err.Error()}
	}
	respond(w, status, value)
	return true
}
