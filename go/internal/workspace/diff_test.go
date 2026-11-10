//go:build darwin || linux

package workspace

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiffShowsTrackedAndSafeUntrackedChanges(t *testing.T) {
	root := fixture(t)
	r := runner(t)
	base, err := r.git(context.Background(), root, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("changed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "new.txt"), []byte("new content\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "binary.bin"), []byte{0, 1}, 0600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err = os.WriteFile(outside, []byte("private data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	preview, err := r.Diff(context.Background(), root, strings.TrimSpace(base))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(preview.Text, "-original") || !strings.Contains(preview.Text, "+changed") {
		t.Fatalf("tracked changes missing: %s", preview.Text)
	}
	contents := map[string]string{}
	for _, file := range preview.Untracked {
		contents[file.Name] = file.Content
	}
	if contents["new.txt"] != "new content\n" || !strings.Contains(contents["binary.bin"], "Binary") || strings.Contains(contents["link"], "private data") {
		t.Fatalf("untracked previews unsafe or incomplete: %#v", contents)
	}
	if _, err = r.Diff(context.Background(), root, strings.Repeat("0", 40)); err == nil {
		t.Fatal("invalid base commit was hidden")
	}
}

func TestPreviewFileRejectsSymlinkedParentAndLargeFiles(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if _, err := readPreviewFile(root, "escape/secret", 200000); err == nil {
		t.Fatal("preview followed a symlinked parent")
	}
	if err := os.WriteFile(filepath.Join(root, "large"), make([]byte, 200001), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readPreviewFile(root, "large", 200000); err == nil {
		t.Fatal("oversized preview was accepted")
	}
}
