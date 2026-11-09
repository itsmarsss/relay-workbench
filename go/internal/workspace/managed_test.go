//go:build darwin || linux

package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"relay.local/relay/internal/storage"
)

func TestManagedWorkspaceCreatesSeparateVerifiedCheckout(t *testing.T) {
	source := fixture(t)
	if err := os.WriteFile(filepath.Join(source, "tracked.txt"), []byte("keep local edits\n"), 0600); err != nil {
		t.Fatal(err)
	}
	_, area := experimentalArea(t)
	parent := filepath.Join(t.TempDir(), "manager with spaces")
	if err := os.Mkdir(parent, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(parent, "{workspaceName}")
	profile := ManagedProfile{Profile: Profile{Path: source, Cwd: "."}, PathTemplate: path, Command: "git", Args: []string{"worktree", "add", "-b", "{branch}", path, "{baseCommit}"}}
	var saved WorktreeDraft
	var checks [][]string
	admission := admissionFunc(func(_ context.Context, roots []string) error {
		checks = append(checks, append([]string(nil), roots...))
		return nil
	})
	draft, err := runner(t).CreateManaged(context.Background(), area, profile, sampleTask, "repo", sampleTask+"-0", "", admission, func(value WorktreeDraft) error {
		saved = value
		if _, err := os.Stat(value.Root); !os.IsNotExist(err) {
			t.Fatal("workspace exists before checkpoint")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	recordedRoot, err := filepath.EvalSymlinks(saved.Root)
	if err != nil || draft.Branch != "relay/"+sampleTask+"-0" || recordedRoot != draft.Root || draft.Root == source {
		t.Fatalf("workspace mismatch: %#v %#v", draft, saved)
	}
	if len(checks) != 2 || len(checks[1]) != 3 || checks[1][2] != parent {
		t.Fatalf("destination volume not checked: %#v", checks)
	}
	content, err := os.ReadFile(filepath.Join(source, "tracked.txt"))
	if err != nil || string(content) != "keep local edits\n" {
		t.Fatal("source edits changed")
	}
	if _, err = os.Stat(filepath.Join(draft.Root, "tracked.txt")); err != nil {
		t.Fatal(err)
	}
}

func TestManagedWorkspacePreservesPartialFailureAndRejectsExisting(t *testing.T) {
	source := fixture(t)
	_, area := experimentalArea(t)
	path := filepath.Join(t.TempDir(), "workspace-{taskId}")
	profile := ManagedProfile{Profile: Profile{Path: source}, PathTemplate: path, Command: "/bin/sh", Args: []string{"-c", `mkdir -p "$1"; printf keep > "$1/file"; exit 3`, "manager", path}}
	var saved WorktreeDraft
	draft, err := runner(t).CreateManaged(context.Background(), area, profile, sampleTask, "repo", sampleTask, "", allowSpace, func(value WorktreeDraft) error { saved = value; return nil })
	var partial *WorktreeError
	if !errors.As(err, &partial) || saved.Root != draft.Root {
		t.Fatalf("partial workspace not recorded: %#v %v", draft, err)
	}
	data, err := os.ReadFile(filepath.Join(draft.Root, "file"))
	if err != nil || string(data) != "keep" {
		t.Fatal("partial work not preserved")
	}
	called := false
	_, err = runner(t).CreateManaged(context.Background(), area, profile, sampleTask, "repo", sampleTask, "", allowSpace, func(WorktreeDraft) error { called = true; return nil })
	if err == nil || called || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("existing workspace accepted: %v", err)
	}
}

func TestManagedWorkspaceChecksDestinationSpaceBeforeCommand(t *testing.T) {
	source := fixture(t)
	_, area := experimentalArea(t)
	parent := t.TempDir()
	path := filepath.Join(parent, "managed-{taskId}")
	profile := ManagedProfile{Profile: Profile{Path: source}, PathTemplate: path, Command: "git", Args: []string{"worktree", "add", "-b", "{branch}", path, "{baseCommit}"}}
	checks := 0
	admission := admissionFunc(func(_ context.Context, roots []string) error {
		checks++
		if len(roots) == 3 && roots[2] == parent {
			return storage.ErrLowSpace
		}
		return nil
	})
	var saved WorktreeDraft
	draft, err := runner(t).CreateManaged(context.Background(), area, profile, sampleTask, "repo", sampleTask, "", admission, func(value WorktreeDraft) error { saved = value; return nil })
	if !errors.Is(err, storage.ErrLowSpace) || checks != 2 || draft.Root != saved.Root {
		t.Fatalf("missing destination capacity protection: %#v %v", draft, err)
	}
	if _, err = os.Stat(draft.Root); !os.IsNotExist(err) {
		t.Fatal("workspace created despite low destination space")
	}
}

func TestManagedWorkspaceRejectsIndependentClone(t *testing.T) {
	source := fixture(t)
	_, area := experimentalArea(t)
	path := filepath.Join(t.TempDir(), "managed-{taskId}")
	profile := ManagedProfile{Profile: Profile{Path: source}, PathTemplate: path, Command: "/bin/sh", Args: []string{"-c", `git clone -q "$1" "$2" && git -C "$2" checkout -q -b "$3"`, "manager", source, path, "{branch}"}}
	var saved WorktreeDraft
	draft, err := runner(t).CreateManaged(context.Background(), area, profile, sampleTask, "repo", sampleTask, "", allowSpace, func(value WorktreeDraft) error { saved = value; return nil })
	var partial *WorktreeError
	if !errors.As(err, &partial) || !strings.Contains(err.Error(), "different repository") || saved.Root != draft.Root {
		t.Fatalf("independent clone accepted: %#v %v", draft, err)
	}
	if _, err = os.Stat(filepath.Join(draft.Root, "tracked.txt")); err != nil {
		t.Fatal("independent checkout was deleted")
	}
}

func TestManagedWorkspaceDoesNotOverwriteRacingDestination(t *testing.T) {
	source := fixture(t)
	_, area := experimentalArea(t)
	path := filepath.Join(t.TempDir(), "managed-{taskId}")
	profile := ManagedProfile{Profile: Profile{Path: source}, PathTemplate: path, Command: "git", Args: []string{"worktree", "add", "-b", "{branch}", path, "{baseCommit}"}}
	var target string
	_, err := runner(t).CreateManaged(context.Background(), area, profile, sampleTask, "repo", sampleTask, "", allowSpace, func(value WorktreeDraft) error {
		target = value.Root
		if err := os.Mkdir(target, 0700); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(target, "keep"), []byte("existing work"), 0600)
	})
	if err == nil || !strings.Contains(err.Error(), "appeared") {
		t.Fatalf("racing workspace accepted: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(target, "keep"))
	if err != nil || string(data) != "existing work" {
		t.Fatal("existing workspace was overwritten")
	}
}

func TestManagedWorkspaceRejectsReplacedParent(t *testing.T) {
	source := fixture(t)
	_, area := experimentalArea(t)
	parent := filepath.Join(t.TempDir(), "parent")
	if err := os.Mkdir(parent, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(parent, "managed-{taskId}")
	profile := ManagedProfile{Profile: Profile{Path: source}, PathTemplate: path, Command: "git", Args: []string{"worktree", "add", "-b", "{branch}", path, "{baseCommit}"}}
	_, err := runner(t).CreateManaged(context.Background(), area, profile, sampleTask, "repo", sampleTask, "", allowSpace, func(WorktreeDraft) error {
		if err := os.Rename(parent, parent+"-old"); err != nil {
			return err
		}
		return os.Mkdir(parent, 0700)
	})
	if err == nil || !strings.Contains(err.Error(), "parent changed") {
		t.Fatalf("replaced parent accepted: %v", err)
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 0 {
		t.Fatal("manager wrote into replacement parent")
	}
}
