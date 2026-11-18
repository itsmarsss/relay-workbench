package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"relay.local/relay/internal/harness"
	"relay.local/relay/internal/process"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/terminal"
	"relay.local/relay/internal/workspace"
)

func (c *Coordinator) EnableTerminals() {
	c.mu.Lock()
	c.terminals = terminal.Available()
	c.mu.Unlock()
}
func (c *Coordinator) terminalInfo(id string) (terminal.Info, bool, error) {
	var info terminal.Info
	raw, exists, err := c.store.GetMeta("terminal:" + id)
	if err != nil || !exists {
		return info, false, err
	}
	var record struct {
		Info   terminal.Info `json:"terminal"`
		Active bool          `json:"active"`
	}
	if json.Unmarshal([]byte(raw), &record) != nil {
		return info, false, errors.New("invalid terminal record")
	}
	return record.Info, record.Active, nil
}

// terminalStopped is why the task's last interactive terminal failed, when it did.
func (c *Coordinator) terminalStopped(id string) string {
	raw, _, _ := c.store.GetMeta("terminal:" + id)
	var record struct {
		Stopped string `json:"stopped"`
	}
	_ = json.Unmarshal([]byte(raw), &record)
	return record.Stopped
}

// agentTerminal reports whether the task's terminal is a person's agent terminal that is open
// right now (see openAgentTerminal). It is only open while its job runs.
func (c *Coordinator) agentTerminal(id string) bool {
	raw, exists, _ := c.store.GetMeta("terminal:" + id)
	var record struct {
		Mode string `json:"mode"`
	}
	if !exists || json.Unmarshal([]byte(raw), &record) != nil || record.Mode != "agent" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	job := c.jobs[id]
	return job != nil && job.kind == "agent-terminal"
}

// writableTerminal is whether a person may type into the task's terminal: under manual control,
// or in their own agent terminal.
func (c *Coordinator) writableTerminal(id string, value map[string]any) bool {
	return value["status"] == "manual" || c.agentTerminal(id)
}

func (c *Coordinator) Terminal(ctx context.Context, id, operation string, body map[string]any) (any, error) {
	if operation == "takeover" {
		return c.takeover(ctx, id, body)
	}
	if operation == "agent" {
		return c.openAgentTerminal(ctx, id, body)
	}
	if operation == "release" {
		if err := fields(body, "session"); err != nil {
			return nil, err
		}
		_, value, err := c.inspected(id, body)
		if err != nil {
			return nil, err
		}
		if value["status"] != "manual" {
			return nil, errors.New("task is not under manual control")
		}
		info, live, err := c.terminalInfo(id)
		if err != nil {
			return nil, err
		}
		// Only a terminal that is still open can have changed under the page; once it has
		// closed there is nothing to compare and control can always be handed back.
		if live && info.Session != text(body["session"]) {
			return nil, errors.New("terminal session changed")
		}
		c.mu.Lock()
		job := c.jobs[id]
		c.mu.Unlock()
		if job != nil {
			if err = c.Pause(id); err != nil {
				return nil, err
			}
		}
		return c.update(id, func(value map[string]any) error {
			if value["status"] != "manual" {
				return ErrStageBusy
			}
			value["status"] = "paused"
			return nil
		}, map[string]any{"type": "manual", "source": "user", "summary": "Returned control. Resume to collect fresh verification."})
	}
	info, active, err := c.terminalInfo(id)
	if err != nil {
		return nil, err
	}
	if operation == "snapshot" {
		agent := c.agentTerminal(id)
		if active && !agent {
			// An agent terminal whose job is gone (closed, or Relay restarted) is not open.
			raw, _, _ := c.store.GetMeta("terminal:" + id)
			if strings.Contains(raw, `"mode":"agent"`) {
				active = false
			}
		}
		if !active {
			result := map[string]any{"available": false, "message": "No live terminal. Retained agent output is available in Activity and Logs."}
			if stopped := c.terminalStopped(id); stopped != "" {
				result["stopped"] = stopped
			}
			return result, nil
		}
		output, err := terminal.Capture(ctx, info)
		if err != nil {
			return map[string]any{"available": false, "message": "Terminal is starting or has closed."}, nil
		}
		result := map[string]any{"available": true, "terminal": info, "output": output, "agent": agent}
		if windows, err := terminal.Windows(ctx, info); err == nil {
			result["windows"] = windows
		}
		return result, nil
	}
	if operation == "window" {
		return c.terminalWindow(ctx, id, info, active, body)
	}
	if err = fields(body, "session", "type", "data", "cols", "rows"); err != nil {
		return nil, err
	}
	if !active || !info.Interactive || text(body["session"]) != info.Session {
		return nil, errors.New("take control of this terminal before typing")
	}
	raw, err := c.store.Get(id)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || !c.writableTerminal(id, value) {
		return nil, errors.New("manual control is no longer active")
	}
	switch body["type"] {
	case "input":
		err = terminal.Input(ctx, info, text(body["data"]))
	case "resize":
		cols, cok := body["cols"].(float64)
		rows, rok := body["rows"].(float64)
		if !cok || !rok || cols != float64(int(cols)) || rows != float64(int(rows)) {
			return nil, errors.New("invalid terminal dimensions")
		}
		err = terminal.Resize(ctx, info, int(cols), int(rows))
	default:
		err = errors.New("unsupported terminal input")
	}
	return map[string]bool{"accepted": err == nil}, err
}

// terminalWindow opens, chooses or closes a window of the terminal a person controls.
func (c *Coordinator) terminalWindow(ctx context.Context, id string, info terminal.Info, active bool, body map[string]any) (any, error) {
	if err := fields(body, "session", "action", "index", "provider", "model", "effort"); err != nil {
		return nil, err
	}
	if !active || !info.Interactive || text(body["session"]) != info.Session {
		return nil, errors.New("take control of this task before opening terminals")
	}
	raw, err := c.store.Get(id)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || !c.writableTerminal(id, value) {
		return nil, errors.New("manual control is no longer active")
	}
	index := -1
	if number, ok := body["index"].(float64); ok && number == float64(int(number)) {
		index = int(number)
	}
	switch body["action"] {
	case "new":
		recorded, _, _ := c.store.GetMeta("terminal:" + id)
		var record struct {
			RepositoryID string `json:"repositoryId"`
		}
		_ = json.Unmarshal([]byte(recorded), &record)
		entry := publicationEntry(value, record.RepositoryID)
		if entry == nil || text(entry["workspace"]) == "" {
			return nil, errors.New("workspace is unavailable")
		}
		command, args, name, err := c.manualCommand(body, value)
		if err != nil {
			return nil, err
		}
		err = terminal.NewWindow(ctx, info, name, text(entry["workspace"]), c.env, command, args)
	case "end":
		// Closes every terminal in the session. The task stays under manual control, so
		// another terminal can be opened or control handed back.
		c.mu.Lock()
		job := c.jobs[id]
		c.mu.Unlock()
		if job == nil {
			return nil, errors.New("no terminal is open")
		}
		job.cancel()
		select {
		case <-job.done:
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(15 * time.Second):
			return nil, errors.New("terminal did not close in time")
		}
		return map[string]any{"windows": []terminal.Window{}}, nil
	case "select":
		err = terminal.SelectWindow(ctx, info, index)
	case "close":
		err = terminal.CloseWindow(ctx, info, index)
	default:
		err = errors.New("unsupported terminal window action")
	}
	if err != nil {
		return nil, err
	}
	windows, err := terminal.Windows(ctx, info)
	return map[string]any{"windows": windows}, err
}
func (c *Coordinator) TerminalStream(ctx context.Context, id, session string, send func(map[string]any) error) error {
	info, active, err := c.terminalInfo(id)
	if err != nil {
		return err
	}
	if !active || info.Session != session {
		return errors.New("terminal session is no longer active")
	}
	return terminal.Stream(ctx, info, send)
}

// manualBrief tells an agent opened in a terminal what the task is and that a person is now
// driving, so it waits for them instead of starting work on its own.
func manualBrief(value map[string]any) string {
	title := strings.TrimSpace(text(value["title"]))
	if title == "" {
		return ""
	}
	clip := func(s string, limit int) string {
		s = strings.TrimSpace(strings.ToValidUTF8(strings.ReplaceAll(s, "\x00", ""), ""))
		if runes := []rune(s); len(runes) > limit {
			return string(runes[:limit]) + "\n[truncated]"
		}
		return s
	}
	var b strings.Builder
	b.WriteString("Context for this session. I opened you in the worktree of a Relay task, and Relay is not running agents on it while we work. Read this, then wait for my instructions: do not start work yet.\n\n")
	b.WriteString("Task: " + clip(title, 300) + "\n")
	if id := text(value["id"]); id != "" {
		b.WriteString("Task ID: " + id + "\n")
	}
	if ticket := clip(text(value["ticket"]), 500); ticket != "" {
		b.WriteString("Ticket: " + ticket + "\n")
	}
	if branch := clip(text(value["branch"]), 300); branch != "" {
		b.WriteString("Branch: " + branch + "\n")
	}
	if stage := text(value["stage"]); stage != "" {
		b.WriteString("Workflow stage: " + stage + "\n")
	}
	if description := clip(text(value["description"]), 6000); description != "" {
		b.WriteString("\nDescription and requirements:\n" + description + "\n")
	}
	if approach := object(value["chosenApproach"]); harness.HasApprovedApproach(value) && text(approach["title"]) != "" {
		b.WriteString("\nApproved approach: " + clip(text(approach["title"]), 300) + "\n")
		if detail := clip(text(approach["description"]), 3000); detail != "" {
			b.WriteString(detail + "\n")
		}
	}
	if summary := clip(text(value["latestSummary"]), 1500); summary != "" {
		b.WriteString("\nLatest update: " + summary + "\n")
	}
	if problem := clip(text(value["error"]), 1500); problem != "" {
		b.WriteString("\nOpen problem: " + problem + "\n")
	}
	return b.String()
}

// manualCommand is what a person asked to run in a terminal: a shell, or an enabled agent with
// the chosen model and effort.
func (c *Coordinator) manualCommand(body, value map[string]any) (string, []string, string, error) {
	// A shell means the person's own: whatever SHELL names where Relay runs, else the POSIX one.
	command, args, name := "/bin/sh", []string{"-i"}, "shell"
	if shell := os.Getenv("SHELL"); filepath.IsAbs(shell) {
		if info, err := os.Stat(shell); err == nil && info.Mode().IsRegular() && info.Mode()&0111 != 0 {
			command = shell
		}
	}
	provider := text(body["provider"])
	if provider != "" {
		name = provider
		config, err := (task.ConfigurationService{Store: c.store}).Read()
		if err != nil {
			return "", nil, "", err
		}
		enabled, configs := enabledAgents(config.Value)
		if !enabled[provider] {
			return "", nil, "", errors.New("selected provider is unavailable")
		}
		model, effort, err := harness.Options(provider, text(body["model"]), text(body["effort"]))
		if err != nil {
			return "", nil, "", err
		}
		command = configs[provider].Command
		args = nil
		if model != "" {
			args = append(args, "--model", model)
		}
		if effort != "" {
			if provider == "codex" {
				args = append(args, "--config", "model_reasoning_effort=\""+effort+"\"")
			} else if provider == "pi" {
				args = append(args, "--thinking", effort)
			} else {
				args = append(args, "--effort", effort)
			}
		}
		if provider == "codex" {
			args = append(args, "--dangerously-bypass-approvals-and-sandbox")
		}
		// An agent opened by hand starts knowing the task. The brief is one literal argument,
		// its opening message; it is never shell text.
		if brief := manualBrief(value); brief != "" {
			args = append(args, brief)
		}
	}
	return command, args, name, nil
}
func (c *Coordinator) takeover(ctx context.Context, id string, body map[string]any) (any, error) {
	if err := fields(body, "repositoryId", "provider", "model", "effort"); err != nil {
		return nil, err
	}
	_, value, err := c.inspected(id, body)
	if err != nil {
		return nil, err
	}
	// A task already under manual control may open a terminal again once its last one has gone:
	// it closed, failed to start, or Relay restarted.
	c.mu.Lock()
	reopening := value["status"] == "manual" && c.jobs[id] == nil
	c.mu.Unlock()
	if !c.terminals || value["demo"] == true || value["status"] == "draft" || (value["status"] == "manual" && !reopening) {
		return nil, errors.New("start a real task and install tmux before taking control")
	}
	repoID := text(body["repositoryId"])
	if repoID == "" {
		repoID = text(object(value["repository"])["id"])
	}
	entry := publicationEntry(value, repoID)
	if entry == nil || text(entry["workspaceRoot"]) == "" || entry["setupCompleted"] != true {
		return nil, errors.New("workspace setup must finish first")
	}
	command, args, _, err := c.manualCommand(body, value)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	job := c.jobs[id]
	c.mu.Unlock()
	if job != nil {
		if err = c.Pause(id); err != nil {
			return nil, err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.jobs[id] != nil {
		return nil, ErrStageBusy
	}
	value, err = c.update(id, func(value map[string]any) error {
		if value["status"] == "manual" {
			if reopening {
				return nil
			}
			return ErrStageBusy
		}
		value["status"], value["verifiedFingerprint"], value["reviewedFingerprint"] = "manual", nil, nil
		if harness.HasApprovedApproach(value) {
			value["stage"] = "verify"
		} else {
			value["stage"] = "investigate"
		}
		value["repositoryCursor"], value["error"] = float64(0), nil
		return nil
	}, map[string]any{"type": "manual", "source": "user", "repositoryId": repoID, "summary": "Automation paused for interactive control."})
	if err != nil {
		return nil, err
	}
	jobCtx, cancel := context.WithCancel(context.Background())
	job = &coordinatorJob{cancel: cancel, done: make(chan struct{})}
	c.jobs[id] = job
	go c.runManual(jobCtx, id, repoID, command, args, job)
	return value, nil
}

// openAgentTerminal opens a person's own agent (Claude by default) or shell in the task's
// worktree, briefed on the task, without taking control: the task keeps its status and stage, and
// Relay starts no stage on it while the terminal is open. Unlike Take control it does not hold the
// repository for the whole session, so other tasks keep running; the person drives this one.
// Verification and review still compare fingerprints, so anything changed here is checked before
// it is accepted.
func (c *Coordinator) openAgentTerminal(ctx context.Context, id string, body map[string]any) (any, error) {
	if err := fields(body, "repositoryId", "provider", "model", "effort"); err != nil {
		return nil, err
	}
	_, value, err := c.inspected(id, body)
	if err != nil {
		return nil, err
	}
	if !c.terminals || value["demo"] == true {
		return nil, errors.New("install tmux to open terminals")
	}
	if status := text(value["status"]); status == "running" || status == "queued" || status == "manual" {
		return nil, errors.New("this task is " + status + "; pause it, or use its terminal, before opening your own")
	}
	repoID := text(body["repositoryId"])
	if repoID == "" {
		repoID = text(object(value["repository"])["id"])
	}
	entry := publicationEntry(value, repoID)
	if entry == nil || text(entry["workspaceRoot"]) == "" || entry["setupCompleted"] != true {
		return nil, errors.New("this task has no workspace yet; start it first")
	}
	c.mu.Lock()
	open := c.jobs[id] != nil && c.jobs[id].kind == "agent-terminal"
	c.mu.Unlock()
	if open {
		// Already open: the page attaches to it.
		return value, nil
	}
	if _, has := body["provider"]; !has {
		body["provider"] = "claude"
	}
	command, args, _, err := c.manualCommand(body, value)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, errors.New("Relay is shutting down")
	}
	if job := c.jobs[id]; job != nil {
		if job.kind == "agent-terminal" {
			return value, nil
		}
		return nil, ErrStageBusy
	}
	jobCtx, cancel := context.WithCancel(context.Background())
	job := &coordinatorJob{cancel: cancel, done: make(chan struct{}), kind: "agent-terminal"}
	c.jobs[id] = job
	go c.runTerminal(jobCtx, id, repoID, command, args, job, true)
	_, _ = c.store.Event(id, mustJSON(map[string]any{"type": "terminal", "source": "user", "repositoryId": repoID, "summary": "Opened an agent terminal; Relay starts no stage on this task while it is open."}))
	return value, nil
}

func (c *Coordinator) runManual(ctx context.Context, id, repoID, command string, args []string, job *coordinatorJob) {
	c.runTerminal(ctx, id, repoID, command, args, job, false)
}

func (c *Coordinator) runTerminal(ctx context.Context, id, repoID, command string, args []string, job *coordinatorJob, agent bool) {
	defer func() { c.mu.Lock(); delete(c.jobs, id); c.notifyLocked(); close(job.done); c.mu.Unlock() }()
	var lease *workspace.Lease
	var roots []string
	var err error
	if agent {
		lease, roots, err = c.reserveTask(id)
	} else {
		lease, roots, err = c.reserveRepositories(ctx, id)
	}
	if err == nil {
		defer lease.Release()
		err = lease.Protect(id, roots, func(revalidate func() error) error {
			raw, err := c.store.Get(id)
			if err != nil {
				return err
			}
			var value map[string]any
			if json.Unmarshal(raw, &value) != nil {
				return errors.New("invalid task")
			}
			entry := publicationEntry(value, repoID)
			if entry == nil {
				return errors.New("workspace is unavailable")
			}
			runner := workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}
			profile := object(entry["repository"])
			if err = runner.VerifyCommitted(ctx, workspace.Profile{Path: text(profile["path"]), Cwd: text(profile["cwd"])}, text(entry["workspaceRoot"]), text(entry["workspace"]), text(entry["branch"]), text(entry["baseCommit"])); err != nil {
				return err
			}
			guard, err := c.storageGuard()
			if err != nil {
				return err
			}
			if err = guard.Check(ctx, []string{text(entry["workspaceRoot"])}); err != nil {
				return err
			}
			if err = revalidate(); err != nil {
				return err
			}
			spec, path, err := terminal.Prepare(c.worker, nil, command, args, text(entry["workspace"]), c.env, nil, true)
			if err != nil {
				return err
			}
			defer os.RemoveAll(spec.Directory)
			record := map[string]any{"terminal": spec.Info, "active": true, "repositoryId": repoID}
			if agent {
				record["mode"] = "agent"
			}
			encoded, _ := json.Marshal(record)
			if err = c.store.SetMeta("terminal:"+id, string(encoded)); err != nil {
				return err
			}
			c.store.NotifyChange()
			defer func() {
				record["active"] = false
				encoded, _ := json.Marshal(record)
				_ = c.store.SetMeta("terminal:"+id, string(encoded))
				c.store.NotifyChange()
			}()
			_, err = process.Run(ctx, process.Options{WorkerExecutable: c.worker, WorkerArgs: c.args, Command: c.worker, Args: []string{"--internal-terminal-worker", path}, Directory: text(entry["workspace"]), Environment: c.env, Timeout: 24 * time.Hour, MaxOutputBytes: 8 * 1024 * 1024})
			return err
		})
	}
	summary := "Interactive terminal closed. Return control to resume."
	if agent {
		summary = "Agent terminal closed."
	}
	if err != nil && ctx.Err() == nil {
		summary = "Interactive terminal stopped: " + err.Error()
		// Kept beside the terminal record so the page can say why there is nothing to show.
		stopped := map[string]any{"active": false, "repositoryId": repoID, "stopped": err.Error()}
		if agent {
			stopped["mode"] = "agent"
		}
		encoded, _ := json.Marshal(stopped)
		_ = c.store.SetMeta("terminal:"+id, string(encoded))
		c.store.NotifyChange()
	}
	_, _ = c.store.Event(id, mustJSON(map[string]any{"type": "terminal", "source": "relay", "summary": summary}))
}

// reserveTask holds only the task's own checkouts, not the repository they share, for a session
// a person drives in the task's worktree.
func (c *Coordinator) reserveTask(id string) (*workspace.Lease, []string, error) {
	raw, err := c.store.Get(id)
	if err != nil {
		return nil, nil, err
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil {
		return nil, nil, errors.New("invalid task")
	}
	entries, err := stageWorkspaces(value)
	if err != nil {
		return nil, nil, err
	}
	roots := make([]string, 0, len(entries))
	for _, entry := range entries {
		roots = append(roots, entry.root)
	}
	lease, err := c.registry.Acquire(id, roots)
	return lease, roots, err
}
