package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"relay.local/relay/internal/harness"
	"relay.local/relay/internal/process"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/workspace"
)

// allPullRequestsMerged is whether every repository of the task has a pull request (published by
// Relay or linked by hand) that was last seen merged: the work has landed, whatever the task's own
// status says.
func allPullRequestsMerged(value map[string]any) bool {
	entries := array(value["repositories"])
	if len(entries) <= 1 {
		entries = []any{value}
	}
	for _, item := range entries {
		entry := object(item)
		pr := object(entry["publication"])
		if text(pr["url"]) == "" {
			pr = object(entry["pullRequestLink"])
		}
		if text(pr["url"]) == "" || text(pr["state"]) != "merged" {
			return false
		}
	}
	return len(entries) > 0
}

// managedWorkspaceName is the name a managed workspace was created under ({workspaceName}), read
// back from its checkout path: the path component that starts with "relay-" and the task id.
func managedWorkspaceName(root, taskID string) string {
	for dir := filepath.Clean(root); dir != "/" && dir != "."; dir = filepath.Dir(dir) {
		if strings.HasPrefix(filepath.Base(dir), "relay-"+taskID) {
			return filepath.Base(dir)
		}
	}
	return ""
}

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
	if job := c.jobs[id]; c.closed || job != nil || len(c.jobs) >= 256 {
		c.mu.Unlock()
		if job != nil {
			return nil, busyLocked(job)
		}
		return nil, ErrStageBusy
	}
	_, value, err := c.inspected(id, body)
	if err != nil {
		c.mu.Unlock()
		return nil, err
	}
	// Either Relay saw the work through to acceptance, or its pull requests have merged.
	accepted := harness.HasFinalApproval(value) && (value["status"] == "completed" || value["status"] == "finished")
	merged := allPullRequestsMerged(value)
	if status := text(value["status"]); value["demo"] == true || status == "running" || status == "queued" || status == "manual" || (!accepted && !merged) {
		c.mu.Unlock()
		return nil, errors.New("cleanup needs an accepted task, or one whose pull requests have all merged")
	}
	config, err := (task.ConfigurationService{Store: c.store}).Read()
	if err != nil {
		c.mu.Unlock()
		return nil, err
	}
	current := map[string]map[string]any{}
	for _, item := range array(config.Value["repositories"]) {
		profile := object(item)
		current[text(profile["id"])] = profile
	}
	entries, err := profiles(value)
	if err != nil {
		c.mu.Unlock()
		return nil, err
	}
	for _, entry := range entries {
		if !merged && text(object(entry["publication"])["url"]) == "" {
			c.mu.Unlock()
			return nil, errors.New("publish every repository before cleaning up")
		}
		repo := object(entry["repository"])
		switch text(repo["strategy"]) {
		case "attach":
			c.mu.Unlock()
			return nil, errors.New("attached checkouts belong to their owner; Relay does not remove them")
		case "managed":
			// A managed workspace is removed the way it was made: by the profile's own command.
			if object(current[text(repo["id"])]["cleanupCommand"]) == nil && object(entry["workspaceCleanup"])["status"] != "removed" {
				c.mu.Unlock()
				return nil, fmt.Errorf("%s workspaces are made by its own command; add a cleanupCommand to its profile in Repositories, or remove the checkout yourself", text(repo["name"]))
			}
		}
	}
	jobCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	job := &coordinatorJob{cancel: cancel, done: make(chan struct{}), kind: "cleanup"}
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
		if text(profile["strategy"]) == "managed" {
			continue
		}
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
		for _, entry := range entries {
			profile := object(entry["repository"])
			if text(profile["strategy"]) != "managed" || object(entry["workspaceCleanup"])["status"] == "removed" {
				continue
			}
			if err := verify(); err != nil {
				return err
			}
			if err := c.removeManaged(jobCtx, id, entry, object(current[text(profile["id"])]["cleanupCommand"]), includeIgnored); err != nil {
				return err
			}
		}
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

// removeManaged runs a managed repository's cleanupCommand for one task checkout. Relay first
// checks the checkout has no local changes (and no ignored files unless they were included),
// then runs the command with literal arguments, then confirms the checkout is gone.
func (c *Coordinator) removeManaged(ctx context.Context, id string, entry, command map[string]any, includeIgnored bool) error {
	profile := object(entry["repository"])
	root := text(entry["workspaceRoot"])
	name := managedWorkspaceName(root, id)
	if root == "" || !filepath.IsAbs(root) || name == "" {
		return errors.New("this task's managed checkout cannot be identified; remove it yourself")
	}
	git := func(args ...string) (string, error) {
		result, err := process.Run(ctx, process.Options{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env, Command: "git", Args: append([]string{"-C", root}, args...), Directory: root, Timeout: 2 * time.Minute, MaxOutputBytes: 4 * 1024 * 1024})
		if err != nil {
			return "", err
		}
		return result.Stdout, nil
	}
	status, err := git("status", "--porcelain", "--untracked-files=all")
	if err != nil {
		return err
	}
	if strings.TrimSpace(status) != "" {
		return errors.New("the checkout has local changes; commit or preserve them before cleanup")
	}
	if !includeIgnored {
		ignored, err := git("ls-files", "--others", "--ignored", "--exclude-standard", "-z")
		if err != nil {
			return err
		}
		if ignored != "" {
			return errors.New("the checkout contains ignored files; explicitly include them or preserve them first")
		}
	}
	executable := text(command["command"])
	if executable == "" {
		return errors.New("the repository's cleanupCommand has no executable")
	}
	replacer := strings.NewReplacer("{workspaceName}", name, "{workspacePath}", root, "{branch}", text(entry["branch"]), "{taskId}", id)
	args := []string{}
	for _, arg := range array(command["args"]) {
		args = append(args, replacer.Replace(text(arg)))
	}
	if _, err := process.Run(ctx, process.Options{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env, Command: executable, Args: args, Directory: text(profile["path"]), Timeout: 10 * time.Minute, MaxOutputBytes: 4 * 1024 * 1024}); err != nil {
		return fmt.Errorf("cleanup command failed: %w", err)
	}
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		return errors.New("the cleanup command finished but the checkout is still there")
	}
	_, err = c.update(id, func(current map[string]any) error {
		return updateWorkspace(current, text(profile["id"]), func(target map[string]any) {
			target["workspaceCleanup"] = map[string]any{"status": "removed", "at": nowCheckpoint(), "root": root}
			delete(target, "workspaceRoot")
			delete(target, "workspace")
			for _, key := range []string{"publicationMonitor", "feedbackAutomation"} {
				if obj := object(target[key]); obj != nil {
					obj["enabled"], obj["status"] = false, "stopped"
				}
			}
		})
	}, map[string]any{"type": "workspace", "source": "relay", "repositoryId": text(profile["id"]), "summary": "Removed the task's clean checkout with the repository's cleanup command; branch and checkpoints retained."})
	return err
}

// noteRemovedWorkspaces records a task checkout that was deleted outside Relay (by its owner's
// own tooling, by hand, by an agent) as cleaned up, the way Relay's own cleanup records it, so the
// task stops pointing at a directory that is gone. It only acts when the checkout's parent still
// exists, so an unmounted volume is not mistaken for a removal, and never while Relay is working
// on the task.
func (c *Coordinator) noteRemovedWorkspaces(value map[string]any) {
	id := text(value["id"])
	if id == "" || value["demo"] == true || object(value["migration"])["readOnly"] == true {
		return
	}
	if status := text(value["status"]); status == "running" || status == "queued" || status == "manual" {
		return
	}
	entries := array(value["repositories"])
	if len(entries) <= 1 {
		entries = []any{value}
	}
	gone := []string{}
	for _, item := range entries {
		entry := object(item)
		root := text(entry["workspaceRoot"])
		if root == "" || !filepath.IsAbs(root) || entry["workspaceDraft"] != nil {
			continue
		}
		if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
			continue
		}
		parent := filepath.Dir(root)
		if filepath.Base(root) == "src" {
			// Managed trees keep the checkout one level down: the tree directory itself is gone too.
			parent = filepath.Dir(parent)
		}
		if info, err := os.Stat(parent); err != nil || !info.IsDir() {
			continue
		}
		gone = append(gone, text(object(entry["repository"])["id"]))
	}
	if len(gone) == 0 {
		return
	}
	c.mu.Lock()
	busy := c.jobs[id] != nil
	c.mu.Unlock()
	if busy {
		return
	}
	_, _ = c.update(id, func(current map[string]any) error {
		if status := text(current["status"]); status == "running" || status == "queued" || status == "manual" {
			return errTaskNoLongerActive
		}
		for _, repositoryID := range gone {
			if err := updateWorkspace(current, repositoryID, func(target map[string]any) {
				root := text(target["workspaceRoot"])
				if root == "" {
					return
				}
				if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
					return
				}
				target["workspaceCleanup"] = map[string]any{"status": "removed", "at": nowCheckpoint(), "root": root, "outsideRelay": true}
				delete(target, "workspaceRoot")
				delete(target, "workspace")
			}); err != nil {
				return err
			}
		}
		return nil
	}, map[string]any{"type": "workspace", "source": "relay", "summary": "The task's checkout was removed outside Relay; recorded it as cleaned up."})
}
