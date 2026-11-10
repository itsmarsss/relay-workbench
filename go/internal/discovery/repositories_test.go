package discovery

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestDiscoverySkipsLinksDependenciesAndBoundsRoots(t *testing.T) {
	root := t.TempDir()
	for _, p := range []string{"project/.git", "node_modules/dependency/.git", "deep/a/b/c/d/repo/.git"} {
		if err := os.MkdirAll(filepath.Join(root, p), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(root, "project"), filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	rows, err := Repositories(context.Background(), []string{root, root})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Name != "project" {
		t.Fatalf("unexpected scan: %#v", rows)
	}
	if _, err = Repositories(context.Background(), []string{"relative"}); err == nil {
		t.Fatal("relative root accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = Repositories(ctx, []string{root}); err == nil {
		t.Fatal("cancelled scan succeeded")
	}
}
