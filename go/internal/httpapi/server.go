// Package httpapi exposes the isolated migration API. Workflow execution is not yet available.
package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/tasksummary"
)

var taskID = regexp.MustCompile(`^[a-f0-9-]{36}$`)

type Server struct {
	store        *store.Store
	host, webDir string
	streams      chan struct{}
	token        [32]byte
}

func New(db *store.Store, port int, webDir string) (*Server, error) {
	if db == nil || port < 1 || port > 65535 || webDir == "" {
		return nil, errors.New("invalid preview server configuration")
	}
	root, err := filepath.EvalSymlinks(webDir)
	if err != nil {
		return nil, err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil, errors.New("web directory must exist")
	}
	server := &Server{store: db, host: fmt.Sprintf("127.0.0.1:%d", port), webDir: root, streams: make(chan struct{}, 64)}
	if _, err = rand.Read(server.token[:]); err != nil {
		return nil, err
	}
	return server, nil
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	if r.Host != s.host || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != "http://"+s.host) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		respond(w, http.StatusForbidden, map[string]string{"error": "Invalid local origin"})
		return
	}
	path := r.URL.Path
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		if (path != "/api/tasks" || r.Method != http.MethodPost) && (path != "/api/config" || r.Method != http.MethodPut) {
			w.Header().Set("Allow", "GET, HEAD")
			respond(w, http.StatusMethodNotAllowed, map[string]string{"error": "Workflow actions are not ported yet"})
			return
		}
		supplied, err := hex.DecodeString(r.Header.Get("X-Relay-Token"))
		if err != nil || len(supplied) != len(s.token) || subtle.ConstantTimeCompare(supplied, s.token[:]) != 1 {
			respond(w, 403, map[string]string{"error": "Session token required"})
			return
		}
		s.mutate(w, r)
		return
	}
	if path == "/api/bootstrap" {
		config, err := (task.ConfigurationService{Store: s.store}).Read()
		if err != nil {
			respond(w, 500, map[string]string{"error": "Could not read configuration"})
			return
		}
		respond(w, 200, map[string]any{"token": hex.EncodeToString(s.token[:]), "config": config.Value, "configRevision": config.Revision, "version": "experimental-go"})
		return
	}
	if path == "/api/health" {
		respond(w, http.StatusOK, map[string]any{"ok": true, "running": 0, "monitoring": 0, "version": "experimental-go"})
		return
	}
	if path == "/api/events" {
		s.events(w, r)
		return
	}
	if path == "/api/tasks" {
		result := []map[string]any{}
		err := s.store.Visit(func(row store.Task) error {
			summary, err := tasksummary.Summarize(row)
			if err != nil {
				return err
			}
			if id, ok := summary["id"].(string); !ok || !taskID.MatchString(id) {
				return errors.New("invalid task ID")
			}
			result = append(result, summary)
			return nil
		})
		if err != nil {
			respond(w, 500, map[string]string{"error": "Could not read tasks"})
			return
		}
		respond(w, 200, result)
		return
	}
	if strings.HasPrefix(path, "/api/tasks/") {
		parts := strings.Split(strings.TrimPrefix(path, "/api/tasks/"), "/")
		if len(parts) < 1 || !taskID.MatchString(parts[0]) {
			respond(w, 400, map[string]string{"error": "Invalid task ID"})
			return
		}
		if len(parts) == 1 {
			task, err := s.store.Get(parts[0])
			if errors.Is(err, os.ErrNotExist) {
				respond(w, 404, map[string]string{"error": "Task not found"})
				return
			}
			if err != nil {
				respond(w, 500, map[string]string{"error": "Could not read task"})
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_, _ = w.Write(task)
			return
		}
		if len(parts) == 2 && parts[1] == "events" {
			cursor := r.URL.Query().Get("after")
			if cursor == "" {
				cursor = "0"
			}
			after, err := strconv.ParseInt(cursor, 10, 64)
			if err != nil || after < 0 {
				respond(w, 400, map[string]string{"error": "Invalid event cursor"})
				return
			}
			rows, err := s.store.Events(parts[0], after, 1000)
			if err != nil {
				respond(w, 500, map[string]string{"error": "Could not read events"})
				return
			}
			respond(w, 200, rows)
			return
		}
	}
	if strings.HasPrefix(path, "/api/") {
		respond(w, 404, map[string]string{"error": "Endpoint not yet ported"})
		return
	}
	s.asset(w, r)
}
func requestObject(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return nil, errors.New("Content-Type must be application/json")
	}
	body := http.MaxBytesReader(w, r.Body, 1024*1024)
	defer body.Close()
	raw, err := io.ReadAll(body)
	if err != nil {
		return nil, errors.New("request body too large or unreadable")
	}
	var result map[string]any
	if json.Unmarshal(raw, &result) != nil || result == nil {
		return nil, errors.New("invalid JSON object")
	}
	return result, nil
}
func (s *Server) mutate(w http.ResponseWriter, r *http.Request) {
	raw, err := requestObject(w, r)
	if err != nil {
		respond(w, 400, map[string]string{"error": err.Error()})
		return
	}
	config := task.ConfigurationService{Store: s.store}
	if r.URL.Path == "/api/config" {
		result, err := config.Replace(r.Header.Get("If-Match"), raw)
		if errors.Is(err, store.ErrConfigChanged) {
			respond(w, 409, map[string]string{"error": "Configuration changed; refresh before saving"})
			return
		}
		if err != nil {
			respond(w, 400, map[string]string{"error": err.Error()})
			return
		}
		respond(w, 200, result)
		return
	}
	created, err := config.CreateTask(raw)
	if errors.Is(err, store.ErrConfigChanged) || errors.Is(err, store.ErrTaskExists) {
		respond(w, 409, map[string]string{"error": "Task or configuration changed; retry"})
		return
	}
	if err != nil {
		respond(w, 400, map[string]string{"error": err.Error()})
		return
	}
	respond(w, 201, created)
}

func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", "text/event-stream")
		return
	}
	_, ok := w.(http.Flusher)
	if !ok {
		respond(w, 500, map[string]string{"error": "Streaming unavailable"})
		return
	}
	select {
	case s.streams <- struct{}{}:
		defer func() { <-s.streams }()
	default:
		respond(w, 503, map[string]string{"error": "Too many streams"})
		return
	}
	changes, unsubscribe := s.store.Subscribe()
	defer unsubscribe()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	write := func(message string) error {
		_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
		defer controller.SetWriteDeadline(time.Time{})
		if _, err := fmt.Fprint(w, message); err != nil {
			return err
		}
		return controller.Flush()
	}
	if err := write(": connected\n\n"); err != nil {
		return
	}
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case _, ok := <-changes:
			if !ok {
				return
			}
			if err := write("data: {}\n\n"); err != nil {
				return
			}
		case <-ticker.C:
			if err := write(": keepalive\n\n"); err != nil {
				return
			}
		}
	}
}
func (s *Server) asset(w http.ResponseWriter, r *http.Request) {
	names := map[string]string{"/": "index.html", "/main.js": "main.js", "/main.css": "main.css"}
	name, ok := names[r.URL.Path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	path, err := filepath.EvalSymlinks(filepath.Join(s.webDir, name))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	relative, err := filepath.Rel(s.webDir, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) || filepath.IsAbs(relative) {
		http.NotFound(w, r)
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	switch filepath.Ext(name) {
	case ".html":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	case ".js":
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	case ".css":
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	}
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}

// ShutdownTimeout bounds a graceful shutdown when clients hold event streams.
func ShutdownTimeout() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 5*time.Second)
}
