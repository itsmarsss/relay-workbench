package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"relay.local/relay/internal/process"
)

// ManagedProfile is an explicitly configured workspace manager. Commands are
// executed as argument vectors; ticket and model output never become commands.
type ManagedProfile struct {
	Profile
	PathTemplate string
	Command      string
	Args         []string
}

var workspaceKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

func existingParent(path string) (string, os.FileInfo, error) {
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		info, err := os.Stat(parent)
		if err == nil {
			if !info.IsDir() {
				return "", nil, errors.New("managed workspace parent is not a directory")
			}
			return parent, info, nil
		}
		if !errors.Is(err, os.ErrNotExist) || filepath.Dir(parent) == parent {
			return "", nil, err
		}
	}
}

// CreateManaged checkpoints the intended destination before running the
// configured manager and validates that it created a clean, separate checkout
// of the same Git repository. A failure retains the recorded draft and files.
func (r Runner) CreateManaged(ctx context.Context, area *WorktreeArea, profile ManagedProfile, taskID, repositoryID, workspaceKey, baseCommit string, admission Admission, checkpoint func(WorktreeDraft) error) (WorktreeDraft, error) {
	if nilDependency(ctx) || area == nil || area.state == nil || nilDependency(admission) || checkpoint == nil {
		return WorktreeDraft{}, errors.New("workspace area and checkpoint are required")
	}
	if !taskIDPattern.MatchString(taskID) || !workspaceKeyPattern.MatchString(workspaceKey) || !utf8.ValidString(repositoryID) || len(utf16.Encode([]rune(repositoryID))) > 100 || strings.TrimSpace(repositoryID) == "" || strings.ContainsRune(repositoryID, '\x00') {
		return WorktreeDraft{}, errors.New("invalid task or workspace identity")
	}
	if profile.Command == "" || strings.ContainsRune(profile.Command, '\x00') || len(profile.Args) > 100 || len(profile.PathTemplate) > 2000 {
		return WorktreeDraft{}, errors.New("invalid managed workspace configuration")
	}
	for _, arg := range profile.Args {
		if strings.ContainsRune(arg, '\x00') || len(arg) > 20000 {
			return WorktreeDraft{}, errors.New("invalid managed workspace argument")
		}
	}
	var draft WorktreeDraft
	err := area.state.WithOwnership(func(stateRoot string, verify func() error) error {
		if stateRoot != area.root {
			return errors.New("state directory changed")
		}
		if err := admission.Check(ctx, []string{stateRoot, profile.Path}); err != nil {
			return err
		}
		info, err := r.Inspect(ctx, profile.Profile)
		if err != nil {
			return err
		}
		if baseCommit == "" {
			baseCommit, err = r.git(ctx, info.Root, "rev-parse", "HEAD")
			if err != nil {
				return err
			}
			baseCommit = strings.TrimSpace(baseCommit)
		}
		if !commitPattern.MatchString(baseCommit) {
			return errors.New("invalid base commit")
		}
		branch := "relay/" + workspaceKey
		replacer := strings.NewReplacer("{taskId}", workspaceKey, "{workspaceName}", "relay-"+workspaceKey, "{branch}", branch, "{baseCommit}", baseCommit)
		path := replacer.Replace(profile.PathTemplate)
		if !filepath.IsAbs(path) {
			return errors.New("managed workspace path must be absolute")
		}
		path = filepath.Clean(path)
		parent, parentInfo, err := existingParent(path)
		if err != nil {
			return err
		}
		verifyParent := func() error {
			current, err := os.Stat(parent)
			if err != nil || !current.IsDir() || !os.SameFile(current, parentInfo) {
				return errors.New("managed workspace parent changed")
			}
			return nil
		}
		if _, err = os.Lstat(path); err == nil {
			return errors.New("managed workspace already exists; inspect it before retrying")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		draft = WorktreeDraft{TaskID: taskID, RepositoryID: repositoryID, SourceRoot: info.Root, Root: path, Cwd: filepath.Join(path, info.RelativeCwd), Branch: branch, BaseCommit: baseCommit}
		if err = checkpoint(draft); err != nil {
			return err
		}
		if err = verify(); err != nil {
			return err
		}
		if err = verifyParent(); err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		if _, err = os.Lstat(path); err == nil || !errors.Is(err, os.ErrNotExist) {
			return errors.New("managed workspace appeared before creation; inspect it before retrying")
		}
		if err = admission.Check(ctx, []string{stateRoot, info.Root, parent}); err != nil {
			return err
		}
		args := make([]string, len(profile.Args))
		for i, arg := range profile.Args {
			args[i] = replacer.Replace(arg)
		}
		result, err := process.Run(ctx, process.Options{WorkerExecutable: r.WorkerExecutable, WorkerArgs: r.WorkerArgs, Command: profile.Command, Args: args, Directory: info.Root, Environment: r.Environment, Timeout: 10 * time.Minute, MaxOutputBytes: 8 * 1024 * 1024})
		if err != nil {
			return &WorktreeError{draft, err}
		}
		if result.ExitCode != 0 {
			detail := strings.TrimSpace(result.Stderr)
			if detail == "" {
				detail = strings.TrimSpace(result.Stdout)
			}
			if len(detail) > 2000 {
				detail = detail[len(detail)-2000:]
			}
			return &WorktreeError{draft, fmt.Errorf("managed workspace command failed: %s", detail)}
		}
		target, err := r.Inspect(ctx, Profile{Path: path, Cwd: info.RelativeCwd})
		if err != nil {
			return &WorktreeError{draft, err}
		}
		if target.Root == info.Root {
			return &WorktreeError{draft, errors.New("workspace manager must create a separate checkout")}
		}
		sourceCommon, err := r.git(ctx, info.Root, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if err != nil {
			return &WorktreeError{draft, err}
		}
		targetCommon, err := r.git(ctx, target.Root, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if err != nil {
			return &WorktreeError{draft, err}
		}
		sourcePath, sourceErr := filepath.EvalSymlinks(strings.TrimSpace(sourceCommon))
		targetPath, targetErr := filepath.EvalSymlinks(strings.TrimSpace(targetCommon))
		if sourceErr != nil || targetErr != nil || sourcePath != targetPath {
			return &WorktreeError{draft, errors.New("managed workspace belongs to a different repository")}
		}
		actualBranch, err := r.git(ctx, target.Root, "symbolic-ref", "--short", "HEAD")
		if err != nil {
			return &WorktreeError{draft, err}
		}
		if strings.TrimSpace(actualBranch) != branch {
			return &WorktreeError{draft, errors.New("managed workspace has an unexpected branch")}
		}
		head, err := r.git(ctx, target.Root, "rev-parse", "HEAD")
		if err != nil {
			return &WorktreeError{draft, err}
		}
		if strings.TrimSpace(head) != baseCommit {
			return &WorktreeError{draft, errors.New("managed workspace has an unexpected base commit")}
		}
		status, err := r.git(ctx, target.Root, "status", "--porcelain", "--untracked-files=normal")
		if err != nil {
			return &WorktreeError{draft, err}
		}
		if strings.TrimSpace(status) != "" {
			return &WorktreeError{draft, errors.New("new managed workspace must be clean")}
		}
		if err = verify(); err != nil {
			return &WorktreeError{draft, err}
		}
		if err = verifyParent(); err != nil {
			return &WorktreeError{draft, err}
		}
		if err = ctx.Err(); err != nil {
			return &WorktreeError{draft, err}
		}
		draft.Root, draft.Cwd = target.Root, target.Cwd
		return nil
	})
	return draft, err
}
