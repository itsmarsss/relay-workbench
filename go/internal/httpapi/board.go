package httpapi

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"

	"relay.local/relay/internal/storage"
	"relay.local/relay/internal/store"
)

// workspaceSizesKey holds the last measured size of each task directory.
const workspaceSizesKey = "workspace:sizes"

const boardOrderKey = "board:order"
const boardOrderLimit = 5000

// boardOrder is the order the user dragged cards into. Tasks missing from it
// keep their default place.
func (s *Server) boardOrder() []string {
	raw, ok, err := s.store.GetMeta(boardOrderKey)
	if err != nil || !ok {
		return nil
	}
	var ids []string
	if json.Unmarshal([]byte(raw), &ids) != nil {
		return nil
	}
	return ids
}

// workspaceDirectories lists the directories a task owns on disk. A managed
// workspace nested inside a per-task directory counts that whole directory, so
// build output beside the checkout is included. Attached checkouts belong to
// the user and are never measured.
func workspaceDirectories(task map[string]any) []string {
	entries, _ := task["repositories"].([]any)
	if len(entries) <= 1 {
		entries = []any{task}
	}
	id, _ := task["id"].(string)
	seen := map[string]bool{}
	result := []string{}
	for _, value := range entries {
		entry, _ := value.(map[string]any)
		profile, _ := entry["repository"].(map[string]any)
		root, _ := entry["workspaceRoot"].(string)
		if root == "" || !filepath.IsAbs(root) || profile["strategy"] == "attach" {
			continue
		}
		root = filepath.Clean(root)
		if source, _ := profile["path"].(string); source != "" && filepath.Clean(source) == root {
			continue
		}
		if template, _ := profile["workspacePath"].(string); profile["strategy"] == "managed" && filepath.IsAbs(template) {
			pattern, parts := strings.Split(filepath.Clean(template), "/"), strings.Split(root, "/")
			for index, part := range pattern {
				if !strings.Contains(part, "{workspaceName}") && !strings.Contains(part, "{taskId}") {
					continue
				}
				if len(pattern) == len(parts) && index < len(parts)-1 && id != "" && strings.Contains(parts[index], id) {
					root = strings.Join(parts[:index+1], "/")
				}
				break
			}
		}
		if !seen[root] {
			seen[root] = true
			result = append(result, root)
		}
	}
	return result
}

func (s *Server) boardRoute(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/api/board/order":
		if r.Method != http.MethodPut {
			w.Header().Set("Allow", "PUT")
			respond(w, 405, map[string]string{"error": "Use PUT to save the board order"})
			return true
		}
		if !s.authorized(r) {
			respond(w, 403, map[string]string{"error": "Session token required"})
			return true
		}
		body, err := requestObject(w, r)
		items, ok := body["order"].([]any)
		if err != nil || !ok || len(body) != 1 || len(items) > boardOrderLimit {
			respond(w, 400, map[string]string{"error": "Invalid board order"})
			return true
		}
		ids, seen := []string{}, map[string]bool{}
		for _, item := range items {
			id, ok := item.(string)
			if !ok || !taskID.MatchString(id) || seen[id] {
				respond(w, 400, map[string]string{"error": "Invalid board order"})
				return true
			}
			seen[id] = true
			ids = append(ids, id)
		}
		encoded, _ := json.Marshal(ids)
		if err = s.store.SetMeta(boardOrderKey, string(encoded)); err != nil {
			respond(w, 500, map[string]string{"error": "Could not save the board order"})
			return true
		}
		s.store.NotifyChange()
		respond(w, 200, map[string]any{"order": ids})
		return true
	case "/api/workspaces/sizes":
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			respond(w, 405, map[string]string{"error": "Use GET to read workspace sizes"})
			return true
		}
		if !s.authorized(r) {
			respond(w, 403, map[string]string{"error": "Session token required"})
			return true
		}
		targets := []storage.UsageTarget{}
		err := s.store.Visit(func(row store.Task) error {
			var task map[string]any
			if json.Unmarshal(row, &task) != nil {
				return nil
			}
			id, _ := task["id"].(string)
			if paths := workspaceDirectories(task); taskID.MatchString(id) && len(paths) > 0 {
				stamp, _ := task["updatedAt"].(string)
				targets = append(targets, storage.UsageTarget{ID: id, Paths: paths, Stamp: stamp})
			}
			return nil
		})
		if err != nil {
			respond(w, 500, map[string]string{"error": "Could not read tasks"})
			return true
		}
		sizes, measuring, pending := s.usage.Sizes(targets)
		respond(w, 200, map[string]any{"sizes": sizes, "measuring": measuring, "pending": pending})
		return true
	}
	return false
}
