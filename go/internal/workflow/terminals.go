package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"os"
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
func (c *Coordinator) Terminal(ctx context.Context, id, operation string, body map[string]any) (any, error) {
	if operation == "takeover" {
		return c.takeover(ctx, id, body)
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
		info, _, err := c.terminalInfo(id)
		if err != nil {
			return nil, err
		}
		if info.Session != text(body["session"]) {
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
		if !active {
			return map[string]any{"available": false, "message": "No live terminal. Retained agent output is available in Activity and Logs."}, nil
		}
		output, err := terminal.Capture(ctx, info)
		if err != nil {
			return map[string]any{"available": false, "message": "Terminal is starting or has closed."}, nil
		}
		return map[string]any{"available": true, "terminal": info, "output": output}, nil
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
	if json.Unmarshal(raw, &value) != nil || value["status"] != "manual" {
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
func (c *Coordinator) takeover(ctx context.Context, id string, body map[string]any) (any, error) {
	if err := fields(body, "repositoryId", "provider", "model", "effort"); err != nil {
		return nil, err
	}
	_, value, err := c.inspected(id, body)
	if err != nil {
		return nil, err
	}
	if !c.terminals || value["demo"] == true || value["status"] == "draft" || value["status"] == "manual" {
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
	command, args := "/bin/sh", []string{"-i"}
	provider := text(body["provider"])
	if provider != "" {
		config, err := (task.ConfigurationService{Store: c.store}).Read()
		if err != nil {
			return nil, err
		}
		enabled, configs := enabledAgents(config.Value)
		if !enabled[provider] {
			return nil, errors.New("selected provider is unavailable")
		}
		model, effort, err := harness.Options(provider, text(body["model"]), text(body["effort"]))
		if err != nil {
			return nil, err
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
func (c *Coordinator) runManual(ctx context.Context, id, repoID, command string, args []string, job *coordinatorJob) {
	defer func() { c.mu.Lock(); delete(c.jobs, id); c.notifyLocked(); close(job.done); c.mu.Unlock() }()
	lease, roots, err := c.reserveRepositories(ctx, id)
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
			if err = runner.VerifyExisting(ctx, workspace.Profile{Path: text(profile["path"]), Cwd: text(profile["cwd"])}, text(entry["workspaceRoot"]), text(entry["workspace"]), text(entry["branch"]), text(entry["baseCommit"])); err != nil {
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
	if err != nil && ctx.Err() == nil {
		summary = "Interactive terminal stopped: " + err.Error()
	}
	_, _ = c.store.Event(id, mustJSON(map[string]any{"type": "terminal", "source": "relay", "summary": summary}))
}
