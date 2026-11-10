package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"relay.local/relay/internal/process"
)

type GitState struct {
	Root, Branch, Head string
	Clean              bool
}

// GitState reads branch, HEAD and cleanliness without changing the index.
func (r Runner) GitState(ctx context.Context, root string) (GitState, error) {
	if ctx == nil || !filepath.IsAbs(root) {
		return GitState{}, errors.New("workspace root required")
	}
	info, err := r.Inspect(ctx, Profile{Path: root})
	if err != nil {
		return GitState{}, err
	}
	requested, err := os.Stat(root)
	if err != nil {
		return GitState{}, err
	}
	actual, err := os.Stat(info.Root)
	if err != nil || !os.SameFile(requested, actual) {
		return GitState{}, errors.New("workspace root changed")
	}
	env := map[string]string{}
	for key, value := range r.Environment {
		env[key] = value
	}
	env["GIT_OPTIONAL_LOCKS"] = "0"
	r.Environment = env
	branch, err := r.git(ctx, info.Root, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return GitState{}, err
	}
	head, err := r.git(ctx, info.Root, "rev-parse", "HEAD")
	if err != nil {
		return GitState{}, err
	}
	head = strings.TrimSpace(head)
	if !commitPattern.MatchString(head) {
		return GitState{}, errors.New("invalid workspace HEAD")
	}
	status, err := r.git(ctx, info.Root, "status", "--porcelain", "--untracked-files=normal")
	if err != nil {
		return GitState{}, err
	}
	return GitState{Root: info.Root, Branch: strings.TrimSpace(branch), Head: head, Clean: strings.TrimSpace(status) == ""}, nil
}

// IsAncestor distinguishes a normal negative result from a Git failure.
func (r Runner) IsAncestor(ctx context.Context, root, ancestor, descendant string) (bool, error) {
	if ctx == nil || !filepath.IsAbs(root) || !commitPattern.MatchString(ancestor) || !commitPattern.MatchString(descendant) {
		return false, errors.New("valid workspace and commit IDs are required")
	}
	env := map[string]string{}
	for key, value := range r.Environment {
		env[key] = value
	}
	env["GIT_OPTIONAL_LOCKS"] = "0"
	result, err := process.Run(ctx, process.Options{WorkerExecutable: r.WorkerExecutable, WorkerArgs: r.WorkerArgs, Environment: env, Command: "git", Args: []string{"-C", root, "merge-base", "--is-ancestor", ancestor, descendant}, Directory: root, Timeout: 2 * time.Minute, MaxOutputBytes: 1024 * 1024})
	if err != nil {
		return false, fmt.Errorf("git merge-base in %s: %w", root, err)
	}
	switch result.ExitCode {
	case 0:
		return true, nil
	case 1:
		return false, nil
	default:
		return false, fmt.Errorf("git merge-base failed: %s", strings.TrimSpace(result.Stderr))
	}
}
