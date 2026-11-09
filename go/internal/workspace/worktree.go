package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"relay.local/relay/internal/store"
)

var taskIDPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var commitPattern = regexp.MustCompile(`^([a-f0-9]{40}|[a-f0-9]{64})$`)

type WorktreeArea struct {
	root  string
	state *store.Store
}
type WorktreeDraft struct{ TaskID, RepositoryID, SourceRoot, Root, Cwd, Branch, BaseCommit string }
type WorktreeError struct {
	Draft WorktreeDraft
	Cause error
}

func (e *WorktreeError) Error() string {
	return fmt.Sprintf("worktree preparation needs inspection: %v", e.Cause)
}
func (e *WorktreeError) Unwrap() error { return e.Cause }

// NewWorktreeArea requires an open, exclusively owned experimental store.
func NewWorktreeArea(state *store.Store) (*WorktreeArea, error) {
	if state == nil {
		return nil, errors.New("state ownership required")
	}
	var root string
	if err := state.WithOwnership(func(path string, _ func() error) error { root = path; return nil }); err != nil {
		return nil, err
	}
	return &WorktreeArea{root: root, state: state}, nil
}

// CreateWorktree records the draft before any Git mutation. Failures preserve
// partial files and return the draft for recovery; it never deletes work.
func (r Runner) CreateWorktree(ctx context.Context, area *WorktreeArea, profile Profile, taskID, repositoryID, baseCommit string, checkpoint func(WorktreeDraft) error) (WorktreeDraft, error) {
	if ctx == nil || area == nil || area.state == nil || checkpoint == nil {
		return WorktreeDraft{}, errors.New("worktree area and checkpoint are required")
	}
	var result WorktreeDraft
	err := area.state.WithOwnership(func(root string, verify func() error) error {
		if root != area.root {
			return errors.New("state directory changed")
		}
		var err error
		result, err = r.createOwned(ctx, area, profile, taskID, repositoryID, baseCommit, checkpoint, verify)
		return err
	})
	return result, err
}
func (r Runner) createOwned(ctx context.Context, area *WorktreeArea, profile Profile, taskID, repositoryID, baseCommit string, checkpoint func(WorktreeDraft) error, verify func() error) (WorktreeDraft, error) {
	if !taskIDPattern.MatchString(taskID) || !utf8.ValidString(repositoryID) || strings.TrimSpace(repositoryID) == "" || strings.ContainsRune(repositoryID, '\x00') || len(utf16.Encode([]rune(repositoryID))) > 100 {
		return WorktreeDraft{}, errors.New("invalid task or repository identity")
	}

	info, err := r.Inspect(ctx, profile)
	if err != nil {
		return WorktreeDraft{}, err
	}
	if baseCommit == "" {
		head, err := r.git(ctx, info.Root, "rev-parse", "HEAD")
		if err != nil {
			return WorktreeDraft{}, err
		}
		baseCommit = strings.TrimSpace(head)
	}
	if !commitPattern.MatchString(baseCommit) {
		return WorktreeDraft{}, errors.New("invalid base commit")
	}
	parent := filepath.Join(area.root, "worktrees")
	if err = os.Mkdir(parent, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return WorktreeDraft{}, err
	}
	parentInfo, err := os.Lstat(parent)
	if err != nil || !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 {
		return WorktreeDraft{}, errors.New("invalid worktree directory")
	}
	verifyParent := func() error {
		current, err := os.Lstat(parent)
		if err != nil || !current.IsDir() || current.Mode()&os.ModeSymlink != 0 || !os.SameFile(current, parentInfo) {
			return errors.New("worktree directory changed")
		}
		return nil
	}

	sum := sha256.Sum256([]byte(repositoryID))
	name := taskID + "-" + hex.EncodeToString(sum[:])
	destination := filepath.Join(parent, name)
	if _, err = os.Lstat(destination); err == nil {
		return WorktreeDraft{}, errors.New("worktree destination already exists; inspect it before retrying")
	} else if !errors.Is(err, os.ErrNotExist) {
		return WorktreeDraft{}, err
	}
	draft := WorktreeDraft{TaskID: taskID, RepositoryID: repositoryID, SourceRoot: info.Root, Root: destination, Cwd: filepath.Join(destination, info.RelativeCwd), Branch: "relay/" + taskID, BaseCommit: baseCommit}
	if err = checkpoint(draft); err != nil {
		return draft, err
	}
	if err = ctx.Err(); err != nil {
		return draft, err
	}
	if err = verify(); err != nil {
		return draft, err
	}
	if err = verifyParent(); err != nil {
		return draft, err
	}
	if _, err = r.git(ctx, info.Root, "worktree", "add", "-b", draft.Branch, draft.Root, draft.BaseCommit); err != nil {
		return draft, &WorktreeError{draft, err}
	}
	target, err := r.Inspect(ctx, Profile{Path: draft.Root, Cwd: info.RelativeCwd})
	if err != nil {
		return draft, &WorktreeError{draft, err}
	}
	expectedRoot, err := filepath.EvalSymlinks(draft.Root)
	if err != nil || target.Root != expectedRoot {
		return draft, &WorktreeError{draft, errors.New("worktree root does not match")}
	}
	sourceCommon, err := r.git(ctx, info.Root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return draft, &WorktreeError{draft, err}
	}
	targetCommon, err := r.git(ctx, target.Root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return draft, &WorktreeError{draft, err}
	}
	sourcePath, sourceErr := filepath.EvalSymlinks(strings.TrimSpace(sourceCommon))
	targetPath, targetErr := filepath.EvalSymlinks(strings.TrimSpace(targetCommon))
	if sourceErr != nil || targetErr != nil || sourcePath != targetPath {
		return draft, &WorktreeError{draft, errors.New("worktree belongs to a different repository")}
	}
	branch, err := r.git(ctx, target.Root, "symbolic-ref", "--short", "HEAD")
	if err != nil || strings.TrimSpace(branch) != draft.Branch {
		return draft, &WorktreeError{draft, errors.New("worktree branch does not match")}
	}
	head, err := r.git(ctx, target.Root, "rev-parse", "HEAD")
	if err != nil || strings.TrimSpace(head) != draft.BaseCommit {
		return draft, &WorktreeError{draft, errors.New("worktree base commit does not match")}
	}
	if err = verify(); err != nil {
		return draft, &WorktreeError{draft, err}
	}
	if err = verifyParent(); err != nil {
		return draft, &WorktreeError{draft, err}
	}
	if err = ctx.Err(); err != nil {
		return draft, &WorktreeError{draft, err}
	}
	status, err := r.git(ctx, target.Root, "status", "--porcelain", "--untracked-files=normal")
	if err != nil || strings.TrimSpace(status) != "" {
		return draft, &WorktreeError{draft, errors.New("new worktree is not clean")}
	}
	draft.Root = target.Root
	draft.Cwd = target.Cwd
	return draft, nil
}
