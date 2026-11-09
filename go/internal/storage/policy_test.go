package storage

import (
	"errors"
	"path/filepath"
	"relay.local/relay/internal/store"
	"sync"
	"testing"
)

func TestPolicyChangesAreValidatedAndRejectStaleUpdates(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	service := PolicyService{Store: db}
	initial, err := service.Read()
	if err != nil {
		t.Fatal(err)
	}
	p := initial.Policy
	p.WarningPercent = 15
	updated, err := service.Replace(initial.Revision, p)
	if err != nil || updated.Revision == initial.Revision {
		t.Fatalf("update %#v %v", updated, err)
	}
	if _, err = service.Replace(initial.Revision, p); !errors.Is(err, ErrPolicyChanged) {
		t.Fatalf("stale: %v", err)
	}
	p.CriticalPercent = 16
	if _, err = service.Replace(updated.Revision, p); err == nil {
		t.Fatal("invalid thresholds accepted")
	}
	current, err := service.Read()
	if err != nil || current.Policy.WarningPercent != 15 {
		t.Fatal("invalid policy overwrote state")
	}
}
func TestConcurrentPolicyEditsHaveOneWinner(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	service := PolicyService{Store: db}
	initial, err := service.Read()
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := service.Replace(initial.Revision, initial.Policy); results <- err }()
	}
	wg.Wait()
	close(results)
	success, stale := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrPolicyChanged) {
			stale++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || stale != 11 {
		t.Fatalf("success %d stale %d", success, stale)
	}
}
func TestCorruptPolicyIsNotSilentlyReset(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = db.SetMeta(policyKey, `{"enabled":true}`); err != nil {
		t.Fatal(err)
	}
	if _, err = (PolicyService{Store: db}).Read(); err == nil {
		t.Fatal("corrupt policy accepted")
	}
}

func TestStoredNullPolicyFieldsAreRejected(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, raw := range []string{`{"enabled":true,"warningPercent":10,"criticalPercent":3,"warningBytes":10,"criticalBytes":2,"monitoredPaths":null}`, `{"enabled":null,"warningPercent":10,"criticalPercent":3,"warningBytes":10,"criticalBytes":2}`, `{"enabled":true,"warningPercent":10,"criticalPercent":3,"warningBytes":null,"criticalBytes":0}`} {
		if err = db.SetMeta(policyKey, raw); err != nil {
			t.Fatal(err)
		}
		if _, err = (PolicyService{Store: db}).Read(); err == nil {
			t.Fatal("null field accepted")
		}
	}
}

func TestPolicyUpdateNotifiesSubscribers(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	events, unsubscribe := db.Subscribe()
	defer unsubscribe()
	service := PolicyService{Store: db}
	initial, err := service.Read()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Replace(initial.Revision, initial.Policy); err != nil {
		t.Fatal(err)
	}
	select {
	case <-events:
	default:
		t.Fatal("policy change did not notify")
	}
}
