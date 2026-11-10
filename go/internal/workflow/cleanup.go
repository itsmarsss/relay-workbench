package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"relay.local/relay/internal/store"
	"time"

	"relay.local/relay/internal/harness"
	"relay.local/relay/internal/workspace"
)

// Cleanup reserves the task and shared repositories for the whole operation.
// Each removal is recorded independently, so a partial failure is retryable.
func (c *Coordinator) Cleanup(ctx context.Context, id string, body map[string]any) (any, error) {
	if err := fields(body, "includeIgnored"); err != nil {
		return nil, err
	}
	includeIgnored, ok := body["includeIgnored"].(bool)
	if !ok {
		return nil, errors.New("choose whether to remove ignored files")
	}
	c.mu.Lock()
	if c.closed || c.jobs[id] != nil || len(c.jobs) >= 256 {
		c.mu.Unlock()
		return nil, ErrStageBusy
	}
	_, value, err := c.inspected(id, body)
	if err != nil {
		c.mu.Unlock()
		return nil, err
	}
	if !harness.HasFinalApproval(value) || value["demo"] == true || value["status"] != "completed" && value["status"] != "finished" {
		c.mu.Unlock()
		return nil, errors.New("cleanup requires a finished, accepted task")
	}
	entries, err := profiles(value)
	if err != nil {
		c.mu.Unlock()
		return nil, err
	}
	for _, entry := range entries {
		if text(object(entry["publication"])["url"]) == "" {
			c.mu.Unlock()
			return nil, errors.New("publish every repository before cleaning up")
		}
		strategy := text(object(entry["repository"])["strategy"])
		if strategy == "attach" || strategy == "managed" {
			c.mu.Unlock()
			return nil, errors.New("external managed and attached workspaces must be cleaned by their owner")
		}
	}
	jobCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	job := &coordinatorJob{cancel: cancel, done: make(chan struct{})}
	c.jobs[id] = job
	c.mu.Unlock()
	defer func() {
		cancel()
		c.mu.Lock()
		delete(c.jobs, id)
		close(job.done)
		c.notifyLocked()
		c.mu.Unlock()
	}()
	repoLease, roots, err := c.reserveRepositories(jobCtx, id)
	if err != nil {
		return nil, err
	}
	defer repoLease.Release()
	runner := workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}
	drafts := []workspace.WorktreeDraft{}
	for _, entry := range entries {
		if object(entry["workspaceCleanup"])["status"] == "removed" {
			continue
		}
		profile := object(entry["repository"])
		head := text(entry["workspaceHead"])
		if head == "" {
			head = text(entry["baseCommit"])
		}
		draft := workspace.WorktreeDraft{TaskID: id, RepositoryID: text(profile["id"]), SourceRoot: text(profile["path"]), Root: text(entry["workspaceRoot"]), Cwd: text(entry["workspace"]), Branch: text(entry["branch"]), BaseCommit: head}
		if err = runner.CheckRemovable(jobCtx, c.area, draft, includeIgnored); err != nil {
			return nil, err
		}
		drafts = append(drafts, draft)
	}
	err = repoLease.Protect(id, roots, func(verify func() error) error {
		for _, draft := range drafts {
			if err := verify(); err != nil {
				return err
			}
			if err := runner.RemoveOwnedWorktree(jobCtx, c.area, draft, includeIgnored); err != nil {
				return err
			}
			_, err := c.update(id, func(current map[string]any) error {
				return updateWorkspace(current, draft.RepositoryID, func(target map[string]any) {
					target["workspaceCleanup"] = map[string]any{"status": "removed", "at": nowCheckpoint(), "root": draft.Root}
					delete(target, "workspaceRoot")
					delete(target, "workspace")
					for _, key := range []string{"publicationMonitor", "feedbackAutomation"} {
						if obj := object(target[key]); obj != nil {
							obj["enabled"], obj["status"] = false, "stopped"
						}
					}
				})
			}, map[string]any{"type": "workspace", "source": "relay", "repositoryId": draft.RepositoryID, "summary": "Removed a clean published worktree; branch and checkpoints retained."})
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	raw, err := c.store.Get(id)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err = json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	result["taskRevision"] = store.TaskRevision(raw)
	return result, nil
}
