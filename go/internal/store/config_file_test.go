//go:build darwin || linux

package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
)

func TestConfigurationReplacementDetectsExternalChanges(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	path := filepath.Join(dir, "config.json")
	if err = os.WriteFile(path, []byte(`{"version":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	err = s.WithConfig(func(snapshot ConfigSnapshot, replace func([]byte) error, _ func() error) error {
		if !snapshot.Exists {
			t.Fatal("missing snapshot")
		}
		if err := os.WriteFile(path, []byte(`{"version":2}`), 0600); err != nil {
			return err
		}
		return replace([]byte(`{"version":3}`))
	})
	if !errors.Is(err, ErrConfigChanged) {
		t.Fatalf("changed config: %v", err)
	}
	current, _ := os.ReadFile(path)
	if string(current) != `{"version":2}` {
		t.Fatalf("overwrote change: %s", current)
	}
}
func TestConfigurationRejectsSymlinkAndHardlink(t *testing.T) {
	for _, link := range []string{"symlink", "hardlink"} {
		t.Run(link, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "state")
			s, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			target := filepath.Join(t.TempDir(), "target")
			if err = os.WriteFile(target, []byte(`{"keep":true}`), 0600); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "config.json")
			if link == "symlink" {
				err = os.Symlink(target, path)
			} else {
				err = os.Link(target, path)
			}
			if err != nil {
				t.Skipf("link unsupported: %v", err)
			}
			err = s.WithConfig(func(ConfigSnapshot, func([]byte) error, func() error) error {
				t.Fatal("unsafe config opened")
				return nil
			})
			if err == nil {
				t.Fatal("unsafe config accepted")
			}
			data, _ := os.ReadFile(target)
			if string(data) != `{"keep":true}` {
				t.Fatal("linked target changed")
			}
		})
	}
}
func TestConfigurationUpdatesAreSerialized(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var wg sync.WaitGroup
	errorsCh := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errorsCh <- s.WithConfig(func(snapshot ConfigSnapshot, replace func([]byte) error, _ func() error) error {
				value := 0
				if snapshot.Exists {
					if err := json.Unmarshal(snapshot.Data, &value); err != nil {
						return err
					}
				}
				return replace([]byte(strconv.Itoa(value + 1)))
			})
		}()
	}
	wg.Wait()
	close(errorsCh)
	for err := range errorsCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	if err = s.WithConfig(func(snapshot ConfigSnapshot, _ func([]byte) error, _ func() error) error {
		if string(snapshot.Data) != "20" {
			t.Fatalf("lost updates: %s", snapshot.Data)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
