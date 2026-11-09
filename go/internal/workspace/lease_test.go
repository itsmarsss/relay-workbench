package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestAtomicReservationsRejectAliasesAndOverlaps(t *testing.T) {
	r := NewRegistry()
	one := t.TempDir()
	two := t.TempDir()
	nested := filepath.Join(one, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(one, alias); err != nil {
		t.Fatal(err)
	}
	lease, err := r.Acquire("task-one", []string{one, two})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	for _, roots := range [][]string{{alias}, {nested}, {two}} {
		if _, err = r.Acquire("task-two", roots); !errors.Is(err, ErrWorkspaceBusy) {
			t.Fatalf("overlap %v: %v", roots, err)
		}
	}
	if _, err = r.Acquire("task-three", []string{one, alias}); err == nil {
		t.Fatal("duplicate aliases accepted")
	}
	if err = lease.WithHeld("task-one", []string{two, one}, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err = lease.WithHeld("other", []string{one, two}, func() error { return nil }); !errors.Is(err, ErrInvalidLease) {
		t.Fatal("wrong owner accepted")
	}
	lease.Release()
	next, err := r.Acquire("task-two", []string{one})
	if err != nil {
		t.Fatal(err)
	}
	next.Release()
	if err = lease.WithHeld("task-one", []string{one, two}, func() error { return nil }); !errors.Is(err, ErrInvalidLease) {
		t.Fatal("released lease accepted")
	}
}
func TestLeaseCannotReleaseDuringProtectedOperation(t *testing.T) {
	registry := NewRegistry()
	root := t.TempDir()
	lease, err := registry.Acquire("task", []string{root})
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	finish := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- lease.WithHeld("task", []string{root}, func() error { close(entered); <-finish; return nil })
	}()
	<-entered
	released := make(chan struct{})
	go func() { lease.Release(); close(released) }()
	select {
	case <-released:
		t.Fatal("lease released during protected operation")
	case <-time.After(50 * time.Millisecond):
	}
	if _, err = registry.Acquire("other", []string{root}); !errors.Is(err, ErrWorkspaceBusy) {
		t.Fatalf("concurrent acquisition: %v", err)
	}
	close(finish)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	<-released
}
func TestOnlyOneConcurrentWriterWins(t *testing.T) {
	r := NewRegistry()
	root := t.TempDir()
	var wg sync.WaitGroup
	leases := make(chan *Lease, 20)
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			lease, err := r.Acquire("task", []string{root})
			if err != nil {
				errs <- err
			} else {
				leases <- lease
			}
		}()
	}
	wg.Wait()
	close(leases)
	close(errs)
	count := 0
	for lease := range leases {
		count++
		defer lease.Release()
	}
	for err := range errs {
		if !errors.Is(err, ErrWorkspaceBusy) {
			t.Fatal(err)
		}
	}
	if count != 1 {
		t.Fatalf("%d writers won", count)
	}
}

func TestLeaseRejectsReplacedWorkspaceDirectory(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "workspace")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry()
	lease, err := registry.Acquire("task", []string{root})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if err = os.Rename(root, filepath.Join(parent, "old")); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err = lease.WithHeld("task", []string{root}, func() error { t.Fatal("operation ran on replaced directory"); return nil }); !errors.Is(err, ErrInvalidLease) {
		t.Fatalf("replaced directory: %v", err)
	}
}
