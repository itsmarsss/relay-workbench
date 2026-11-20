package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"relay.local/relay/internal/harness"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/workspace"
)

func (c *Coordinator) ForkCheckpoint(ctx context.Context, sourceID string, body map[string]any) (any, error) {
	if err := fields(body, "checkpointId", "stage", "note"); err != nil {
		return nil, err
	}
	mode := text(body["stage"])
	if mode == "" {
		mode = "saved"
	}
	allowed := map[string]bool{"saved": true, "approach": true, "decision": true, "plan": true, "implement": true, "verify": true}
	if !allowed[mode] || len(text(body["note"])) > 20000 {
		return nil, errors.New("select a valid continuation")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, errors.New("Relay is shutting down")
	}
	if len(c.jobs) >= 256 {
		return nil, errors.New("workflow queue is full")
	}
	if _, _, err := c.inspected(sourceID, body); err != nil {
		return nil, err
	}
	rows, err := c.checkpointRecords(sourceID)
	if err != nil {
		return nil, err
	}
	var saved *Checkpoint
	for i := range rows {
		if rows[i].ID == text(body["checkpointId"]) {
			saved = &rows[i]
			break
		}
	}
	if saved == nil {
		return nil, errors.New("checkpoint not found")
	}
	source := saved.Snapshot
	if source == nil || len(saved.Repositories) == 0 {
		return nil, errors.New("checkpoint has no restorable workspaces")
	}
	if source["preset"] == "investigate" && mode != "saved" && mode != "decision" {
		return nil, errors.New("investigation-only checkpoints cannot implement changes")
	}
	if mode == "approach" && len(array(CompletedPlan(source)["options"])) == 0 {
		return nil, errors.New("checkpoint has no saved approach choices")
	}
	if (mode == "implement" || mode == "verify") && !harness.HasApprovedApproach(source) {
		return nil, errors.New("checkpoint requires approach approval")
	}
	if mode == "decision" && object(source["blockerDecision"]) == nil && saved.Role != "debug" {
		return nil, errors.New("checkpoint has no debugger decision")
	}
	value, err := copyTask(source)
	if err != nil {
		return nil, err
	}
	id, err := stageUUID()
	if err != nil {
		return nil, err
	}
	value["id"], value["title"], value["createdAt"], value["updatedAt"] = id, truncateTitle(text(source["title"]))+" · continuation", nowCheckpoint(), nowCheckpoint()
	value["fork"] = map[string]any{"sourceTaskId": sourceID, "checkpointId": saved.ID, "sourceAttemptId": saved.AttemptID, "mode": mode, "at": nowCheckpoint()}
	value["checkpointRestore"] = map[string]any{"status": "preparing"}
	value["status"] = "paused"
	for _, key := range []string{"verifiedFingerprint", "reviewedFingerprint", "acceptedFingerprint", "publicationRecovery", "publication", "publicationMonitor", "delivery", "deliveryRuns", "feedback", "feedbackHandled", "feedbackAutomation", "automation", "currentRun", "error", "loopGuard", "executionBudget", "terminal", "terminalControl", "nativeSession"} {
		delete(value, key)
	}
	value["round"], value["repositoryCursor"] = float64(0), float64(0)
	for _, entry := range append([]map[string]any{value}, taskRepositoriesForFork(value)...) {
		for _, key := range []string{"workspaceRoot", "workspace", "branch", "baseCommit", "workspaceHead", "workspaceDraft", "setupCompleted", "acceptedFingerprint", "publication", "delivery", "publicationMonitor", "feedback", "feedbackAutomation", "feedbackHandled"} {
			delete(entry, key)
		}
		if profile := object(entry["repository"]); profile["strategy"] == "attach" {
			profile["strategy"] = "worktree"
		}
	}
	history := []any{}
	for _, item := range array(source["attempts"]) {
		old := object(item)
		attempt := map[string]any{"inherited": true, "originTaskId": sourceID}
		for _, key := range []string{"id", "stage", "status", "harness", "role", "round", "repositoryId", "startedAt", "finishedAt", "handoff", "fingerprint", "parentAttemptId", "relation"} {
			if val, ok := old[key]; ok {
				attempt[key] = val
			}
		}
		history = append(history, attempt)
	}
	value["attempts"] = history
	approvals := []any{}
	for _, item := range array(source["approvals"]) {
		approval := object(item)
		if approval["type"] == "approach" {
			delete(approval, "automation")
			approval["inherited"] = true
			approvals = append(approvals, approval)
		}
	}
	value["approvals"] = approvals
	value["messages"] = append(array(value["messages"]), map[string]any{"id": id, "role": "user", "at": nowCheckpoint(), "text": "Continue from the saved " + saved.Stage + " checkpoint. Prior paths and test results are historical evidence. Inspect this new workspace and collect fresh verification. " + text(body["note"]), "delivery": "context"})
	if source["status"] == "awaiting_plan" && mode == "saved" {
		value["status"] = "awaiting_plan"
	}
	switch mode {
	case "approach":
		value["status"], value["stage"], value["chosenApproach"], value["recovery"], value["blockerDecision"] = "awaiting_plan", "plan", nil, nil, nil
	case "plan":
		value["stage"], value["chosenApproach"], value["recovery"], value["blockerDecision"] = "plan", nil, nil, nil
	case "implement", "verify":
		value["stage"], value["recovery"], value["blockerDecision"] = mode, nil, nil
	case "decision":
		decision := object(value["blockerDecision"])
		if decision == nil {
			decision = map[string]any{"summary": "Reconsider the saved debugger result.", "stage": value["stage"], "options": []any{}}
		}
		decisionID, err := stageUUID()
		if err != nil {
			return nil, err
		}
		decision["id"], decision["resolved"] = decisionID, false
		delete(decision, "resolution")
		value["status"], value["blockerDecision"] = "blocked", decision
	}
	if mode == "saved" && (value["stage"] == "review" || source["status"] == "awaiting_final" || source["status"] == "completed") {
		if source["preset"] == "investigate" {
			value["stage"] = "investigate"
		} else {
			value["stage"] = "verify"
		}
		if mode != "approach" && mode != "plan" && mode != "decision" {
			value["status"] = "paused"
		}
		value["recovery"] = nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if _, err = c.store.InsertTask(raw, mustJSON(map[string]any{"type": "fork", "source": "relay", "summary": "Restoring a separate continuation from " + saved.Stage + ".", "sourceTaskId": sourceID, "checkpointId": saved.ID})); err != nil {
		return nil, err
	}
	jobCtx, cancel := context.WithCancel(context.Background())
	job := &coordinatorJob{cancel: cancel, done: make(chan struct{})}
	c.jobs[id] = job
	go c.restoreCheckpoint(jobCtx, id, *saved, job)
	_, _ = c.store.Event(sourceID, mustJSON(map[string]any{"type": "fork", "source": "relay", "continuationTaskId": id, "checkpointId": saved.ID, "summary": "Created a separate continuation from " + saved.Stage + "."}))
	returned, _ := c.store.Get(id)
	json.Unmarshal(returned, &value)
	value["taskRevision"] = store.TaskRevision(returned)
	return value, nil
}
func truncateTitle(value string) string {
	r := []rune(value)
	if len(r) > 210 {
		return string(r[:210])
	}
	return value
}
func taskRepositoriesForFork(value map[string]any) []map[string]any {
	rows := array(value["repositories"])
	if len(rows) <= 1 {
		result := []map[string]any{value}
		if len(rows) == 1 {
			result = append(result, object(rows[0]))
		}
		return result
	}
	result := []map[string]any{}
	for _, row := range rows {
		result = append(result, object(row))
	}
	return result
}
func (c *Coordinator) restoreCheckpoint(ctx context.Context, id string, saved Checkpoint, job *coordinatorJob) {
	admitted := false
	defer func() {
		c.mu.Lock()
		if admitted {
			c.active--
		}
		delete(c.jobs, id)
		c.notifyLocked()
		close(job.done)
		c.mu.Unlock()
	}()
	fail := func(failure error) {
		_, _ = c.update(id, func(value map[string]any) error {
			value["status"], value["error"] = "blocked", "Checkpoint restore failed: "+failure.Error()+". Existing files are retained."
			value["checkpointRestore"] = map[string]any{"status": "failed"}
			return nil
		}, map[string]any{"type": "blocked", "source": "relay", "summary": "Checkpoint restore needs inspection: " + failure.Error()})
	}
	lease, roots, err := c.reserveRepositories(ctx, id)
	if err != nil {
		fail(err)
		return
	}
	defer func() { lease.Release(); c.mu.Lock(); c.notifyLocked(); c.mu.Unlock() }()
	config, err := (task.ConfigurationService{Store: c.store}).Read()
	if err != nil {
		fail(err)
		return
	}
	limit, _ := config.Value["concurrency"].(float64)
	if limit < 1 || limit > 8 {
		fail(errors.New("invalid concurrency"))
		return
	}
	if err = c.acquire(ctx, int(limit)); err != nil {
		fail(err)
		return
	}
	admitted = true
	err = lease.Protect(id, roots, func(revalidate func() error) error {
		guard, err := c.storageGuard()
		if err != nil {
			return err
		}
		runner := workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}
		raw, err := c.store.Get(id)
		if err != nil {
			return err
		}
		var value map[string]any
		if json.Unmarshal(raw, &value) != nil {
			return errors.New("invalid continuation")
		}
		entries, err := profiles(value)
		if err != nil {
			return err
		}
		for index, entry := range entries {
			profile := object(entry["repository"])
			repoID := text(profile["id"])
			var snapshot *checkpointRepository
			for i := range saved.Repositories {
				if saved.Repositories[i].ID == repoID {
					snapshot = &saved.Repositories[i]
					break
				}
			}
			if snapshot == nil || !objectID.MatchString(snapshot.Head) || !objectID.MatchString(snapshot.IndexTree) || !objectID.MatchString(snapshot.WorkingTree) {
				return errors.New("checkpoint repository evidence is incomplete")
			}
			checkpoint := func(draft workspace.WorktreeDraft) error {
				_, err := c.update(id, func(task map[string]any) error {
					return updateWorkspace(task, repoID, func(target map[string]any) {
						target["workspaceDraft"] = map[string]any{"root": draft.Root, "cwd": draft.Cwd, "branch": draft.Branch, "baseCommit": draft.BaseCommit}
					})
				}, nil)
				return err
			}
			base := workspace.Profile{Path: text(profile["path"]), Cwd: text(profile["cwd"])}
			var draft workspace.WorktreeDraft
			if profile["strategy"] == "managed" {
				command := object(profile["workspaceCommand"])
				args, ok := stringsFromArray(command["args"])
				if !ok {
					return errors.New("invalid manager arguments")
				}
				key := id
				if len(entries) > 1 {
					key = fmt.Sprintf("%s-%d", id, index)
				}
				draft, err = runner.CreateManaged(ctx, c.area, workspace.ManagedProfile{Profile: base, PathTemplate: text(profile["workspacePath"]), Command: text(command["command"]), Args: args}, id, repoID, key, snapshot.Head, guard, checkpoint)
			} else {
				draft, err = runner.CreateWorktree(ctx, c.area, base, id, repoID, snapshot.Head, guard, checkpoint)
			}
			if err != nil {
				return err
			}
			// Only the fresh, clean continuation is ever changed by these operations.
			if _, err = runner.RunGit(ctx, draft.Root, []string{"read-tree", "--reset", "-u", snapshot.WorkingTree}, nil, nil); err != nil {
				return err
			}
			if _, err = runner.RunGit(ctx, draft.Root, []string{"read-tree", snapshot.IndexTree}, nil, nil); err != nil {
				return err
			}
			originalBase := snapshot.Head
			for _, old := range taskRepositoriesForFork(saved.Snapshot) {
				if text(object(old["repository"])["id"]) == repoID && text(old["baseCommit"]) != "" {
					originalBase = text(old["baseCommit"])
					break
				}
			}
			if err = revalidate(); err != nil {
				return err
			}
			_, err = c.update(id, func(task map[string]any) error {
				return updateWorkspace(task, repoID, func(target map[string]any) {
					target["workspaceRoot"], target["workspace"], target["branch"], target["baseCommit"], target["workspaceHead"] = draft.Root, draft.Cwd, draft.Branch, originalBase, snapshot.Head
					target["setupCompleted"] = false
					delete(target, "workspaceDraft")
				})
			}, map[string]any{"type": "workspace", "source": "relay", "repositoryId": repoID, "summary": "Checkpoint files restored into a separate worktree."})
			if err != nil {
				return err
			}
		}
		raw, err = c.store.Get(id)
		if err != nil {
			return err
		}
		if json.Unmarshal(raw, &value) != nil {
			return errors.New("invalid restored task")
		}
		restored, err := stageWorkspaces(value)
		if err != nil {
			return err
		}
		workspaces := []workspace.Workspace{}
		for _, entry := range restored {
			workspaces = append(workspaces, workspace.Workspace{RepositoryID: entry.id, Root: entry.root})
		}
		fingerprint, err := runner.Snapshot(ctx, workspaces)
		if err != nil {
			return err
		}
		if fingerprint.Combined != saved.Fingerprint {
			return errors.New("restored files differ from the saved checkpoint")
		}
		_, err = c.update(id, func(value map[string]any) error {
			value["checkpointRestore"] = map[string]any{"status": "complete", "at": nowCheckpoint(), "ignoredFiles": "Ignored build output and dependencies are not copied; configured setup runs before continuation."}
			return nil
		}, map[string]any{"type": "fork", "source": "relay", "summary": "Continuation restored. Choose an approach or resume when ready."})
		return err
	})
	if err != nil {
		fail(err)
	}
}
