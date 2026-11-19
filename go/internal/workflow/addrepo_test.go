//go:build darwin || linux

package workflow

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"relay.local/relay/internal/task"
)

func TestAddRepositoryInOneStepUsesWhatItDetects(t *testing.T) {
	c, db, _, _ := coordinatorFixture(t, "exit 0")
	repo := repositoryFixture(t)
	if err := os.WriteFile(filepath.Join(repo, "package.json"), []byte(`{"name":"widget-shop","packageManager":"pnpm@9.0.0","scripts":{"test":"node --test"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "pnpm-lock.yaml"), []byte("lockfileVersion: '9.0'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitFixture(t, repo, "remote", "add", "origin", "git@github.com:octo/widget-shop.git")
	result, err := c.Discover(context.Background(), "add", map[string]any{"path": repo})
	if err != nil {
		t.Fatal(err)
	}
	profile := object(object(result)["repository"])
	if _, err := exec.LookPath("gh"); err == nil {
		// Issue links work straight away for a GitHub repository.
		issue := object(profile["issueCommand"])
		if issue["command"] != "gh" || fmt.Sprint(issue["args"]) != "[issue view {ticket} --repo octo/widget-shop]" {
			t.Fatalf("issue import: %#v", issue)
		}
	}
	if profile["name"] != "widget-shop" || profile["verificationMode"] != "agent" || len(array(profile["setup"])) != 1 {
		t.Fatalf("profile: %#v", profile)
	}
	config, _ := (task.ConfigurationService{Store: db}).Read()
	saved := false
	for _, item := range array(config.Value["repositories"]) {
		if object(item)["name"] == "widget-shop" {
			saved = true
			if command := object(array(object(item)["setup"])[0]); command["command"] != "pnpm" {
				t.Fatalf("install step: %#v", command)
			}
		}
	}
	if !saved {
		t.Fatal("profile was not saved")
	}
	again, err := c.Discover(context.Background(), "add", map[string]any{"path": repo})
	if err != nil || object(again)["existing"] != true {
		t.Fatalf("adding twice made a duplicate: %#v %v", again, err)
	}
	if _, err = c.Discover(context.Background(), "add", map[string]any{"path": "relative/path"}); err == nil {
		t.Fatal("accepted a relative path")
	}
}

func TestCloneRepositoryFromAURL(t *testing.T) {
	c, db, _, _ := coordinatorFixture(t, "exit 0")
	source := repositoryFixture(t)
	bare := filepath.Join(t.TempDir(), "widgets.git")
	gitFixture(t, source, "clone", "-q", "--bare", source, bare)
	into := t.TempDir()
	// Only real remote URLs are accepted; a local path or an option is refused before git runs.
	for _, bad := range []string{bare, "--upload-pack=touch /tmp/x", "https://example.com/a b", "file:///etc"} {
		if _, err := c.Discover(context.Background(), "clone", map[string]any{"url": bad, "directory": into}); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	if entries, _ := os.ReadDir(into); len(entries) != 0 {
		t.Fatal("a refused URL created files")
	}
	// A real URL clones and adds; cloning one that is already there just adds it.
	destination := filepath.Join(into, "widgets")
	gitFixture(t, source, "clone", "-q", bare, destination)
	result, err := c.Discover(context.Background(), "clone", map[string]any{"url": "https://code.example/team/widgets.git", "directory": into})
	if err != nil {
		t.Fatal(err)
	}
	if path := text(object(object(result)["repository"])["path"]); filepath.Base(path) != "widgets" {
		t.Fatalf("cloned repository was not added: %#v", result)
	}
	config, _ := (task.ConfigurationService{Store: db}).Read()
	if len(array(config.Value["repositories"])) != 2 {
		t.Fatalf("expected the fixture and the clone: %d", len(array(config.Value["repositories"])))
	}
}
