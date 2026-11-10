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
	"math"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"relay.local/relay/internal/issue"
	"relay.local/relay/internal/storage"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/tasksummary"
)

var taskID = regexp.MustCompile(`^[a-f0-9-]{36}$`)
var taskRevision = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Server struct {
	store        *store.Store
	host, webDir string
	streams      chan struct{}
	token        [32]byte
	workflow     Coordinator
	assistant    Assistant
}

// Coordinator is supplied by the local server, never by an HTTP request.
type Coordinator interface {
	Start(string) (map[string]any, error)
	Resume(string) (map[string]any, error)
	Approve(context.Context, string, string, string, string, string) (map[string]any, error)
	Accept(context.Context, string, string) (map[string]any, error)
	Publish(context.Context, string, string, string) (map[string]any, error)
	Resolve(context.Context, string, string, string, string, string, string) (map[string]any, error)
	Diff(context.Context, string) (map[string]any, error)
	ImportIssue(context.Context, string, string, string) (issue.Result, error)
	Pause(string) error
	Running() int
}

func New(db *store.Store, port int, webDir string) (*Server, error) {
	return NewWithCoordinator(db, port, webDir, nil)
}

func NewWithCoordinator(db *store.Store, port int, webDir string, workflow Coordinator) (*Server, error) {
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
	server := &Server{store: db, host: fmt.Sprintf("127.0.0.1:%d", port), webDir: root, streams: make(chan struct{}, 64), workflow: workflow}
	if _, err = rand.Read(server.token[:]); err != nil {
		return nil, err
	}
	return server, nil
}

// SetCoordinator must be called before the HTTP server starts serving.
func (s *Server) SetCoordinator(coordinator Coordinator) { s.workflow = coordinator }
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	if r.Host != s.host || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != "http://"+s.host) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		respond(w, http.StatusForbidden, map[string]string{"error": "Invalid local origin"})
		return
	}
	if s.extended(w, r) {
		return
	}
	path := r.URL.Path
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		if path == "/api/issues/import" && r.Method == http.MethodPost && s.workflow != nil {
			if !s.authorized(r) {
				respond(w, 403, map[string]string{"error": "Session token required"})
				return
			}
			s.importIssue(w, r)
			return
		}
		if id, action, ok := workflowAction(path); ok && r.Method == http.MethodPost && s.workflow != nil {
			if !s.authorized(r) {
				respond(w, 403, map[string]string{"error": "Session token required"})
				return
			}
			s.runWorkflowAction(w, r, id, action)
			return
		}
		if (path != "/api/tasks" || r.Method != http.MethodPost) && (path != "/api/config" || r.Method != http.MethodPut) && (path != "/api/storage/policy" || r.Method != http.MethodPut) {
			w.Header().Set("Allow", "GET, HEAD")
			respond(w, http.StatusMethodNotAllowed, map[string]string{"error": "Workflow actions are not ported yet"})
			return
		}
		if !s.authorized(r) {
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
		respond(w, 200, map[string]any{"token": hex.EncodeToString(s.token[:]), "config": config.Value, "configRevision": config.Revision, "version": "experimental-go", "workflowPreview": s.workflow != nil, "implementationPreview": s.workflow != nil, "debugRecoveryPreview": s.workflow != nil, "issueImportPreview": s.workflow != nil, "publicationPreview": s.workflow != nil})
		return
	}
	if path == "/api/storage/scan" {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			respond(w, 405, map[string]string{"error": "Use GET to inspect storage"})
			return
		}
		if !s.authorized(r) {
			respond(w, 403, map[string]string{"error": "Session token required"})
			return
		}
		s.scanStorage(w, r)
		return
	}
	if path == "/api/storage/pressure" {
		policy, err := (storage.PolicyService{Store: s.store}).Read()
		if err != nil {
			respond(w, 500, map[string]string{"error": "Could not read storage policy"})
			return
		}
		var space storage.Space
		err = s.store.WithOwnership(func(root string, verify func() error) error {
			var probeErr error
			space, probeErr = storage.ProbeWithTimeout(r.Context(), root, 2*time.Second, storage.Filesystem)
			if probeErr != nil {
				return probeErr
			}
			return verify()
		})
		if err != nil {
			respond(w, 500, map[string]string{"error": "Could not inspect the Relay data volume"})
			return
		}
		pressure, err := storage.Evaluate(policy.Policy, space)
		if err != nil {
			respond(w, 500, map[string]string{"error": "Could not evaluate storage pressure"})
			return
		}
		respond(w, 200, map[string]any{"pressure": pressure, "policy": policy.Policy, "revision": policy.Revision, "scope": "Relay data volume", "admissionEnforced": false, "automaticCleanup": false})
		return
	}
	if path == "/api/health" {
		running := 0
		if s.workflow != nil {
			running = s.workflow.Running()
		}
		respond(w, http.StatusOK, map[string]any{"ok": true, "running": running, "monitoring": 0, "version": "experimental-go"})
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
			summary["taskRevision"] = store.TaskRevision(row)
			var value map[string]any
			if json.Unmarshal(row, &value) == nil {
				for _, key := range []string{"statusOverride", "ticket", "repositories"} {
					if item, ok := value[key]; ok {
						summary[key] = item
					}
				}
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
			var body map[string]json.RawMessage
			if json.Unmarshal(task, &body) != nil || body == nil {
				respond(w, 500, map[string]string{"error": "Invalid stored task"})
				return
			}
			body["taskRevision"], _ = json.Marshal(store.TaskRevision(task))
			summary, err := tasksummary.Summarize(task)
			if err != nil {
				respond(w, 500, map[string]string{"error": "Invalid task summary"})
				return
			}
			for _, key := range []string{"currentRun", "latestSummary"} {
				if value, exists := summary[key]; exists {
					body[key], _ = json.Marshal(value)
				}
			}
			respond(w, 200, body)
			return
		}
		if len(parts) == 2 && parts[1] == "events" {
			if r.URL.Query().Has("before") {
				before, err := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
				if err != nil || before < 0 || r.URL.Query().Has("after") {
					respond(w, 400, map[string]string{"error": "Invalid event cursor"})
					return
				}
				rows, err := s.store.EventsBefore(parts[0], before, 200)
				if err != nil {
					respond(w, 500, map[string]string{"error": "Could not read events"})
				} else {
					respond(w, 200, rows)
				}
				return
			}
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
		if len(parts) == 2 && parts[1] == "diff" && s.workflow != nil {
			result, err := s.workflow.Diff(r.Context(), parts[0])
			if errors.Is(err, os.ErrNotExist) {
				respond(w, 404, map[string]string{"error": "Task not found"})
			} else if err != nil {
				respond(w, 409, map[string]string{"error": err.Error()})
			} else {
				respond(w, 200, result)
			}
			return
		}
	}
	if strings.HasPrefix(path, "/api/") {
		respond(w, 404, map[string]string{"error": "Endpoint not yet ported"})
		return
	}
	s.asset(w, r)
}

func (s *Server) importIssue(w http.ResponseWriter, r *http.Request) {
	body, err := requestObject(w, r)
	if err != nil || len(body) != 3 {
		respond(w, 400, map[string]string{"error": "Provide repository, configuration revision and ticket"})
		return
	}
	repositoryID, idOK := body["repositoryId"].(string)
	revision, revisionOK := body["configRevision"].(string)
	ticket, ticketOK := body["ticket"].(string)
	if !idOK || repositoryID == "" || len(repositoryID) > 400 || !revisionOK || !taskRevision.MatchString(revision) || !ticketOK {
		respond(w, 400, map[string]string{"error": "Provide repository, configuration revision and ticket"})
		return
	}
	result, err := s.workflow.ImportIssue(r.Context(), repositoryID, revision, ticket)
	var importError *issue.ImportError
	if errors.Is(err, store.ErrConfigChanged) {
		respond(w, 409, map[string]string{"error": "Repository settings changed; refresh before importing"})
	} else if errors.As(err, &importError) {
		respond(w, importError.Status, map[string]string{"error": importError.Message})
	} else if err != nil {
		respond(w, 502, map[string]string{"error": err.Error()})
	} else {
		respond(w, 200, result)
	}
}

func workflowAction(path string) (string, string, bool) {
	if !strings.HasPrefix(path, "/api/tasks/") {
		return "", "", false
	}
	parts := strings.Split(strings.TrimPrefix(path, "/api/tasks/"), "/")
	if len(parts) != 2 || !taskID.MatchString(parts[0]) || (parts[1] != "start" && parts[1] != "resume" && parts[1] != "pause" && parts[1] != "approve-plan" && parts[1] != "accept" && parts[1] != "resolve-blocker" && parts[1] != "publish") {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func (s *Server) runWorkflowAction(w http.ResponseWriter, r *http.Request, id, action string) {
	body, err := requestObject(w, r)
	if err != nil {
		respond(w, 400, map[string]string{"error": "Invalid workflow action"})
		return
	}
	if action == "publish" {
		revision, valid := body["taskRevision"].(string)
		repositoryID, repoValid := body["repositoryId"].(string)
		if !valid || !taskRevision.MatchString(revision) || !repoValid || repositoryID == "" || len(repositoryID) > 200 || len(body) != 2 {
			respond(w, 400, map[string]string{"error": "Refresh and select a task repository before publishing"})
			return
		}
		result, err := s.workflow.Publish(r.Context(), id, revision, repositoryID)
		if errors.Is(err, os.ErrNotExist) {
			respond(w, 404, map[string]string{"error": "Task not found"})
		} else if err != nil {
			respond(w, 409, map[string]string{"error": err.Error()})
		} else {
			respond(w, 202, result)
		}
		return
	}
	if action == "resolve-blocker" {
		decisionID, decisionValid := body["decisionId"].(string)
		revision, revisionValid := body["taskRevision"].(string)
		resolution, resolutionValid := body["resolution"].(string)
		if !decisionValid || decisionID == "" || len(decisionID) > 200 || !revisionValid || !taskRevision.MatchString(revision) || !resolutionValid {
			respond(w, 400, map[string]string{"error": "Refresh and choose a valid blocker decision"})
			return
		}
		for key := range body {
			if key != "decisionId" && key != "taskRevision" && key != "resolution" && key != "optionId" && key != "note" {
				respond(w, 400, map[string]string{"error": "Blocker decisions do not accept extra fields"})
				return
			}
		}
		optionID, note := "", ""
		if value, exists := body["optionId"]; exists {
			var valid bool
			optionID, valid = value.(string)
			if !valid || len(optionID) > 100000 {
				respond(w, 400, map[string]string{"error": "Invalid blocker option"})
				return
			}
		}
		if value, exists := body["note"]; exists {
			var valid bool
			note, valid = value.(string)
			if !valid {
				respond(w, 400, map[string]string{"error": "Invalid blocker direction"})
				return
			}
		}
		result, err := s.workflow.Resolve(r.Context(), id, revision, decisionID, resolution, optionID, note)
		if errors.Is(err, os.ErrNotExist) {
			respond(w, 404, map[string]string{"error": "Task not found"})
		} else if err != nil {
			respond(w, 409, map[string]string{"error": err.Error()})
		} else if resolution == "pause" {
			respond(w, 200, result)
		} else {
			respond(w, 202, result)
		}
		return
	}
	if action == "approve-plan" {
		optionID, valid := body["optionId"].(string)
		if !valid || optionID == "" || len(optionID) > 100000 {
			respond(w, 400, map[string]string{"error": "Choose a valid approach"})
			return
		}
		attemptID, attemptValid := body["planAttemptId"].(string)
		revision, revisionValid := body["taskRevision"].(string)
		if !attemptValid || !revisionValid || attemptID == "" || len(attemptID) > 200 || !taskRevision.MatchString(revision) {
			respond(w, 400, map[string]string{"error": "Refresh the proposal before approving"})
			return
		}
		for key := range body {
			if key != "optionId" && key != "note" && key != "planAttemptId" && key != "taskRevision" {
				respond(w, 400, map[string]string{"error": "Approval does not accept extra fields"})
				return
			}
		}
		note := ""
		if value, exists := body["note"]; exists {
			note, valid = value.(string)
			if !valid {
				respond(w, 400, map[string]string{"error": "Invalid approval note"})
				return
			}
		}
		result, err := s.workflow.Approve(r.Context(), id, optionID, note, attemptID, revision)
		if errors.Is(err, os.ErrNotExist) {
			respond(w, 404, map[string]string{"error": "Task not found"})
		} else if err != nil {
			respond(w, 409, map[string]string{"error": err.Error()})
		} else {
			respond(w, 202, result)
		}
		return
	}
	if action == "accept" {
		revision, valid := body["taskRevision"].(string)
		if !valid || len(body) != 1 || !taskRevision.MatchString(revision) {
			respond(w, 400, map[string]string{"error": "Refresh the task before accepting"})
			return
		}
		result, err := s.workflow.Accept(r.Context(), id, revision)
		if errors.Is(err, os.ErrNotExist) {
			respond(w, 404, map[string]string{"error": "Task not found"})
		} else if err != nil {
			respond(w, 409, map[string]string{"error": err.Error()})
		} else {
			respond(w, 200, result)
		}
		return
	}
	if len(body) != 0 {
		respond(w, 400, map[string]string{"error": "Workflow actions do not accept extra fields"})
		return
	}
	if action == "start" || action == "resume" {
		var result map[string]any
		if action == "start" {
			result, err = s.workflow.Start(id)
		} else {
			result, err = s.workflow.Resume(id)
		}
		if errors.Is(err, os.ErrNotExist) {
			respond(w, 404, map[string]string{"error": "Task not found"})
		} else if err != nil {
			respond(w, 409, map[string]string{"error": err.Error()})
		} else {
			respond(w, 202, result)
		}
		return
	}
	if err = s.workflow.Pause(id); err != nil {
		respond(w, 409, map[string]string{"error": err.Error()})
		return
	}
	result, err := s.store.Get(id)
	if err != nil {
		respond(w, 500, map[string]string{"error": "Could not read paused task"})
		return
	}
	respond(w, 200, result)
}
func (s *Server) authorized(r *http.Request) bool {
	supplied, err := hex.DecodeString(r.Header.Get("X-Relay-Token"))
	return err == nil && len(supplied) == len(s.token) && subtle.ConstantTimeCompare(supplied, s.token[:]) == 1
}
func (s *Server) scanStorage(w http.ResponseWriter, r *http.Request) {
	policy, err := (storage.PolicyService{Store: s.store}).Read()
	if err != nil {
		respond(w, 500, map[string]string{"error": "Could not read storage policy"})
		return
	}
	if r.URL.Query().Get("revision") != policy.Revision {
		respond(w, 409, map[string]string{"error": "Storage policy changed; refresh before scanning"})
		return
	}
	index, err := strconv.Atoi(r.URL.Query().Get("index"))
	if err != nil || index < 0 || index >= len(policy.Policy.MonitoredPaths) {
		respond(w, 400, map[string]string{"error": "Choose a monitored path"})
		return
	}
	path := policy.Policy.MonitoredPaths[index]
	result, err := storage.ScanWithTimeout(r.Context(), path, 100000, 5*time.Second, nil)
	if err != nil {
		respond(w, 503, map[string]string{"error": "Could not complete the storage scan"})
		return
	}
	current, err := (storage.PolicyService{Store: s.store}).Read()
	if err != nil {
		respond(w, 500, map[string]string{"error": "Could not read storage policy"})
		return
	}
	if current.Revision != policy.Revision {
		respond(w, 409, map[string]string{"error": "Storage policy changed; refresh before scanning"})
		return
	}
	response := map[string]any{"path": path, "revision": policy.Revision, "scan": result}
	space, err := storage.ProbeWithTimeout(r.Context(), path, 2*time.Second, storage.Filesystem)
	if err == nil {
		if pressure, evaluateErr := storage.Evaluate(policy.Policy, space); evaluateErr == nil {
			response["pressure"] = pressure
		} else {
			response["spaceError"] = "Could not evaluate available space"
		}
	} else {
		response["spaceError"] = "Could not inspect available space"
	}
	current, err = (storage.PolicyService{Store: s.store}).Read()
	if err != nil {
		respond(w, 500, map[string]string{"error": "Could not read storage policy"})
		return
	}
	if current.Revision != policy.Revision {
		respond(w, 409, map[string]string{"error": "Storage policy changed; refresh before scanning"})
		return
	}
	respond(w, 200, response)
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
	if r.URL.Path == "/api/storage/policy" {
		required := []string{"enabled", "warningPercent", "criticalPercent", "warningBytes", "criticalBytes", "monitoredPaths"}
		if len(raw) != len(required) {
			respond(w, 400, map[string]string{"error": "Provide every storage threshold"})
			return
		}
		for _, key := range required {
			if _, ok := raw[key]; !ok {
				respond(w, 400, map[string]string{"error": "Provide every storage threshold"})
				return
			}
		}
		paths, ok := raw["monitoredPaths"].([]any)
		if !ok {
			respond(w, 400, map[string]string{"error": "Invalid monitored paths"})
			return
		}
		for _, value := range paths {
			if _, ok := value.(string); !ok {
				respond(w, 400, map[string]string{"error": "Invalid monitored paths"})
				return
			}
		}
		if _, ok := raw["enabled"].(bool); !ok {
			respond(w, 400, map[string]string{"error": "Invalid storage policy"})
			return
		}
		for _, key := range []string{"warningPercent", "criticalPercent", "warningBytes", "criticalBytes"} {
			value, ok := raw[key].(float64)
			if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > float64((1<<53)-1) || math.Trunc(value) != value {
				respond(w, 400, map[string]string{"error": "Invalid storage policy"})
				return
			}
		}
		data, err := json.Marshal(raw)
		if err != nil {
			respond(w, 400, map[string]string{"error": "Invalid storage policy"})
			return
		}
		var policy storage.Policy
		if json.Unmarshal(data, &policy) != nil {
			respond(w, 400, map[string]string{"error": "Invalid storage policy"})
			return
		}
		result, err := (storage.PolicyService{Store: s.store}).Replace(r.Header.Get("If-Match"), policy)
		if errors.Is(err, storage.ErrPolicyChanged) {
			respond(w, 409, map[string]string{"error": "Storage policy changed; refresh before saving"})
			return
		}
		if err != nil {
			respond(w, 400, map[string]string{"error": err.Error()})
			return
		}
		respond(w, 200, result)
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
