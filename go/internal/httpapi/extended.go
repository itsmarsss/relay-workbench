package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	"relay.local/relay/internal/memory"
)

type controller interface {
	Control(context.Context, string, string, map[string]any) (any, error)
}

func result(w http.ResponseWriter, value any, err error, status int) {
	if errors.Is(err, os.ErrNotExist) {
		respond(w, 404, map[string]string{"error": "Not found"})
	} else if err != nil {
		respond(w, 409, map[string]string{"error": err.Error()})
	} else {
		respond(w, status, value)
	}
}
func (s *Server) extended(w http.ResponseWriter, r *http.Request) bool {
	if s.assistantRoute(w, r) {
		return true
	}
	path := r.URL.Path
	if path == "/api/models" || path == "/api/models/discover" || path == "/api/repositories/discover" || path == "/api/repositories/suggestions" {
		if !s.authorized(r) {
			respond(w, 403, map[string]string{"error": "Session token required"})
			return true
		}
		discover, ok := s.workflow.(interface {
			Discover(context.Context, string, map[string]any) (any, error)
		})
		if !ok {
			respond(w, 503, map[string]string{"error": "Discovery unavailable"})
			return true
		}
		body := map[string]any{}
		if r.Method == "POST" {
			var err error
			body, err = requestObject(w, r)
			if err != nil {
				respond(w, 400, map[string]string{"error": "Invalid discovery request"})
				return true
			}
		} else if r.Method != "GET" {
			respond(w, 405, map[string]string{"error": "Invalid discovery method"})
			return true
		}
		operation := "models"
		if strings.Contains(path, "repositories") {
			operation = "repositories"
			if strings.HasSuffix(path, "suggestions") {
				operation = "suggestions"
			}
		}
		value, err := discover.Discover(r.Context(), operation, body)
		result(w, value, err, 200)
		return true
	}

	if path == "/api/memories" || strings.HasPrefix(path, "/api/memories/") {
		id := strings.TrimPrefix(path, "/api/memories")
		id = strings.TrimPrefix(id, "/")
		if len(id) > 200 || strings.Contains(id, "/") {
			respond(w, 400, map[string]string{"error": "Invalid memory ID"})
			return true
		}
		if r.Method == "GET" {
			rows, err := memory.List(s.store)
			visible := []memory.Record{}
			for _, row := range rows {
				if row.Source["deleted"] != true {
					visible = append(visible, row)
				}
			}
			result(w, visible, err, 200)
			return true
		}
		if !s.authorized(r) {
			respond(w, 403, map[string]string{"error": "Session token required"})
			return true
		}
		body, err := requestObject(w, r)
		if err != nil {
			respond(w, 400, map[string]string{"error": "Invalid memory request"})
			return true
		}
		switch r.Method {
		case "POST", "PATCH":
			if (r.Method == "POST" && id != "") || (r.Method == "PATCH" && id == "") {
				respond(w, 405, map[string]string{"error": "Invalid memory method"})
				return true
			}
			row, err := memory.Save(s.store, id, body, false)
			result(w, row, err, 200)
		case "DELETE":
			revision, ok := body["revision"].(float64)
			if id == "" || !ok || revision != float64(int(revision)) || len(body) != 1 {
				respond(w, 400, map[string]string{"error": "Memory revision required"})
				return true
			}
			err := memory.Delete(s.store, id, int(revision))
			result(w, map[string]bool{"deleted": true}, err, 200)
		default:
			respond(w, 405, map[string]string{"error": "Unsupported memory method"})
		}
		return true
	}
	if path == "/api/inbox" && r.Method == "GET" {
		rows, err := s.store.All()
		if err != nil {
			result(w, nil, err, 200)
			return true
		}
		items := []map[string]any{}
		for _, raw := range rows {
			var task map[string]any
			if json.Unmarshal(raw, &task) != nil {
				continue
			}
			state, _ := task["status"].(string)
			if state == "awaiting_plan" || state == "awaiting_final" || state == "blocked" || state == "interrupted" {
				items = append(items, map[string]any{"taskId": task["id"], "title": task["title"], "status": state, "stage": task["stage"], "summary": task["error"], "updatedAt": task["updatedAt"]})
			}
		}
		respond(w, 200, map[string]any{"items": items})
		return true
	}
	if strings.HasPrefix(path, "/api/tasks/") {
		parts := strings.Split(strings.TrimPrefix(path, "/api/tasks/"), "/")
		if !taskID.MatchString(parts[0]) {
			return false
		}
		operation := ""
		if len(parts) == 1 {
			if r.Method == "PATCH" {
				operation = "edit"
			} else if r.Method == "DELETE" {
				operation = "delete"
			}
		} else if len(parts) == 2 && r.Method == "POST" {
			switch parts[1] {
			case "status-override", "message", "request-changes", "replan", "review-comment", "monitor", "publication", "feedback":
				operation = parts[1]
			}
		}
		if operation != "" {
			if !s.authorized(r) {
				respond(w, 403, map[string]string{"error": "Session token required"})
				return true
			}
			control, ok := s.workflow.(controller)
			if !ok {
				respond(w, 503, map[string]string{"error": "Workflow controls unavailable"})
				return true
			}
			body, err := requestObject(w, r)
			if err != nil {
				respond(w, 400, map[string]string{"error": "Invalid task action"})
				return true
			}
			value, err := control.Control(r.Context(), parts[0], operation, body)
			if err == nil && (operation == "request-changes" || operation == "replan") {
				value, err = s.workflow.Resume(parts[0])
			}
			result(w, value, err, 200)
			return true
		}
	}
	return false
}
