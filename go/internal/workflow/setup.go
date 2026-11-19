package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"relay.local/relay/internal/process"
	"relay.local/relay/internal/storage"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/terminal"
)

// Setup checks what Relay relies on (Git, the agent CLIs, the GitHub CLI, tmux, the build tools
// it updates itself with, disk space) and offers to install or log in to what is missing.
//
// Nothing runs without a person: an install or a login is started from the page, after it shows
// the exact command, in a terminal the person watches and types into (a password, a login code).
// The commands come only from the fixed table below, chosen by the item's ID; a request never
// carries a command.

// SetupTerminalID is the terminal that belongs to setup rather than to a task.
const SetupTerminalID = "setup"

type SetupAction struct {
	Label   string   `json:"label"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Display string   `json:"display"`
}

type SetupItem struct {
	ID       string       `json:"id"`
	Label    string       `json:"label"`
	Why      string       `json:"why"`
	Required bool         `json:"required"`
	Status   string       `json:"status"` // ok, missing, attention, off
	Detail   string       `json:"detail"`
	Install  *SetupAction `json:"install,omitempty"`
	Login    *SetupAction `json:"login,omitempty"`
}

func action(label, command string, args ...string) *SetupAction {
	return &SetupAction{Label: label, Command: command, Args: args, Display: strings.TrimSpace(command + " " + strings.Join(args, " "))}
}

// installer returns how to install a system package on this machine, if Relay knows one.
func installer(brew, apt string) *SetupAction {
	switch runtime.GOOS {
	case "darwin":
		if _, err := exec.LookPath("brew"); err == nil && brew != "" {
			return action("Install with Homebrew", "brew", "install", brew)
		}
	case "linux":
		if _, err := exec.LookPath("apt-get"); err == nil && apt != "" {
			return action("Install with apt", "sudo", "apt-get", "install", "-y", apt)
		}
	}
	return nil
}

func npmInstall(pkg string) *SetupAction {
	if _, err := exec.LookPath("npm"); err != nil {
		return nil
	}
	return action("Install with npm", "npm", "install", "-g", pkg)
}

func quick(ctx context.Context, name string, args ...string) (string, bool) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	line := strings.TrimSpace(strings.SplitN(strings.TrimSpace(string(out)), "\n", 2)[0])
	if len(line) > 120 {
		line = line[:120]
	}
	return line, err == nil
}

func found(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// SetupCheck reports each prerequisite with what to do about it.
func (c *Coordinator) SetupCheck(ctx context.Context) (any, error) {
	return c.setupItems(ctx)
}

func (c *Coordinator) setupItems(ctx context.Context) ([]SetupItem, error) {
	config, err := (task.ConfigurationService{Store: c.store}).Read()
	if err != nil {
		return nil, err
	}
	items := []SetupItem{}
	tool := func(id, label, why string, required bool, binary string, versionArgs []string, install *SetupAction) SetupItem {
		item := SetupItem{ID: id, Label: label, Why: why, Required: required, Status: "missing", Install: install}
		if install == nil {
			item.Detail = "Not installed. Install it with your system's package manager, then check again."
		}
		if found(binary) {
			item.Status, item.Install = "ok", nil
			item.Detail, _ = quick(ctx, binary, versionArgs...)
		}
		return item
	}
	items = append(items, tool("git", "Git", "Every task works in its own Git worktree.", true, "git", []string{"--version"}, installer("git", "git")))
	agents := []struct{ id, label, pkg string }{{"claude", "Claude Code", "@anthropic-ai/claude-code"}, {"codex", "Codex", "@openai/codex"}, {"pi", "Pi", ""}}
	for _, agent := range agents {
		harness := object(object(config.Value["harnesses"])[agent.id])
		command := text(harness["command"])
		if command == "" {
			command = agent.id
		}
		item := SetupItem{ID: agent.id, Label: agent.label, Why: "Runs workflow stages, chats and agent terminals.", Status: "missing"}
		if harness["enabled"] != true {
			item.Status, item.Detail = "off", "Turned off in Agents."
			items = append(items, item)
			continue
		}
		if !found(command) {
			if agent.pkg != "" {
				item.Install = npmInstall(agent.pkg)
			}
			if item.Install == nil {
				item.Detail = "Not installed. Install it from its own instructions, or turn it off if you won't use it."
			}
			items = append(items, item)
			continue
		}
		result := c.catalog.Provider(ctx, agent.id, command, false)
		if result.Status == "ready" {
			item.Status, item.Detail = "ok", fmt.Sprintf("Ready, %d models.", len(result.Models))
		} else {
			item.Status, item.Detail = "attention", "Installed, but it did not answer. It may need a login."
			switch agent.id {
			case "claude":
				item.Login = action("Open Claude Code to log in", command)
			case "codex":
				item.Login = action("Log in to Codex", command, "login")
			}
		}
		items = append(items, item)
	}
	anyAgent := false
	for _, item := range items {
		if (item.ID == "claude" || item.ID == "codex" || item.ID == "pi") && item.Status == "ok" {
			anyAgent = true
		}
	}
	if !anyAgent {
		for i := range items {
			if items[i].ID == "claude" || items[i].ID == "codex" || items[i].ID == "pi" {
				items[i].Required = true
			}
		}
	}
	gh := SetupItem{ID: "gh", Label: "GitHub CLI", Why: "Publishes pull requests, reads issues and CI results.", Status: "missing", Install: installer("gh", "gh")}
	if found("gh") {
		gh.Install = nil
		if detail, ok := quick(ctx, "gh", "auth", "status"); ok {
			gh.Status, gh.Detail = "ok", "Logged in."
		} else {
			gh.Status, gh.Detail = "attention", "Not logged in."
			if detail != "" && !strings.Contains(strings.ToLower(detail), "not logged") {
				gh.Detail = detail
			}
			gh.Login = action("Log in to GitHub", "gh", "auth", "login")
		}
	}
	items = append(items, gh)
	items = append(items, tool("tmux", "tmux", "Live terminals in the browser.", false, "tmux", []string{"-V"}, installer("tmux", "tmux")))
	items = append(items, tool("go", "Go", "Rebuilds Relay when it updates itself.", false, "go", []string{"version"}, installer("go", "golang-go")))
	items = append(items, tool("pnpm", "pnpm", "Builds Relay's web app when it updates itself.", false, "pnpm", []string{"--version"}, func() *SetupAction {
		if a := installer("pnpm", ""); a != nil {
			return a
		}
		return npmInstall("pnpm")
	}()))
	disk := SetupItem{ID: "disk", Label: "Disk space", Why: "Each task's worktree and build output need room.", Status: "ok"}
	_ = c.store.WithOwnership(func(root string, _ func() error) error {
		space, err := storage.ProbeWithTimeout(ctx, root, 2*time.Second, storage.Filesystem)
		if err != nil {
			disk.Status, disk.Detail = "attention", "Could not read free space."
			return nil
		}
		free := float64(space.AvailableBytes) / (1 << 30)
		disk.Detail = fmt.Sprintf("%.0f GiB free.", free)
		if free < 20 {
			disk.Status = "attention"
			disk.Detail += " Large repositories need more; free some space."
		}
		return nil
	})
	items = append(items, disk)
	return items, nil
}

// RunSetup opens the setup terminal running one item's install or login command.
func (c *Coordinator) RunSetup(ctx context.Context, body map[string]any) (any, error) {
	if err := fields(body, "item", "action"); err != nil {
		return nil, err
	}
	if !c.terminals {
		return nil, errors.New("install tmux to run setup in a terminal; until then, run the command yourself")
	}
	items, err := c.setupItems(ctx)
	if err != nil {
		return nil, err
	}
	var chosen *SetupAction
	for _, item := range items {
		if item.ID == text(body["item"]) {
			if text(body["action"]) == "install" {
				chosen = item.Install
			} else if text(body["action"]) == "login" {
				chosen = item.Login
			}
		}
	}
	if chosen == nil {
		return nil, errors.New("there is nothing to run for that item")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, errors.New("Relay is shutting down")
	}
	if c.jobs[SetupTerminalID] != nil {
		return nil, errors.New("finish or close the setup terminal that is open first")
	}
	jobCtx, cancel := context.WithCancel(context.Background())
	job := &coordinatorJob{cancel: cancel, done: make(chan struct{}), kind: "setup-terminal"}
	c.jobs[SetupTerminalID] = job
	go c.runSetupTerminal(jobCtx, home, *chosen, job)
	return map[string]any{"running": chosen.Display}, nil
}

func (c *Coordinator) runSetupTerminal(ctx context.Context, directory string, run SetupAction, job *coordinatorJob) {
	defer func() { c.mu.Lock(); delete(c.jobs, SetupTerminalID); c.notifyLocked(); close(job.done); c.mu.Unlock() }()
	spec, path, err := terminal.Prepare(c.worker, nil, run.Command, run.Args, directory, c.env, nil, true)
	if err == nil {
		defer os.RemoveAll(spec.Directory)
		record := map[string]any{"terminal": spec.Info, "active": true, "mode": "setup", "command": run.Display}
		encoded, _ := json.Marshal(record)
		if err = c.store.SetMeta("terminal:"+SetupTerminalID, string(encoded)); err == nil {
			c.store.NotifyChange()
			_, err = process.Run(ctx, process.Options{WorkerExecutable: c.worker, WorkerArgs: c.args, Command: c.worker, Args: []string{"--internal-terminal-worker", path}, Directory: directory, Environment: c.env, Timeout: 2 * time.Hour, MaxOutputBytes: 8 * 1024 * 1024})
		}
	}
	record := map[string]any{"active": false, "mode": "setup", "command": run.Display}
	if err != nil && ctx.Err() == nil {
		record["stopped"] = err.Error()
	}
	encoded, _ := json.Marshal(record)
	_ = c.store.SetMeta("terminal:"+SetupTerminalID, string(encoded))
	c.store.NotifyChange()
}
