package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"relay.local/relay/internal/discovery"
	"relay.local/relay/internal/process"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/workspace"
)

// addRepository saves a repository profile straight from what Relay detects in the checkout:
// its name, root and working folder, and the dependency install step its lockfile implies. Checks
// are left to the verification agent, which reads the repository's own guidance, so nothing has
// to be configured by hand to start. The profile stays editable like any other.
func (c *Coordinator) addRepository(ctx context.Context, path, cwd string) (map[string]any, error) {
	if cwd == "" {
		cwd = "."
	}
	if !filepath.IsAbs(path) {
		return nil, errors.New("use an absolute folder path")
	}
	runner := workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}
	found, err := discovery.Suggestions(ctx, runner, path, cwd)
	if err != nil {
		return nil, err
	}
	root, name, folder := path, filepath.Base(path), cwd
	setup := []any{}
	detected := []string{}
	suggestions, _ := found["suggestions"].([]map[string]any)
	for _, suggestion := range suggestions {
		switch text(suggestion["field"]) {
		case "path":
			root = text(suggestion["value"])
		case "name":
			// The last name is the most specific one: a package name over the folder's.
			if value := strings.TrimSpace(text(suggestion["value"])); value != "" {
				name = value
			}
		case "cwd":
			if text(suggestion["label"]) == "Working directory" && cwd == "." {
				folder = text(suggestion["value"])
			}
		case "setup":
			// Through JSON, so the command is plain JSON values like any saved configuration.
			var command any
			raw, _ := json.Marshal(suggestion["value"])
			if json.Unmarshal(raw, &command) != nil {
				continue
			}
			setup = append(setup, command)
			detected = append(detected, text(suggestion["label"])+" ("+text(suggestion["evidence"])+")")
		}
	}
	if folder == "" {
		folder = "."
	}
	if len(name) > 100 {
		name = name[:100]
	}
	for attempt := 0; attempt < 3; attempt++ {
		config, err := (task.ConfigurationService{Store: c.store}).Read()
		if err != nil {
			return nil, err
		}
		canonical, _ := filepath.EvalSymlinks(root)
		for _, item := range array(config.Value["repositories"]) {
			profile := object(item)
			existing, _ := filepath.EvalSymlinks(text(profile["path"]))
			if existing != "" && existing == canonical && text(profile["cwd"]) == folder {
				return map[string]any{"repository": profile, "existing": true, "configRevision": config.Revision}, nil
			}
		}
		id, err := stageUUID()
		if err != nil {
			return nil, err
		}
		profile := map[string]any{"id": id, "name": name, "path": root, "cwd": folder, "strategy": "worktree", "verificationMode": "agent", "instructions": "", "checks": []any{}, "setup": setup}
		config.Value["repositories"] = append(array(config.Value["repositories"]), profile)
		saved, err := (task.ConfigurationService{Store: c.store}).Replace(config.Revision, config.Value)
		if errors.Is(err, store.ErrConfigChanged) {
			continue
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{"repository": profile, "configRevision": saved.Revision, "detected": detected, "guidance": found["guidance"]}, nil
	}
	return nil, errors.New("settings kept changing; try again")
}

var cloneURL = regexp.MustCompile(`^(https://[A-Za-z0-9.-]+(:[0-9]+)?/|ssh://[A-Za-z0-9._@-]+(:[0-9]+)?/|git@[A-Za-z0-9.-]+:)[A-Za-z0-9._~/-]+$`)

// CloneDirectory is where repositories cloned from a URL go unless the person picks a folder.
func CloneDirectory() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, "relay-repositories")
}

// cloneRepository clones a repository from a URL with the person's own Git credentials, then adds
// it. A URL is passed to git as a single argument after "--"; it is never shell text.
func (c *Coordinator) cloneRepository(ctx context.Context, url, directory string) (map[string]any, error) {
	url = strings.TrimSpace(url)
	if len(url) > 500 || !cloneURL.MatchString(url) {
		return nil, errors.New("paste an https:// or git@ repository URL")
	}
	name := strings.TrimSuffix(url[strings.LastIndexAny(url, "/:")+1:], ".git")
	if name == "" || name == "." || name == ".." || !regexp.MustCompile(`^[A-Za-z0-9._-]+$`).MatchString(name) {
		return nil, errors.New("could not tell the repository's name from that URL")
	}
	if directory == "" {
		directory = CloneDirectory()
	}
	if !filepath.IsAbs(directory) {
		return nil, errors.New("choose an absolute folder to clone into")
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return nil, err
	}
	destination := filepath.Join(directory, name)
	if _, err := os.Stat(filepath.Join(destination, ".git")); err == nil {
		// Already cloned there: add it rather than fail.
		return c.addRepository(ctx, destination, ".")
	} else if _, err := os.Stat(destination); err == nil {
		return nil, fmt.Errorf("%s already exists and is not a Git checkout", destination)
	}
	env := map[string]string{}
	for key, value := range c.env {
		env[key] = value
	}
	env["GIT_TERMINAL_PROMPT"] = "0"
	result, err := process.Run(ctx, process.Options{WorkerExecutable: c.worker, WorkerArgs: c.args, Command: "git", Args: []string{"clone", "--quiet", "--", url, destination}, Directory: directory, Environment: env, Timeout: 30 * time.Minute, MaxOutputBytes: 1024 * 1024})
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 {
		_ = os.RemoveAll(destination)
		detail := strings.TrimSpace(result.Stderr)
		if len(detail) > 600 {
			detail = detail[:600]
		}
		return nil, errors.New("git could not clone it: " + detail)
	}
	return c.addRepository(ctx, destination, ".")
}
