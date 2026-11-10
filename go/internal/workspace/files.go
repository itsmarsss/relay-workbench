package workspace

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"relay.local/relay/internal/process"
	"strings"
	"time"
)

// ReadFile bounds inspection and refuses symlink traversal and special files.
func ReadFile(root, name string, limit int64) ([]byte, error) {
	if !filepath.IsAbs(root) || filepath.IsAbs(name) || limit < 1 || limit > 8*1024*1024 {
		return nil, errors.New("invalid file inspection")
	}
	return readPreviewFile(root, filepath.ToSlash(name), limit)
}

// RunGit is used by trusted checkpoint and lifecycle operations. Arguments are
// constructed by Relay; task and ticket content is never evaluated by a shell.
func (r Runner) RunGit(ctx context.Context, root string, args []string, input []byte, extra map[string]string) (string, error) {
	env := map[string]string{}
	for key, value := range r.Environment {
		env[key] = value
	}
	for key, value := range extra {
		env[key] = value
	}
	result, err := process.Run(ctx, process.Options{WorkerExecutable: r.WorkerExecutable, WorkerArgs: r.WorkerArgs, Environment: env, Command: "git", Args: append([]string{"-C", root}, args...), Directory: root, Input: input, Timeout: 2 * time.Minute, MaxOutputBytes: 8 * 1024 * 1024})
	if err != nil {
		return "", err
	}
	if result.ExitCode != 0 {
		return "", fmt.Errorf("git %s failed: %s", args[0], strings.TrimSpace(result.Stderr))
	}
	return result.Stdout, nil
}
