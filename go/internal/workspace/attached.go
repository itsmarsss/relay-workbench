package workspace

import (
	"context"
	"errors"
	"strings"
)

// Attach inspects an explicitly selected checkout without resetting it. A dirty
// checkout must be handled by its owner or replaced with an isolated worktree.
func (r Runner) Attach(ctx context.Context, profile Profile, taskID, repositoryID string, admission Admission, checkpoint func(WorktreeDraft) error) (WorktreeDraft, error) {
	if !taskIDPattern.MatchString(taskID) || repositoryID == "" || admission == nil || checkpoint == nil {
		return WorktreeDraft{}, errors.New("attachment identity and admission are required")
	}
	info, err := r.Inspect(ctx, profile)
	if err != nil {
		return WorktreeDraft{}, err
	}
	if err = admission.Check(ctx, []string{info.Root}); err != nil {
		return WorktreeDraft{}, err
	}
	head, err := r.git(ctx, info.Root, "rev-parse", "HEAD")
	if err != nil {
		return WorktreeDraft{}, err
	}
	branch, err := r.git(ctx, info.Root, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return WorktreeDraft{}, errors.New("attached checkout must have a branch")
	}
	status, err := r.git(ctx, info.Root, "status", "--porcelain", "--untracked-files=all")
	if err != nil {
		return WorktreeDraft{}, err
	}
	if strings.TrimSpace(status) != "" {
		return WorktreeDraft{}, errors.New("attached checkout has local changes; preserve them and choose an isolated worktree")
	}
	draft := WorktreeDraft{TaskID: taskID, RepositoryID: repositoryID, SourceRoot: info.Root, Root: info.Root, Cwd: info.Cwd, Branch: strings.TrimSpace(branch), BaseCommit: strings.TrimSpace(head)}
	if !commitPattern.MatchString(draft.BaseCommit) {
		return WorktreeDraft{}, errors.New("invalid attached checkout HEAD")
	}
	if err = checkpoint(draft); err != nil {
		return draft, err
	}
	if err = r.VerifyAttached(ctx, profile, draft.Root, draft.Cwd, draft.Branch, draft.BaseCommit); err != nil {
		return draft, err
	}
	return draft, nil
}

func (r Runner) VerifyAttached(ctx context.Context, source Profile, root, cwd, branch, head string) error {
	info, err := r.Inspect(ctx, source)
	if err != nil {
		return err
	}
	target, err := r.Inspect(ctx, Profile{Path: root, Cwd: cwd})
	if err != nil {
		return err
	}
	if info.Root != target.Root || info.Cwd != target.Cwd || !commitPattern.MatchString(head) || branch == "" {
		return errors.New("attached checkout identity changed")
	}
	actual, err := r.git(ctx, root, "symbolic-ref", "--short", "HEAD")
	if err != nil || strings.TrimSpace(actual) != branch {
		return errors.New("attached checkout branch changed")
	}
	actual, err = r.git(ctx, root, "rev-parse", "HEAD")
	if err != nil || strings.TrimSpace(actual) != head {
		return errors.New("attached checkout HEAD changed; inspect retained work")
	}
	return ctx.Err()
}
