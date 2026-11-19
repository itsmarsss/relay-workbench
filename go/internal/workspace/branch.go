package workspace

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"relay.local/relay/internal/process"
)

// Branch updates bring a task branch up to date with its mainline the way a code host's
// "Update branch" does: fetch, merge, push. Every call names its refs explicitly; nothing a ticket
// or an agent wrote reaches git as an argument.

var refName = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,200}$`)

func safeRef(name string) bool {
	return refName.MatchString(name) && !strings.Contains(name, "..") && !strings.HasPrefix(name, "-") && !strings.HasPrefix(name, "/") && !strings.HasSuffix(name, "/") && !strings.HasSuffix(name, ".lock")
}

// gitStep runs a git command that may take a while on a large repository and whose non-zero exit
// is an answer rather than a failure (a merge stopping on conflicts).
func (r Runner) gitStep(ctx context.Context, root string, args ...string) (process.Result, error) {
	env := map[string]string{}
	for key, value := range r.Environment {
		env[key] = value
	}
	// Never wait for a person at a terminal prompt or an editor: Relay is not one.
	env["GIT_TERMINAL_PROMPT"], env["GIT_EDITOR"], env["GIT_MERGE_AUTOEDIT"] = "0", "true", "no"
	result, err := process.Run(ctx, process.Options{WorkerExecutable: r.WorkerExecutable, WorkerArgs: r.WorkerArgs, Command: "git", Args: append([]string{"-C", root}, args...), Directory: root, Environment: env, Timeout: 15 * time.Minute, MaxOutputBytes: 4 * 1024 * 1024})
	if err != nil {
		return result, fmt.Errorf("git %s in %s: %w", args[0], root, err)
	}
	return result, nil
}

func stepError(args []string, result process.Result) error {
	detail := strings.TrimSpace(result.Stderr)
	if detail == "" {
		detail = strings.TrimSpace(result.Stdout)
	}
	if len(detail) > 2000 {
		detail = detail[:2000] + "…"
	}
	return fmt.Errorf("git %s failed: %s", args[0], detail)
}

func (r Runner) step(ctx context.Context, root string, args ...string) (string, error) {
	result, err := r.gitStep(ctx, root, args...)
	if err != nil {
		return "", err
	}
	if result.ExitCode != 0 {
		return "", stepError(args, result)
	}
	return result.Stdout, nil
}

// Upstream is the remote the branch pushes to and the mainline branch on it: the remote's own
// default branch when it says, otherwise main, master or trunk, whichever it has.
func (r Runner) Upstream(ctx context.Context, root, branch string) (remote, mainline string, err error) {
	if !filepath.IsAbs(root) || !safeRef(branch) {
		return "", "", errors.New("workspace and branch are required")
	}
	remote = "origin"
	if configured, e := r.git(ctx, root, "config", "--get", "branch."+branch+".remote"); e == nil {
		if name := strings.TrimSpace(configured); name != "" && name != "." && safeRef(name) && !strings.Contains(name, "/") {
			remote = name
		}
	}
	if head, e := r.git(ctx, root, "symbolic-ref", "--short", "refs/remotes/"+remote+"/HEAD"); e == nil {
		if name := strings.TrimPrefix(strings.TrimSpace(head), remote+"/"); name != "" && safeRef(name) && name != branch {
			return remote, name, nil
		}
	}
	for _, name := range []string{"main", "master", "trunk"} {
		if _, e := r.git(ctx, root, "rev-parse", "--verify", "--quiet", "refs/remotes/"+remote+"/"+name); e == nil && name != branch {
			return remote, name, nil
		}
	}
	listed, e := r.step(ctx, root, "ls-remote", "--heads", remote, "main", "master", "trunk")
	if e != nil {
		return "", "", e
	}
	for _, name := range []string{"main", "master", "trunk"} {
		if strings.Contains(listed, "refs/heads/"+name+"\n") || strings.HasSuffix(listed, "refs/heads/"+name) {
			return remote, name, nil
		}
	}
	return "", "", errors.New("could not find the repository's main branch on " + remote)
}

// FetchBranch updates the remote-tracking ref for one branch and returns the commit it points at.
// A branch the remote does not have is reported as missing, not as an error.
func (r Runner) FetchBranch(ctx context.Context, root, remote, branch string) (commit string, found bool, err error) {
	if !filepath.IsAbs(root) || !safeRef(remote) || !safeRef(branch) {
		return "", false, errors.New("invalid fetch target")
	}
	tracking := "refs/remotes/" + remote + "/" + branch
	args := []string{"fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, "+refs/heads/" + branch + ":" + tracking}
	result, err := r.gitStep(ctx, root, args...)
	if err != nil {
		return "", false, err
	}
	if result.ExitCode != 0 {
		if strings.Contains(strings.ToLower(result.Stderr), "couldn't find remote ref") {
			return "", false, nil
		}
		return "", false, stepError(args, result)
	}
	head, err := r.git(ctx, root, "rev-parse", "--verify", tracking+"^{commit}")
	if err != nil {
		return "", false, err
	}
	if head = strings.TrimSpace(head); !commitPattern.MatchString(head) {
		return "", false, errors.New("fetched ref is not a commit")
	}
	return head, true, nil
}

// FastForward moves a clean checkout forward to a commit that already contains it.
func (r Runner) FastForward(ctx context.Context, root, commit string) error {
	if !commitPattern.MatchString(commit) {
		return errors.New("a commit is required")
	}
	_, err := r.step(ctx, root, "merge", "--ff-only", "--quiet", "--no-stat", commit)
	return err
}

// MergeCommit merges a commit into the checked-out branch with a merge commit. Conflicts are an
// outcome: the merge is left in progress and the conflicted paths are returned.
func (r Runner) MergeCommit(ctx context.Context, root, commit, message string) (conflicts []string, err error) {
	if !commitPattern.MatchString(commit) || message == "" || len(message) > 500 || strings.ContainsRune(message, 0) {
		return nil, errors.New("a commit and message are required")
	}
	// Repository commit hooks run against everything the mainline brought in, which on a large
	// repository is slow and checks code this branch never wrote; CI checks the result.
	args := []string{"merge", "--no-ff", "--no-verify", "--no-edit", "--quiet", "--no-stat", "-m", message, commit}
	result, err := r.gitStep(ctx, root, args...)
	if err != nil {
		return nil, err
	}
	if result.ExitCode == 0 {
		return nil, nil
	}
	conflicts, listErr := r.Unmerged(ctx, root)
	if listErr != nil {
		return nil, listErr
	}
	if len(conflicts) == 0 {
		if r.MergeInProgress(ctx, root) {
			_ = r.AbortMerge(ctx, root)
		}
		return nil, stepError(args, result)
	}
	return conflicts, nil
}

// Unmerged lists the paths a merge left conflicted.
func (r Runner) Unmerged(ctx context.Context, root string) ([]string, error) {
	output, err := r.git(ctx, root, "diff", "--name-only", "--diff-filter=U", "-z")
	if err != nil {
		return nil, err
	}
	paths := []string{}
	for _, name := range strings.Split(output, "\x00") {
		if name != "" {
			paths = append(paths, name)
		}
	}
	return paths, nil
}

// MergeInProgress reports whether the checkout is part-way through a merge.
func (r Runner) MergeInProgress(ctx context.Context, root string) bool {
	result, err := r.gitStep(ctx, root, "rev-parse", "--quiet", "--verify", "MERGE_HEAD")
	return err == nil && result.ExitCode == 0
}

// AbortMerge returns the checkout to where it was before a merge Relay started.
func (r Runner) AbortMerge(ctx context.Context, root string) error {
	_, err := r.step(ctx, root, "merge", "--abort")
	return err
}

// ConflictMarkers lists the given files that still hold conflict markers.
func (r Runner) ConflictMarkers(root string, paths []string) ([]string, error) {
	left := []string{}
	for _, name := range paths {
		full := filepath.Join(root, name)
		if filepath.IsAbs(name) || !within(root, full) {
			return nil, errors.New("conflicted path escapes workspace")
		}
		file, err := os.Open(full)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
		marked := false
		for scanner.Scan() {
			line := scanner.Bytes()
			if bytes.HasPrefix(line, []byte("<<<<<<< ")) || bytes.HasPrefix(line, []byte(">>>>>>> ")) || bytes.Equal(line, []byte("<<<<<<<")) || bytes.Equal(line, []byte(">>>>>>>")) {
				marked = true
				break
			}
		}
		_ = file.Close()
		if marked {
			left = append(left, name)
		}
	}
	return left, nil
}

// CompleteMerge records a resolved merge: tracked changes are staged and committed with the
// merge's own message. Files nobody asked for (untracked) are refused rather than swept in.
func (r Runner) CompleteMerge(ctx context.Context, root string) (string, error) {
	if !r.MergeInProgress(ctx, root) {
		return "", errors.New("no merge is in progress")
	}
	untracked, err := r.git(ctx, root, "ls-files", "--others", "--exclude-standard")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(untracked) != "" {
		names := strings.Split(strings.TrimSpace(untracked), "\n")
		if len(names) > 5 {
			names = append(names[:5], "…")
		}
		return "", errors.New("the resolution left new untracked files: " + strings.Join(names, ", "))
	}
	if _, err = r.step(ctx, root, "add", "--update"); err != nil {
		return "", err
	}
	if remaining, err := r.Unmerged(ctx, root); err != nil || len(remaining) > 0 {
		if err == nil {
			err = errors.New("still conflicted: " + strings.Join(remaining, ", "))
		}
		return "", err
	}
	if _, err = r.step(ctx, root, "commit", "--no-edit", "--no-verify", "--quiet"); err != nil {
		return "", err
	}
	return r.Head(ctx, root)
}

// PushBranch publishes the checked-out commit to the branch on the remote. It never forces:
// a remote that moved on is reported, not overwritten.
func (r Runner) PushBranch(ctx context.Context, root, remote, branch string) error {
	if !safeRef(remote) || !safeRef(branch) {
		return errors.New("invalid push target")
	}
	_, err := r.step(ctx, root, "push", "--quiet", remote, "HEAD:refs/heads/"+branch)
	return err
}

// ResetTo moves the branch and checkout back to a commit it was at, discarding Relay's own
// unpushed merge. Callers check that the commit is the branch's earlier head.
func (r Runner) ResetTo(ctx context.Context, root, commit string) error {
	if !commitPattern.MatchString(commit) {
		return errors.New("a commit is required")
	}
	_, err := r.step(ctx, root, "reset", "--hard", "--quiet", commit)
	return err
}

// Remotes maps each configured remote to its fetch URL.
func (r Runner) Remotes(ctx context.Context, root string) (map[string]string, error) {
	output, err := r.git(ctx, root, "remote", "-v")
	if err != nil {
		return nil, err
	}
	remotes := map[string]string{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 3 && fields[2] == "(fetch)" {
			remotes[fields[0]] = fields[1]
		}
	}
	return remotes, nil
}
