//go:build darwin || linux

package workspace

import (
	"context"
	"fmt"
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
	if !strings.HasPrefix(preview.Text, "diff --git a/tracked.txt b/tracked.txt\n") || !strings.Contains(preview.Stat, "tracked.txt") || !strings.Contains(preview.Stat, "1 file changed") || strings.Contains(preview.Stat, "diff --git") {
		t.Fatalf("statistics and patch were not separated: stat=%q text=%q", preview.Stat, preview.Text)
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

func TestDiffPastTheOutputLimitKeepsStatisticsOnlyForFewFiles(t *testing.T) {
	root := fixture(t)
	r := runner(t)
	head, err := r.git(context.Background(), root, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	base := strings.TrimSpace(head)
	line := strings.Repeat("x", 99) + "\n"
	if err = os.WriteFile(filepath.Join(root, "tracked.txt"), []byte(strings.Repeat(line, 90000)), 0600); err != nil {
		t.Fatal(err)
	}
	preview, err := r.Diff(context.Background(), root, base)
	if err != nil {
		t.Fatal(err)
	}
	if !preview.Omitted || preview.Text != "" || !strings.Contains(preview.Stat, "tracked.txt") {
		t.Fatalf("one oversized file lost its statistics: omitted=%v stat=%q", preview.Omitted, preview.Stat)
	}
	// Far more files than a task changes: the base is stale, and statistics would take minutes.
	if err = os.Mkdir(filepath.Join(root, "many"), 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i <= maxStatFiles; i++ {
		if err = os.WriteFile(filepath.Join(root, "many", fmt.Sprintf("%d.txt", i)), []byte(line), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = r.git(context.Background(), root, "add", "--all"); err != nil {
		t.Fatal(err)
	}
	preview, err = r.Diff(context.Background(), root, base)
	if err != nil {
		t.Fatal(err)
	}
	if !preview.Omitted || preview.Text != "" || preview.Stat != "" || !strings.Contains(preview.Reason, "out of date") {
		t.Fatalf("stale base was not reported: omitted=%v stat=%d bytes reason=%q", preview.Omitted, len(preview.Stat), preview.Reason)
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
