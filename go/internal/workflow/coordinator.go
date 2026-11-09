package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"relay.local/relay/internal/harness"
	"relay.local/relay/internal/process"
	"relay.local/relay/internal/storage"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/workspace"
)

type coordinatorJob struct {
	cancel context.CancelFunc
	done   chan struct{}
}

var errTaskNoLongerActive = errors.New("task no longer active")

// Coordinator prepares isolated workspaces and runs investigation through the
// plan gate. Implementation, verification, publication and debugger scheduling
// remain disabled until their supervision and recovery contracts are ported.
type Coordinator struct {
	store    *store.Store
	worker   string
	args     []string
	env      map[string]string
	area     *workspace.WorktreeArea
	registry *workspace.Registry
	repos    *workspace.Registry
	stages   *StageRunner
	mu       sync.Mutex
	jobs     map[string]*coordinatorJob
	scans    chan struct{}
	active   int
	changed  chan struct{}
	closed   bool
}

func NewCoordinator(db *store.Store, worker string, args []string, env map[string]string) (*Coordinator, error) {
	if db == nil || worker == "" {
		return nil, errors.New("workflow coordinator needs an owned store and worker")
	}
	area, err := workspace.NewWorktreeArea(db)
	if err != nil {
		return nil, err
	}
	registry := workspace.NewRegistry()
	c := &Coordinator{store: db, worker: worker, args: append([]string(nil), args...), env: map[string]string{}, area: area, registry: registry, repos: workspace.NewRegistry(), jobs: map[string]*coordinatorJob{}, scans: make(chan struct{}, 4), changed: make(chan struct{})}
	for key, value := range env {
		c.env[key] = value
	}
	c.stages = &StageRunner{Store: db, Registry: registry}
	if err = c.recoverInterrupted(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Coordinator) notifyLocked() {
	close(c.changed)
	c.changed = make(chan struct{})
}
func (c *Coordinator) Running() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.jobs)
}

func (c *Coordinator) update(id string, change func(map[string]any) error, event map[string]any) (map[string]any, error) {
	for retry := 0; retry < 5; retry++ {
		raw, err := c.store.Get(id)
		if err != nil {
			return nil, err
		}
		var value map[string]any
		if json.Unmarshal(raw, &value) != nil || value == nil {
			return nil, errors.New("invalid stored task")
		}
		if err = change(value); err != nil {
			return nil, err
		}
		next, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		var entry json.RawMessage
		if event != nil {
			entry, err = json.Marshal(event)
			if err != nil {
				return nil, err
			}
		}
		saved, err := c.store.CompareAndSwap(id, raw, next, entry)
		if errors.Is(err, store.ErrTaskChanged) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if json.Unmarshal(saved, &value) != nil {
			return nil, errors.New("invalid saved task")
		}
		return value, nil
	}
	return nil, errors.New("task changed repeatedly; retry the action")
}

func (c *Coordinator) recoverInterrupted() error {
	rows, err := c.store.All()
	if err != nil {
		return err
	}
	for _, raw := range rows {
		var item map[string]any
		if json.Unmarshal(raw, &item) != nil || item == nil {
			return errors.New("invalid stored task")
		}
		id, status := text(item["id"]), text(item["status"])
		if status != "running" && status != "queued" {
			continue
		}
		_, err = c.update(id, func(current map[string]any) error {
			if text(current["status"]) != "running" && text(current["status"]) != "queued" {
				return errors.New("task changed during startup recovery")
			}
			current["status"] = "interrupted"
			current["error"] = "Relay stopped before this stage finished. Inspect the retained workspace before resuming."
			for _, value := range array(current["attempts"]) {
				attempt := object(value)
				if text(attempt["status"]) == "running" {
					attempt["status"], attempt["finishedAt"] = "interrupted", timestamp(time.Now())
				}
			}
			return nil
		}, map[string]any{"type": "interrupted", "summary": "Workflow interrupted by Relay shutdown; workspace retained."})
		if err != nil {
			return err
		}
	}
	return nil
}

func profiles(task map[string]any) ([]map[string]any, error) {
	values := array(task["repositories"])
	if len(values) <= 1 {
		values = []any{task}
	}
	if len(values) == 0 || len(values) > 12 {
		return nil, errors.New("selected repositories are required")
	}
	result := make([]map[string]any, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		entry := object(value)
		profile := object(entry["repository"])
		id := text(profile["id"])
		strategy := text(profile["strategy"])
		if id == "" || seen[id] || !filepath.IsAbs(text(profile["path"])) {
			return nil, errors.New("invalid task repository")
		}
		if strategy != "" && strategy != "worktree" && strategy != "managed" {
			return nil, errors.New("attached checkouts are not supported by the preview yet")
		}
		seen[id] = true
		result = append(result, entry)
	}
	return result, nil
}

func enabledAgents(config map[string]any) (map[string]bool, map[string]harness.Config) {
	enabled, configs := map[string]bool{}, map[string]harness.Config{}
	for _, id := range []string{"codex", "claude", "pi"} {
		h := object(object(config["harnesses"])[id])
		command := text(h["command"])
		_, lookupErr := exec.LookPath(command)
		enabled[id] = h["enabled"] == true && command != "" && lookupErr == nil
		configs[id] = harness.Config{Command: command, Model: text(h["model"]), Effort: text(h["effort"])}
	}
	return enabled, configs
}

// Start is called only by an authenticated local user. It never skips the
// approach gate and refuses unsupported profiles before creating workspaces.
func (c *Coordinator) Start(id string) (map[string]any, error) {
	return c.enqueue(id, false)
}

// Resume only restarts a read-only stage after every retained workspace and
// setup result has been revalidated. It never recreates a partial workspace.
func (c *Coordinator) Resume(id string) (map[string]any, error) {
	return c.enqueue(id, true)
}

func (c *Coordinator) enqueue(id string, resume bool) (map[string]any, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, errors.New("Relay is shutting down")
	}
	if c.jobs[id] != nil {
		return nil, ErrStageBusy
	}
	if len(c.jobs) >= 256 {
		return nil, errors.New("workflow queue is full")
	}
	config, err := (task.ConfigurationService{Store: c.store}).Read()
	if err != nil {
		return nil, err
	}
	enabled, configs := enabledAgents(config.Value)
	var limit int
	if value, ok := config.Value["concurrency"].(float64); ok {
		limit = int(value)
	}
	if limit < 1 || limit > 8 {
		return nil, errors.New("invalid concurrency setting")
	}
	var timeout time.Duration
	result, err := c.update(id, func(value map[string]any) error {
		status := text(value["status"])
		if value["demo"] == true {
			return errors.New("simulated workflows are not ported yet")
		}
		if !resume && status != "draft" {
			return errors.New("start requires a draft task")
		}
		if resume && status != "paused" && status != "interrupted" && status != "blocked" {
			return errors.New("task cannot resume in its current state")
		}
		entries, err := profiles(value)
		if err != nil {
			return err
		}
		if resume {
			stage := text(value["stage"])
			if stage != "triage" && stage != "investigate" && stage != "plan" {
				return errors.New("this stage cannot resume in the preview yet")
			}
			for _, entry := range entries {
				if text(entry["workspaceRoot"]) == "" || entry["workspaceDraft"] != nil || entry["setupCompleted"] != true {
					return errors.New("workspace or setup is incomplete; inspect retained work before continuing")
				}
			}
			if decision := object(value["blockerDecision"]); decision != nil && decision["resolved"] != true {
				return errors.New("resolve the pending decision before resuming")
			}
		}
		routing := object(value["routing"])
		needed := []string{"investigate", "plan"}
		if value["preset"] == "investigate" {
			needed = []string{"investigate"}
		}
		if resume && text(value["stage"]) == "plan" {
			needed = []string{"plan"}
		}
		if value["smartRouting"] == true && (!resume || text(value["stage"]) == "triage") {
			needed = append(needed, "triage")
		}
		for _, stage := range needed {
			if !enabled[text(routing[stage])] {
				return fmt.Errorf("configured agent for %s is unavailable", stage)
			}
		}
		minutes, _ := config.Value["timeoutMinutes"].(float64)
		if override, ok := object(value["execution"])["timeoutMinutes"].(float64); ok {
			minutes = override
		}
		if minutes < 1 || minutes > 240 || minutes != float64(int(minutes)) {
			return errors.New("invalid workflow timeout")
		}
		timeout = time.Duration(minutes) * time.Minute
		if !resume {
			value["stage"] = "investigate"
			if value["smartRouting"] == true {
				value["stage"] = "triage"
			}
		}
		value["status"], value["error"] = "queued", nil
		return nil
	}, map[string]any{"type": "queued", "summary": "Workflow queued for investigation or planning."})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	job := &coordinatorJob{cancel: cancel, done: make(chan struct{})}
	c.jobs[id] = job
	go c.run(ctx, id, limit, timeout, enabled, configs, job)
	return result, nil
}

func (c *Coordinator) acquire(ctx context.Context, limit int) error {
	for {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return errors.New("Relay is shutting down")
		}
		if c.active < limit {
			c.active++
			c.mu.Unlock()
			return nil
		}
		changed := c.changed
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-changed:
		}
	}
}

func (c *Coordinator) reserveRepositories(ctx context.Context, id string) (*workspace.Lease, []string, error) {
	select {
	case c.scans <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}
	roots, err := c.repositoryRoots(ctx, id)
	<-c.scans
	if err != nil {
		return nil, nil, err
	}
	for {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return nil, nil, errors.New("Relay is shutting down")
		}
		lease, err := c.repos.Acquire(id, roots)
		if err == nil {
			c.mu.Unlock()
			return lease, roots, nil
		}
		if !errors.Is(err, workspace.ErrWorkspaceBusy) {
			c.mu.Unlock()
			return nil, nil, err
		}
		changed := c.changed
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		case <-changed:
		}
	}
}

func (c *Coordinator) repositoryRoots(ctx context.Context, id string) ([]string, error) {
	raw, err := c.store.Get(id)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, errors.New("invalid task state")
	}
	entries, err := profiles(value)
	if err != nil {
		return nil, err
	}
	runner := workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}
	roots := make([]string, 0, len(entries))
	for _, entry := range entries {
		profile := object(entry["repository"])
		root, err := runner.CommonDirectory(ctx, workspace.Profile{Path: text(profile["path"]), Cwd: text(profile["cwd"])})
		if err != nil {
			return nil, err
		}
		roots = append(roots, root)
	}
	return roots, nil
}

func (c *Coordinator) run(ctx context.Context, id string, limit int, timeout time.Duration, enabled map[string]bool, configs map[string]harness.Config, job *coordinatorJob) {
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
	repoLease, repoRoots, err := c.reserveRepositories(ctx, id)
	if err != nil {
		c.finishError(id, err)
		return
	}
	defer func() {
		c.mu.Lock()
		repoLease.Release()
		c.notifyLocked()
		c.mu.Unlock()
	}()
	if err = c.acquire(ctx, limit); err != nil {
		c.finishError(id, err)
		return
	}
	admitted = true
	err = repoLease.Protect(id, repoRoots, func(revalidate func() error) error {
		guard, err := c.storageGuard()
		if err == nil {
			err = c.prepare(ctx, id, guard, timeout)
		}
		for err == nil {
			raw, readErr := c.store.Get(id)
			if readErr != nil {
				err = readErr
				break
			}
			var value map[string]any
			if json.Unmarshal(raw, &value) != nil || value == nil {
				err = errors.New("invalid task state")
				break
			}
			if text(value["status"]) != "queued" {
				break
			}
			stage := text(value["stage"])
			if stage != "triage" && stage != "investigate" && stage != "plan" {
				err = errors.New("implementation and verification are not enabled in the preview")
				break
			}
			provider := text(object(value["routing"])[stage])
			guard, err = c.storageGuard()
			if err != nil {
				break
			}
			inspector := workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}
			err = c.stages.Run(ctx, id, StageOptions{Config: configs[provider], EnabledProviders: enabled, Admission: guard, Inspector: inspector, WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env, Timeout: timeout})
		}
		if err != nil {
			return err
		}
		return revalidate()
	})
	if err != nil {
		c.finishError(id, err)
	}
}

func (c *Coordinator) storageGuard() (storage.Guard, error) {
	policy, err := (storage.PolicyService{Store: c.store}).Read()
	if err != nil {
		return storage.Guard{}, err
	}
	var root string
	if err = c.store.WithOwnership(func(path string, _ func() error) error { root = path; return nil }); err != nil {
		return storage.Guard{}, err
	}
	return storage.Guard{Policy: policy.Policy, DataRoot: root}, nil
}

func (c *Coordinator) finishError(id string, failure error) {
	if failure == nil {
		return
	}
	cancelled := errors.Is(failure, context.Canceled) || errors.Is(failure, process.ErrCancelled)
	kind := "blocked"
	if cancelled {
		kind = "paused"
	}
	_, err := c.update(id, func(value map[string]any) error {
		if text(value["status"]) != "queued" && text(value["status"]) != "running" && text(value["status"]) != "blocked" && text(value["status"]) != "awaiting_plan" {
			return errTaskNoLongerActive
		}
		if cancelled {
			value["status"], value["error"] = "paused", "Workflow stopped. The workspace and activity are retained."
		} else {
			value["status"], value["error"] = "blocked", failure.Error()
		}
		return nil
	}, map[string]any{"type": kind, "summary": failure.Error()})
	if err != nil && !errors.Is(err, errTaskNoLongerActive) {
		log.Printf("Could not record workflow failure for %s: %v", id, err)
	}
}

func (c *Coordinator) Pause(id string) error {
	c.mu.Lock()
	job := c.jobs[id]
	if job == nil {
		c.mu.Unlock()
		return errors.New("task has no active workflow")
	}
	job.cancel()
	c.mu.Unlock()
	<-job.done
	return nil
}

func (c *Coordinator) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	jobs := make([]*coordinatorJob, 0, len(c.jobs))
	for _, job := range c.jobs {
		job.cancel()
		jobs = append(jobs, job)
	}
	c.notifyLocked()
	c.mu.Unlock()
	for _, job := range jobs {
		<-job.done
	}
}

// prepare and setup intentionally operate only on task-owned isolated
// workspaces. Partially created workspaces are recorded and never removed.
func (c *Coordinator) prepare(ctx context.Context, id string, guard storage.Guard, timeout time.Duration) error {
	raw, err := c.store.Get(id)
	if err != nil {
		return err
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return errors.New("invalid task state")
	}
	entries, err := profiles(value)
	if err != nil {
		return err
	}
	runner := workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}
	for index, entry := range entries {
		if err = ctx.Err(); err != nil {
			return err
		}
		profile := object(entry["repository"])
		repositoryID := text(profile["id"])
		if text(entry["workspaceRoot"]) != "" {
			if entry["workspaceDraft"] != nil || entry["setupCompleted"] != true {
				return errors.New("workspace or setup is incomplete; inspect retained work before continuing")
			}
			if err = runner.VerifyExisting(ctx, workspace.Profile{Path: text(profile["path"]), Cwd: text(profile["cwd"])}, text(entry["workspaceRoot"]), text(entry["workspace"]), text(entry["branch"]), text(entry["baseCommit"])); err != nil {
				return err
			}
			continue
		}
		if entry["workspaceDraft"] != nil {
			return errors.New("workspace preparation was previously started; inspect retained work before retrying")
		}
		key := id
		if len(entries) > 1 {
			key = fmt.Sprintf("%s-%d", id, index)
		}
		checkpoint := func(draft workspace.WorktreeDraft) error {
			_, err := c.update(id, func(current map[string]any) error {
				if text(current["status"]) != "queued" {
					return errors.New("task is no longer queued")
				}
				return updateWorkspace(current, repositoryID, func(target map[string]any) {
					target["workspaceDraft"] = map[string]any{"root": draft.Root, "cwd": draft.Cwd, "branch": draft.Branch, "baseCommit": draft.BaseCommit, "sourceRoot": draft.SourceRoot}
				})
			}, map[string]any{"type": "workspace", "repositoryId": repositoryID, "summary": "Preparing isolated workspace."})
			return err
		}
		base := workspace.Profile{Path: text(profile["path"]), Cwd: text(profile["cwd"])}
		var draft workspace.WorktreeDraft
		if text(profile["strategy"]) == "managed" {
			command := object(profile["workspaceCommand"])
			args, valid := stringsFromArray(command["args"])
			if !valid {
				return errors.New("invalid workspace manager arguments")
			}
			draft, err = runner.CreateManaged(ctx, c.area, workspace.ManagedProfile{Profile: base, PathTemplate: text(profile["workspacePath"]), Command: text(command["command"]), Args: args}, id, repositoryID, key, "", guard, checkpoint)
		} else {
			draft, err = runner.CreateWorktree(ctx, c.area, base, id, repositoryID, "", guard, checkpoint)
		}
		if err != nil {
			return err
		}
		_, err = c.update(id, func(current map[string]any) error {
			if text(current["status"]) != "queued" {
				return errors.New("task is no longer queued")
			}
			return updateWorkspace(current, repositoryID, func(target map[string]any) {
				target["workspaceRoot"], target["workspace"], target["branch"], target["baseCommit"] = draft.Root, draft.Cwd, draft.Branch, draft.BaseCommit
				delete(target, "workspaceDraft")
			})
		}, map[string]any{"type": "workspace", "repositoryId": repositoryID, "summary": "Isolated workspace ready."})
		if err != nil {
			return err
		}
	}
	return c.setup(ctx, id, guard, timeout, runner)
}

func updateWorkspace(task map[string]any, repositoryID string, apply func(map[string]any)) error {
	entries := array(task["repositories"])
	if len(entries) <= 1 {
		if text(object(task["repository"])["id"]) != repositoryID {
			return errors.New("task repository changed")
		}
		if len(entries) == 1 && (object(entries[0]) == nil || text(object(object(entries[0])["repository"])["id"]) != repositoryID) {
			return errors.New("task repository changed")
		}
		apply(task)
		if len(entries) == 1 {
			apply(object(entries[0]))
		}
		return nil
	}
	for _, value := range entries {
		entry := object(value)
		if text(object(entry["repository"])["id"]) != repositoryID {
			continue
		}
		apply(entry)
		if text(object(task["repository"])["id"]) == repositoryID {
			for _, key := range []string{"workspaceRoot", "workspace", "branch", "baseCommit", "workspaceDraft"} {
				if val, ok := entry[key]; ok {
					task[key] = val
				} else {
					delete(task, key)
				}
			}
		}
		return nil
	}
	return errors.New("task repository changed")
}

func stringsFromArray(value any) ([]string, bool) {
	items, ok := value.([]any)
	if !ok || len(items) > 100 {
		return nil, false
	}
	result := make([]string, len(items))
	for i, item := range items {
		text, ok := item.(string)
		if !ok || strings.ContainsRune(text, '\x00') || len(text) > 20000 {
			return nil, false
		}
		result[i] = text
	}
	return result, true
}

func (c *Coordinator) setup(ctx context.Context, id string, guard storage.Guard, timeout time.Duration, inspector workspace.Runner) error {
	raw, err := c.store.Get(id)
	if err != nil {
		return err
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return errors.New("invalid task state")
	}
	entries, err := profiles(value)
	if err != nil {
		return err
	}
	workspaces := make([]workspace.Workspace, 0, len(entries))
	roots, dirs := []string{}, map[string]string{}
	for _, entry := range entries {
		repoID, root, cwd := text(object(entry["repository"])["id"]), text(entry["workspaceRoot"]), text(entry["workspace"])
		if repoID == "" || root == "" || cwd == "" {
			return errors.New("workspace preparation is incomplete")
		}
		workspaces = append(workspaces, workspace.Workspace{RepositoryID: repoID, Root: root})
		roots = append(roots, root)
		dirs[repoID] = cwd
	}
	lease, err := c.registry.Acquire(id, roots)
	if err != nil {
		return err
	}
	defer lease.Release()
	encodedDirs, _ := json.Marshal(dirs)
	for _, entry := range entries {
		profile := object(entry["repository"])
		repoID, cwd := text(profile["id"]), text(entry["workspace"])
		if entry["setupCompleted"] == true {
			continue
		}
		if entry["setupRunning"] == true {
			return errors.New("setup was interrupted; inspect retained work before continuing")
		}
		setup := array(profile["setup"])
		if profile["setup"] != nil && setup == nil {
			return errors.New("invalid repository setup commands")
		}
		for _, item := range setup {
			command := object(item)
			args, valid := stringsFromArray(command["args"])
			if !valid || text(command["command"]) == "" {
				return errors.New("invalid repository setup command")
			}
			env := map[string]string{}
			for key, val := range c.env {
				env[key] = val
			}
			env["RELAY_WORKSPACES_JSON"] = string(encodedDirs)
			_, err = c.update(id, func(current map[string]any) error {
				return updateWorkspace(current, repoID, func(target map[string]any) { target["setupRunning"] = true })
			}, map[string]any{"type": "setup", "repositoryId": repoID, "summary": "Running repository setup."})
			if err != nil {
				return err
			}
			_, err = workspace.GuardedRun(ctx, lease, id, workspaces, workspace.WriteOne, repoID, guard, inspector, func(runCtx context.Context) error {
				result, runErr := process.Run(runCtx, process.Options{WorkerExecutable: c.worker, WorkerArgs: c.args, Command: text(command["command"]), Args: args, Directory: cwd, Environment: env, Timeout: timeout, MaxOutputBytes: 8 * 1024 * 1024, OnLine: func(eventCtx context.Context, line, stream string) error {
					if err := eventCtx.Err(); err != nil {
						return err
					}
					event, _ := json.Marshal(map[string]any{"type": "transcript", "stage": "setup", "repositoryId": repoID, "stream": stream, "text": line})
					_, eventErr := c.store.Event(id, event)
					return eventErr
				}})
				if runErr != nil {
					return runErr
				}
				if result.ExitCode != 0 {
					return fmt.Errorf("setup for %s exited %d", repoID, result.ExitCode)
				}
				return nil
			})
			if err != nil {
				return err
			}
			_, err = c.update(id, func(current map[string]any) error {
				return updateWorkspace(current, repoID, func(target map[string]any) { delete(target, "setupRunning") })
			}, nil)
			if err != nil {
				return err
			}
		}
		_, err = c.update(id, func(current map[string]any) error {
			return updateWorkspace(current, repoID, func(target map[string]any) { target["setupCompleted"] = true })
		}, map[string]any{"type": "setup", "repositoryId": repoID, "summary": "Repository setup complete."})
		if err != nil {
			return err
		}
	}
	return nil
}
