//go:build darwin || linux

package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestScanCountsFilesWithoutFollowingSymlinksOrDoubleCountingHardlinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(root, "file"), filepath.Join(root, "hardlink")); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}
	if err := os.Mkdir(filepath.Join(root, "sub"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "other"), []byte("world!"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret"), make([]byte, 100000), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "external")); err != nil {
		t.Fatal(err)
	}
	result, err := Scan(context.Background(), root, 100)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Complete || result.LogicalBytes != 11 || result.Files != 3 || result.SkippedHardlinks != 1 || result.SkippedSymlinks != 1 || result.Directories != 1 {
		t.Fatalf("unexpected scan: %#v", result)
	}
	if _, err = os.Stat(filepath.Join(outside, "secret")); err != nil {
		t.Fatal("external file modified")
	}
}
func TestScanLimitsAndCancellation(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"one", "two"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	result, err := Scan(context.Background(), root, 1)
	if err != nil || result.Complete || result.Reason == "" {
		t.Fatalf("limit: %#v %v", result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = Scan(ctx, root, 100); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}
func TestScanAllowsExplicitRootAliasButNotRelativePath(t *testing.T) {
	root := t.TempDir()
	link := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Scan(context.Background(), link, 10); err != nil {
		t.Fatal(err)
	}
	if _, err := Scan(context.Background(), "relative", 10); err == nil {
		t.Fatal("relative path accepted")
	}
}

func TestScanDetectsReplacedRootIdentity(t *testing.T) {
	parent := t.TempDir()
	path := filepath.Join(parent, "root")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if !sameRoot(file, path) {
		t.Fatal("original root not recognized")
	}
	if err = os.Rename(path, path+"-old"); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if sameRoot(file, path) {
		t.Fatal("replacement accepted as original")
	}
}

func TestMeasureCountsPastTheScanLimitAndSharedFilesOnce(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(root, "file"), filepath.Join(root, "hardlink")); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "single"), []byte("world!"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := Measure(context.Background(), root, MeasureLimit)
	if err != nil || !result.Complete || result.Files != 3 || result.LogicalBytes != 11 || result.SkippedHardlinks != 1 {
		t.Fatalf("measure: %#v %v", result, err)
	}
	if _, err = Scan(context.Background(), root, MeasureLimit); err == nil {
		t.Fatal("a user scan accepted the workspace limit")
	}
	if _, err = Measure(context.Background(), root, MeasureLimit+1); err == nil {
		t.Fatal("unbounded measurement accepted")
	}
	if _, err = Measure(context.Background(), "relative", 10); err == nil {
		t.Fatal("relative path accepted")
	}
}
