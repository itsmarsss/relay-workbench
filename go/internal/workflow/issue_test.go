//go:build darwin || linux

package workflow

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
)

func TestIssueImportUsesConfiguredArgvAndCurrentSettings(t *testing.T) {
	c, db, _, source := coordinatorFixture(t, "exit 0")
	program, observed := filepath.Join(t.TempDir(), "issue-provider"), filepath.Join(t.TempDir(), "argument")
	if err := os.WriteFile(program, []byte("#!/bin/sh\nprintf '%s' \"$1\" > \"$RELAY_IMPORT_ARGUMENT\"\nprintf '%s' '{\"title\":\"Issue title\",\"body\":\"Body\",\"author\":{\"login\":\"author\"},\"comments\":[{\"body\":\"Discussion\",\"user\":{\"login\":\"reviewer\"}}]}'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	c.env["RELAY_IMPORT_ARGUMENT"] = observed
	service := task.ConfigurationService{Store: db}
	config, err := service.Read()
	if err != nil {
		t.Fatal(err)
	}
	object(array(config.Value["repositories"])[0])["issueCommand"] = map[string]any{"command": program, "args": []any{"{ticket}"}}
	saved, err := service.Replace(config.Revision, config.Value)
	if err != nil {
		t.Fatal(err)
	}
	result, err := c.ImportIssue(context.Background(), "repo", saved.Revision, "123")
	if err != nil || result.Title != "Issue title" || !strings.Contains(result.Description, "Filed by: **author**") || !strings.Contains(result.Description, "Discussion") {
		t.Fatalf("issue context missing: %#v %v", result, err)
	}
	if data, err := os.ReadFile(observed); err != nil || string(data) != "123" {
		t.Fatal("ticket was not passed as one argument")
	}
	if data, err := os.ReadFile(filepath.Join(source, "file.txt")); err != nil || string(data) != "local changes\n" {
		t.Fatal("source checkout changed")
	}
	if err := os.Remove(observed); err != nil {
		t.Fatal(err)
	}
	if _, err = c.ImportIssue(context.Background(), "repo", strings.Repeat("0", 64), "123"); !errors.Is(err, store.ErrConfigChanged) {
		t.Fatalf("stale settings accepted: %v", err)
	}
	if _, err = os.Stat(observed); !os.IsNotExist(err) {
		t.Fatal("import command ran with stale settings")
	}
}

func TestIssueImportRejectsConfigurationChangedDuringFetch(t *testing.T) {
	c, db, _, _ := coordinatorFixture(t, "exit 0")
	dir := t.TempDir()
	program, marker, release := filepath.Join(dir, "provider"), filepath.Join(dir, "started"), filepath.Join(dir, "release")
	if err := os.WriteFile(program, []byte("#!/bin/sh\ntouch \"$RELAY_IMPORT_MARKER\"\nwhile [ ! -f \"$RELAY_IMPORT_RELEASE\" ]; do sleep 0.05; done\nprintf '%s' '{\"title\":\"T\",\"body\":\"B\"}'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	c.env["RELAY_IMPORT_MARKER"], c.env["RELAY_IMPORT_RELEASE"] = marker, release
	service := task.ConfigurationService{Store: db}
	config, err := service.Read()
	if err != nil {
		t.Fatal(err)
	}
	object(array(config.Value["repositories"])[0])["issueCommand"] = map[string]any{"command": program, "args": []any{"{ticket}"}}
	saved, err := service.Replace(config.Revision, config.Value)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := c.ImportIssue(ctx, "repo", saved.Revision, "123"); done <- err }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("import did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}
	newConfig := saved.Value
	newConfig["concurrency"] = float64(1)
	if _, err = service.Replace(saved.Revision, newConfig); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(release, []byte("go"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = <-done; !errors.Is(err, store.ErrConfigChanged) {
		t.Fatalf("stale import accepted: %v", err)
	}
}
