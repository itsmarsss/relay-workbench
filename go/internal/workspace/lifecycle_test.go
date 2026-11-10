//go:build darwin || linux

package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestAttachPreservesDirtyCheckoutAndVerifiesBranch(t *testing.T) {
	root := fixture(t)
	r := runner(t)
	path := filepath.Join(root, "tracked.txt")
	if err := os.WriteFile(path, []byte("keep\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Attach(context.Background(), Profile{Path: root}, sampleTask, "repo", allowSpace, func(WorktreeDraft) error { t.Fatal("dirty checkout checkpointed"); return nil }); err == nil {
		t.Fatal("dirty checkout attached")
	}
	got, _ := os.ReadFile(path)
	if string(got) != "keep\n" {
		t.Fatal("dirty file changed")
	}
	gitFixture(t, root, "add", "tracked.txt")
	gitFixture(t, root, "commit", "-qm", "retain")
	draft, err := r.Attach(context.Background(), Profile{Path: root}, sampleTask, "repo", allowSpace, func(WorktreeDraft) error { return nil })
	resolved, _ := filepath.EvalSymlinks(root)
	if err != nil || draft.Root != resolved {
		t.Fatalf("attach: %#v %v", draft, err)
	}
	gitFixture(t, root, "checkout", "-qb", "another")
	if err := r.VerifyAttached(context.Background(), Profile{Path: root}, draft.Root, draft.Cwd, draft.Branch, draft.BaseCommit); err == nil {
		t.Fatal("changed branch accepted")
	}
}

func TestCleanupRefusesDirtyIgnoredAndExternalWorktrees(t *testing.T) {
	source := fixture(t)
	_, area := experimentalArea(t)
	r := runner(t)
	draft, err := r.CreateWorktree(context.Background(), area, Profile{Path: source}, sampleTask, "repo", "", allowSpace, func(WorktreeDraft) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(draft.Root, "keep.txt")
	os.WriteFile(path, []byte("keep"), 0600)
	if err := r.RemoveOwnedWorktree(context.Background(), area, draft, true); err == nil {
		t.Fatal("removed untracked file")
	}
	os.Remove(path)
	os.WriteFile(filepath.Join(draft.Root, ".gitignore"), []byte("cache/\n"), 0600)
	gitFixture(t, draft.Root, "add", ".gitignore")
	gitFixture(t, draft.Root, "commit", "-qm", "ignore")
	head, err := exec.Command("git", "-C", draft.Root, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	draft.BaseCommit = strings.TrimSpace(string(head))
	os.Mkdir(filepath.Join(draft.Root, "cache"), 0700)
	os.WriteFile(filepath.Join(draft.Root, "cache", "generated"), []byte("cache"), 0600)
	if err := r.RemoveOwnedWorktree(context.Background(), area, draft, false); err == nil {
		t.Fatal("removed ignored files without permission")
	}
	forged := draft
	forged.Root = source
	if err := r.RemoveOwnedWorktree(context.Background(), area, forged, true); err == nil {
		t.Fatal("removed external checkout")
	}
	if err := r.RemoveOwnedWorktree(context.Background(), area, draft, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(draft.Root); !os.IsNotExist(err) {
		t.Fatal("worktree remains")
	}
	got, err := exec.Command("git", "-C", source, "rev-parse", "refs/heads/"+draft.Branch).Output()
	if err != nil || strings.TrimSpace(string(got)) != draft.BaseCommit {
		t.Fatal("branch lost")
	}
}
