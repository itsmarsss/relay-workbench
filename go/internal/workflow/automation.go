package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/workspace"
	"time"
)

func (c *Coordinator) setAutomation(id string, body map[string]any) (any, error) {
	if err := fields(body, "enabled", "scope"); err != nil {
		return nil, err
	}
	enabled, ok := body["enabled"].(bool)
	if !ok {
		return nil, errors.New("choose whether Auto is enabled")
	}
	scope := text(body["scope"])
	if scope != "reviewed" && scope != "draft_pr" {
		return nil, errors.New("choose Auto acceptance or draft publication")
	}
	c.mu.Lock()
	succeeded := false
	defer func() {
		c.mu.Unlock()
		if enabled && succeeded {
			go func() {
				raw, err := c.store.Get(id)
				var current map[string]any
				if err == nil && json.Unmarshal(raw, &current) == nil && (current["status"] == "awaiting_plan" || current["status"] == "awaiting_final") {
					if _, err = c.enqueueMode(id, true, true); err != nil && !errors.Is(err, ErrStageBusy) {
						_, _ = c.store.Event(id, mustJSON(map[string]any{"type": "auto_decision", "source": "relay", "summary": "Auto is enabled; awaiting the next stage or a manual resume: " + err.Error()}))
					}
				}
			}()
		}
	}()
	if c.closed {
		return nil, errors.New("Relay is shutting down")
	}
	raw, value, err := c.inspected(id, body)
	if err != nil {
		return nil, err
	}
	authorization, err := stageUUID()
	if err != nil {
		return nil, err
	}
	state := map[string]any{"enabled": enabled, "scope": scope, "authorizationId": authorization, "authorizedAt": timestamp(time.Now()), "source": "user"}
	value["automation"] = state
	next, _ := json.Marshal(value)
	encoded, _ := json.Marshal(state)
	event, _ := json.Marshal(map[string]any{"type": "automation", "source": "user", "summary": map[bool]string{true: "Auto delegation authorized for this task.", false: "Auto delegation revoked."}[enabled]})
	saved, err := c.store.CompareAndSwapMetadata(id, raw, next, event, nil, map[string]string{"automation:" + id: string(encoded)})
	if err != nil {
		return nil, err
	}
	json.Unmarshal(saved, &value)
	value["taskRevision"] = store.TaskRevision(saved)
	succeeded = true
	return value, nil
}

// The metadata snapshot is compared inside publication's transaction. A
// revocation between selection and enqueue cannot authorize a remote write.
func (c *Coordinator) autoPublish(id string) {
	raw, exists, err := c.store.GetMeta("automation:" + id)
	var delegation map[string]any
	if err != nil || !exists || json.Unmarshal([]byte(raw), &delegation) != nil || delegation["enabled"] != true || delegation["scope"] != "draft_pr" {
		return
	}
	taskRaw, err := c.store.Get(id)
	var value map[string]any
	if err != nil || json.Unmarshal(taskRaw, &value) != nil || value["status"] != "completed" {
		return
	}
	entries, err := profiles(value)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry["publication"] != nil || entry["delivery"] != nil {
			continue
		}
		_, err = c.publish(context.Background(), id, store.TaskRevision(taskRaw), text(object(entry["repository"])["id"]), map[string]store.MetaSnapshot{"automation:" + id: {Value: raw, Exists: true}})
		if err != nil {
			_, _ = c.store.Event(id, mustJSON(map[string]any{"type": "auto_decision", "source": "relay", "summary": "Automatic draft publication stopped: " + err.Error()}))
		}
		return
	}
}
func (c *Coordinator) automate(ctx context.Context, id string, value map[string]any, revalidate func() error) (bool, error) {
	raw, exists, err := c.store.GetMeta("automation:" + id)
	if err != nil {
		return false, err
	}
	if !exists {
		return false, nil
	}
	var delegation map[string]any
	if json.Unmarshal([]byte(raw), &delegation) != nil {
		return false, errors.New("invalid Auto authorization")
	}
	if delegation["enabled"] != true || delegation["error"] != nil {
		return false, nil
	}
	auth := Authorization{AutomationID: text(delegation["authorizationId"]), Scope: text(delegation["scope"])}
	service := Service{Store: c.store}
	switch value["status"] {
	case "awaiting_plan":
		plan := CompletedPlan(value)
		recommendation := text(plan["recommendedOptionId"])
		if recommendation == "" {
			return false, nil
		}
		if err = revalidate(); err != nil {
			return false, err
		}
		_, err = service.Approve(id, recommendation, "Auto selected the agent's recommended approach.", auth)
	case "awaiting_final":
		entries, readErr := stageWorkspaces(value)
		if readErr != nil {
			return false, readErr
		}
		roots := []string{}
		for _, entry := range entries {
			roots = append(roots, entry.root)
		}
		lease, readErr := c.registry.Acquire(id, roots)
		if readErr != nil {
			return false, readErr
		}
		defer lease.Release()
		_, err = service.AcceptVerifiedWithGuard(ctx, id, auth, lease, workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}, revalidate)
	default:
		return false, nil
	}
	if errors.Is(err, store.ErrMetadataChanged) || errors.Is(err, store.ErrTaskChanged) {
		return false, nil
	}
	if err != nil {
		// A failed automatic choice returns to the existing human gate, never to the debugger.
		_, _ = c.store.Event(id, mustJSON(map[string]any{"type": "auto_decision", "source": "relay", "summary": "Auto stopped at this decision: " + err.Error()}))
		return false, nil
	}
	_, _ = c.store.Event(id, mustJSON(map[string]any{"type": "auto_decision", "source": "relay", "summary": "Auto applied the authorized " + text(value["status"]) + " decision."}))
	return true, nil
}
func mustJSON(value any) json.RawMessage { raw, _ := json.Marshal(value); return raw }
