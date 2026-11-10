package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// CheckRemovable accepts only the exact ordinary worktree path derived by this
// state owner. External managed workspaces and attached checkouts are excluded.
func (r Runner) CheckRemovable(ctx context.Context, area *WorktreeArea, draft WorktreeDraft, includeIgnored bool) error {
	if area == nil || area.state == nil || !taskIDPattern.MatchString(draft.TaskID) || draft.RepositoryID == "" {
		return errors.New("owned worktree identity is required")
	}
	return area.state.WithOwnership(func(root string, verify func() error) error {
		sum := sha256.Sum256([]byte(draft.RepositoryID))
		expected := filepath.Join(root, "worktrees", draft.TaskID+"-"+hex.EncodeToString(sum[:]))
		if root != area.root || filepath.Clean(draft.Root) != expected {
			return errors.New("cleanup only supports this instance's ordinary worktrees")
		}
		info, err := os.Lstat(expected)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("owned worktree identity changed")
		}
		if err = r.VerifyExisting(ctx, Profile{Path: draft.SourceRoot}, draft.Root, draft.Cwd, draft.Branch, draft.BaseCommit); err != nil {
			return err
		}
		status, err := r.git(ctx, draft.Root, "status", "--porcelain", "--untracked-files=all")
		if err != nil {
			return err
		}
		if strings.TrimSpace(status) != "" {
			return errors.New("worktree has local changes; commit or preserve them before cleanup")
		}
		if !includeIgnored {
			ignored, err := r.git(ctx, draft.Root, "ls-files", "--others", "--ignored", "--exclude-standard", "-z")
			if err != nil {
				return err
			}
			if ignored != "" {
				return errors.New("worktree contains ignored files; explicitly include them or preserve them first")
			}
		}
		return verify()
	})
}

func (r Runner) RemoveOwnedWorktree(ctx context.Context, area *WorktreeArea, draft WorktreeDraft, includeIgnored bool) error {
	if err := r.CheckRemovable(ctx, area, draft, includeIgnored); err != nil {
		return err
	}
	// No force, branch deletion, repository pruning or external cache deletion.
	_, err := r.git(ctx, draft.SourceRoot, "worktree", "remove", "--", draft.Root)
	return err
}
