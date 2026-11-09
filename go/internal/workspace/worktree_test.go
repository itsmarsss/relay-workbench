//go:build darwin || linux

package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"relay.local/relay/internal/store"
)

const sampleTask = "550e8400-e29b-41d4-a716-446655440000"

func experimentalArea(t *testing.T) (*store.Store, *WorktreeArea) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	area, err := NewWorktreeArea(db)
	if err != nil {
		t.Fatal(err)
	}
	return db, area
}
func TestCreateWorktreePreservesSourceAndRecordsDraft(t *testing.T) {
	root := fixture(t)
	sub := filepath.Join(root, "sub")
	if err := os.Mkdir(sub, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "file.txt"), []byte("base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitFixture(t, root, "add", "sub/file.txt")
	gitFixture(t, root, "commit", "-q", "-m", "add fixture")
	if err := os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("preserve local edits\n"), 0600); err != nil {
		t.Fatal(err)
	}
	db, area := experimentalArea(t)
	r := runner(t)
	var recorded WorktreeDraft
	draft, err := r.CreateWorktree(context.Background(), area, Profile{Path: root, Cwd: "sub"}, sampleTask, "repo/one", "", func(d WorktreeDraft) error {
		recorded = d
		raw, _ := json.Marshal(d)
		return db.SetMeta("draft", string(raw))
	})
	if err != nil {
		t.Fatal(err)
	}
	if recorded.Root != draft.Root || draft.Branch != "relay/"+sampleTask || !strings.HasSuffix(draft.Cwd, "/sub") {
		t.Fatalf("draft %#v recorded %#v", draft, recorded)
	}
	if _, err = os.Stat(filepath.Join(draft.Cwd, "file.txt")); err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile(filepath.Join(root, "tracked.txt"))
	if err != nil || string(source) != "preserve local edits\n" {
		t.Fatal("source edits changed")
	}
}
func TestCreateWorktreeFailurePreservesExistingWork(t *testing.T) {
	root := fixture(t)
	_, area := experimentalArea(t)
	r := runner(t)
	first, err := r.CreateWorktree(context.Background(), area, Profile{Path: root, Cwd: "."}, sampleTask, "one", "", func(WorktreeDraft) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	var recorded WorktreeDraft
	second, err := r.CreateWorktree(context.Background(), area, Profile{Path: root, Cwd: "."}, sampleTask, "two", "", func(d WorktreeDraft) error { recorded = d; return nil })
	var partial *WorktreeError
	if !errors.As(err, &partial) || recorded.Root != second.Root || second.Root == first.Root {
		t.Fatalf("expected recoverable branch conflict: %#v %v", second, err)
	}
	if _, err = os.Stat(first.Root); err != nil {
		t.Fatal("existing worktree removed")
	}
}
func TestCreateWorktreeRequiresOwnedStateAndCheckpoint(t *testing.T) {
	root := fixture(t)
	db, area := experimentalArea(t)
	r := runner(t)
	called := false
	if _, err := r.CreateWorktree(context.Background(), area, Profile{Path: root}, "../bad", "repo", "", func(WorktreeDraft) error { called = true; return nil }); err == nil || called {
		t.Fatal("invalid task accepted")
	}
	sentinel := errors.New("checkpoint unavailable")
	draft, err := r.CreateWorktree(context.Background(), area, Profile{Path: root, Cwd: "."}, sampleTask, "repo", "", func(WorktreeDraft) error { return sentinel })
	if !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	if _, err = os.Stat(draft.Root); !os.IsNotExist(err) {
		t.Fatal("Git ran before checkpoint")
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = r.CreateWorktree(context.Background(), area, Profile{Path: root}, sampleTask, "repo", "", func(WorktreeDraft) error { return nil }); err == nil {
		t.Fatal("closed state accepted")
	}
}
func TestCreateWorktreeRejectsReplacedOwnershipBeforeGit(t *testing.T) {
	root := fixture(t)
	db, area := experimentalArea(t)
	r := runner(t)
	var recorded WorktreeDraft
	draft, err := r.CreateWorktree(context.Background(), area, Profile{Path: root, Cwd: "."}, sampleTask, "repo", "", func(d WorktreeDraft) error {
		recorded = d
		lock := filepath.Join(area.root, "server.lock")
		if err := os.Rename(lock, lock+".old"); err != nil {
			return err
		}
		return os.WriteFile(lock, []byte(strconv.Itoa(os.Getpid())), 0600)
	})
	if err == nil || draft.Root != recorded.Root {
		t.Fatal("replaced state lock accepted")
	}
	if _, err = os.Stat(draft.Root); !os.IsNotExist(err) {
		t.Fatal("Git ran after ownership loss")
	}
	if err = db.Close(); err == nil {
		t.Fatal("lost ownership not reported")
	}
}

func TestCreateSeparateWorktreesForMultipleRepositories(t *testing.T) {
	firstRoot, secondRoot := fixture(t), fixture(t)
	_, area := experimentalArea(t)
	r := runner(t)
	drafts := []WorktreeDraft{}
	for _, item := range []struct{ root, id string }{{firstRoot, "one"}, {secondRoot, "two"}} {
		draft, err := r.CreateWorktree(context.Background(), area, Profile{Path: item.root, Cwd: "."}, sampleTask, item.id, "", func(d WorktreeDraft) error { drafts = append(drafts, d); return nil })
		if err != nil {
			t.Fatal(err)
		}
		if draft.RepositoryID != item.id {
			t.Fatal("repository identity lost")
		}
	}
	if len(drafts) != 2 || drafts[0].Root == drafts[1].Root || drafts[0].SourceRoot == drafts[1].SourceRoot {
		t.Fatalf("workspaces not isolated: %#v", drafts)
	}
	for _, draft := range drafts {
		if _, err := os.Stat(filepath.Join(draft.Root, "tracked.txt")); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCreateWorktreeRejectsReplacedParentBeforeGit(t *testing.T) {
	root := fixture(t)
	_, area := experimentalArea(t)
	outside := t.TempDir()
	r := runner(t)
	var recorded WorktreeDraft
	draft, err := r.CreateWorktree(context.Background(), area, Profile{Path: root, Cwd: "."}, sampleTask, "repo", "", func(d WorktreeDraft) error {
		recorded = d
		parent := filepath.Dir(d.Root)
		if err := os.Rename(parent, parent+"-old"); err != nil {
			return err
		}
		return os.Symlink(outside, parent)
	})
	if err == nil || draft.Root != recorded.Root {
		t.Fatal("replaced worktree parent accepted")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatal("Git wrote into replacement directory")
	}
}
