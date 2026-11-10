//go:build darwin || linux

package workspace

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitStateAndAncestryInspectWithoutChangingWork(t *testing.T) {
	root := fixture(t)
	runner := runner(t)
	initial, err := runner.GitState(context.Background(), root)
	if err != nil || !initial.Clean || initial.Branch == "" {
		t.Fatalf("initial state: %#v %v", initial, err)
	}
	if err := os.WriteFile(filepath.Join(root, "new"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	dirty, err := runner.GitState(context.Background(), root)
	if err != nil || dirty.Clean {
		t.Fatalf("dirty state: %#v %v", dirty, err)
	}
	gitFixture(t, root, "add", "new")
	gitFixture(t, root, "commit", "-q", "-m", "next fixture")
	next, err := runner.GitState(context.Background(), root)
	if err != nil || !next.Clean || next.Head == initial.Head {
		t.Fatalf("committed state: %#v %v", next, err)
	}
	if yes, err := runner.IsAncestor(context.Background(), root, initial.Head, next.Head); err != nil || !yes {
		t.Fatalf("ancestor: %v %v", yes, err)
	}
	if yes, err := runner.IsAncestor(context.Background(), root, next.Head, initial.Head); err != nil || yes {
		t.Fatalf("reverse ancestry: %v %v", yes, err)
	}
	if _, err := runner.IsAncestor(context.Background(), root, strings.Repeat("0", 40), next.Head); err == nil {
		t.Fatal("missing commit was treated as a normal ancestry result")
	}
}
