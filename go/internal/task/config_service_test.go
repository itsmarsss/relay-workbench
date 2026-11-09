package task

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"relay.local/relay/internal/store"
)

func configService(t *testing.T) (ConfigurationService, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "state")
	db, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	return ConfigurationService{Store: db}, dir
}
func TestConfigurationRevisionAndDraftCreation(t *testing.T) {
	s, _ := configService(t)
	initial, err := s.Read()
	if err != nil {
		t.Fatal(err)
	}
	updated, err := s.Replace(initial.Revision, configFixture())
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision == initial.Revision {
		t.Fatal("revision did not change")
	}
	if _, err = s.Replace(initial.Revision, Defaults()); !errors.Is(err, store.ErrConfigChanged) {
		t.Fatalf("stale update: %v", err)
	}
	created, err := s.CreateTask(map[string]any{"title": "Cross repo", "repositoryId": "one", "repositoryIds": []any{"one", "two"}, "dependencies": []any{map[string]any{"repositoryId": "two", "dependsOn": "one"}}})
	if err != nil {
		t.Fatal(err)
	}
	if created["status"] != "draft" || len(created["repositories"].([]any)) != 2 {
		t.Fatalf("draft: %#v", created)
	}
}
func TestConcurrentConfigurationEditsRejectStaleRevision(t *testing.T) {
	s, _ := configService(t)
	initial, err := s.Read()
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := s.Replace(initial.Revision, Defaults()); results <- err }()
	}
	wg.Wait()
	close(results)
	success, stale := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, store.ErrConfigChanged) {
			stale++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || stale != 11 {
		t.Fatalf("success %d stale %d", success, stale)
	}
}
func TestInvalidConfigNeverOverwritesStoredFile(t *testing.T) {
	s, dir := configService(t)
	initial, err := s.Read()
	if err != nil {
		t.Fatal(err)
	}
	current, err := s.Replace(initial.Revision, Defaults())
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Replace(current.Revision, map[string]any{"concurrency": float64(0)}); err == nil {
		t.Fatal("invalid config accepted")
	}
	after, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	if string(before) != string(after) {
		t.Fatal("invalid config overwrote file")
	}
	var parsed map[string]any
	if err = json.Unmarshal(after, &parsed); err != nil {
		t.Fatal(err)
	}
}
func TestStoredProfilesRequireStableIDs(t *testing.T) {
	s, dir := configService(t)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"repositories":[{"name":"No ID","path":"/example"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(); err == nil {
		t.Fatal("unstable profile ID accepted")
	}
}
