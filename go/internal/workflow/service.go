package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"time"

	"relay.local/relay/internal/store"
	"relay.local/relay/internal/workspace"
)

// DecisionStore exposes the atomic subset needed by approval gates.
type DecisionStore interface {
	Get(string) (json.RawMessage, error)
	GetMeta(string) (string, bool, error)
	CompareAndSwapWithMeta(string, json.RawMessage, json.RawMessage, json.RawMessage, map[string]store.MetaSnapshot) (json.RawMessage, error)
}
type Service struct {
	Store DecisionStore
	Now   func() time.Time
}

func (s Service) snapshot(id string, auth Authorization) (json.RawMessage, map[string]any, map[string]any, map[string]store.MetaSnapshot, error) {
	if s.Store == nil {
		return nil, nil, nil, nil, errors.New("decision store unavailable")
	}
	raw, err := s.Store.Get(id)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	var task map[string]any
	if json.Unmarshal(raw, &task) != nil || task == nil {
		return nil, nil, nil, nil, errors.New("invalid stored task")
	}
	automation := map[string]any{"enabled": false, "scope": "reviewed"}
	guards := map[string]store.MetaSnapshot{}
	if !auth.Human {
		key := "automation:" + id
		value, exists, err := s.Store.GetMeta(key)
		if err != nil {
			return nil, nil, nil, nil, err
		}
		guards[key] = store.MetaSnapshot{Value: value, Exists: exists}
		if exists {
			if json.Unmarshal([]byte(value), &automation) != nil || automation == nil {
				return nil, nil, nil, nil, errors.New("invalid automation state")
			}
		}
	}
	return raw, task, automation, guards, nil
}
func (s Service) commit(id string, expected json.RawMessage, result GateResult, guards map[string]store.MetaSnapshot) (json.RawMessage, error) {
	next, err := json.Marshal(result.Task)
	if err != nil {
		return nil, err
	}
	event, err := json.Marshal(result.Event)
	if err != nil {
		return nil, err
	}
	return s.Store.CompareAndSwapWithMeta(id, expected, next, event, guards)
}
func (s Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Approve requires authority already established by a future authenticated API.
func (s Service) Approve(id, optionID, note string, auth Authorization) (json.RawMessage, error) {
	raw, task, automation, guards, err := s.snapshot(id, auth)
	if err != nil {
		return nil, err
	}
	result, err := ApprovePlan(task, optionID, note, auth, automation, s.now())
	if err != nil {
		return nil, err
	}
	return s.commit(id, raw, result, guards)
}

type Inspector interface {
	Snapshot(context.Context, []workspace.Workspace) (workspace.FingerprintSnapshot, error)
}

// AcceptVerified scans the current workspaces while holding their lease, then
// atomically commits only if the task and delegation have not changed. The
// caller must have authenticated the human or explicit Auto authorization.
func (s Service) AcceptVerified(ctx context.Context, id string, auth Authorization, lease *workspace.Lease, inspector Inspector) (json.RawMessage, error) {
	if ctx == nil || inspector == nil {
		return nil, errors.New("workspace inspection is required")
	}
	inspectorValue := reflect.ValueOf(inspector)
	if inspectorValue.Kind() == reflect.Pointer && inspectorValue.IsNil() {
		return nil, errors.New("workspace inspection is required")
	}
	raw, task, automation, guards, err := s.snapshot(id, auth)
	if err != nil {
		return nil, err
	}
	if task["demo"] == true {
		return nil, errors.New("use demo acceptance for simulated tasks")
	}
	if err = validateState(task, false); err != nil {
		return nil, err
	}
	for _, value := range array(task["reviewComments"]) {
		if text(object(value)["status"]) == "open" {
			return nil, errors.New("Resolve inline comments or request focused repairs before acceptance")
		}
	}
	if hasPending(task) {
		return nil, errors.New("Pending direction must be processed before acceptance. Request changes first.")
	}
	if text(task["status"]) != "awaiting_final" {
		return nil, errors.New("Task is not awaiting final approval")
	}
	if _, err = authenticate(auth, automation); err != nil {
		return nil, err
	}
	entries := array(task["repositories"])
	if len(entries) <= 1 {
		entries = []any{task}
	}
	workspaces := make([]workspace.Workspace, 0, len(entries))
	roots := make([]string, 0, len(entries))
	for _, value := range entries {
		entry := object(value)
		id := text(object(entry["repository"])["id"])
		root := text(entry["workspaceRoot"])
		if id == "" || root == "" {
			return nil, errors.New("task workspaces are incomplete")
		}
		workspaces = append(workspaces, workspace.Workspace{RepositoryID: id, Root: root})
		roots = append(roots, root)
	}
	var output json.RawMessage
	err = lease.Protect(id, roots, func(revalidate func() error) error {
		snapshot, err := inspector.Snapshot(ctx, workspaces)
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		result, err := AcceptFinal(task, Fingerprints{Combined: snapshot.Combined, Repositories: snapshot.Repositories}, auth, automation, s.now())
		if err != nil {
			return err
		}
		if err = revalidate(); err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		output, err = s.commit(id, raw, result, guards)
		return err
	})
	return output, err
}

// AcceptDemo is limited to explicitly simulated tasks and never scans a repo.
func (s Service) AcceptDemo(id string, auth Authorization) (json.RawMessage, error) {
	raw, task, automation, guards, err := s.snapshot(id, auth)
	if err != nil {
		return nil, err
	}
	if task["demo"] != true {
		return nil, errors.New("task is not simulated")
	}
	result, err := AcceptFinal(task, Fingerprints{}, auth, automation, s.now())
	if err != nil {
		return nil, err
	}
	return s.commit(id, raw, result, guards)
}
