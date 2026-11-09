package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type sequenceInspector struct {
	snapshots []FingerprintSnapshot
	calls     int
}

func (s *sequenceInspector) Snapshot(context.Context, []Workspace) (FingerprintSnapshot, error) {
	if s.calls >= len(s.snapshots) {
		return FingerprintSnapshot{}, errors.New("unexpected inspection")
	}
	result := s.snapshots[s.calls]
	s.calls++
	return result, nil
}
func TestGuardedRunRequiresCorrectWorkspaceAndProtectsOtherRepos(t *testing.T) {
	one, two := t.TempDir(), t.TempDir()
	entries := []Workspace{{RepositoryID: "one", Root: one}, {RepositoryID: "two", Root: two}}
	lease, err := NewRegistry().Acquire("task", []string{one, two})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	before := FingerprintSnapshot{Combined: "before", Repositories: map[string]string{"one": "a", "two": "b"}}
	for _, tc := range []struct {
		name   string
		mode   GuardMode
		active string
		after  FingerprintSnapshot
		want   error
	}{{"readonly change", ReadOnly, "", FingerprintSnapshot{Combined: "after", Repositories: map[string]string{"one": "c", "two": "b"}}, ErrReadOnlyChanged}, {"other repo change", WriteOne, "one", FingerprintSnapshot{Combined: "after", Repositories: map[string]string{"one": "c", "two": "d"}}, ErrOtherWorkspaceChanged}, {"own repo change", WriteOne, "one", FingerprintSnapshot{Combined: "after", Repositories: map[string]string{"one": "c", "two": "b"}}, nil}, {"missing evidence", WriteOne, "one", FingerprintSnapshot{Combined: "after", Repositories: map[string]string{"one": "c"}}, ErrInspectionIncomplete}} {
		t.Run(tc.name, func(t *testing.T) {
			inspector := &sequenceInspector{snapshots: []FingerprintSnapshot{before, tc.after}}
			ran := false
			_, err := GuardedRun(context.Background(), lease, "task", entries, tc.mode, tc.active, inspector, func(context.Context) error { ran = true; return nil })
			if !ran || !errors.Is(err, tc.want) {
				t.Fatalf("ran %v error %v", ran, err)
			}
		})
	}
	inspector := &sequenceInspector{snapshots: []FingerprintSnapshot{before}}
	if _, err = GuardedRun(context.Background(), lease, "other", entries, ReadOnly, "", inspector, func(context.Context) error { t.Fatal("wrong owner ran"); return nil }); !errors.Is(err, ErrInvalidLease) {
		t.Fatalf("wrong owner: %v", err)
	}
}
func TestGuardedRunRejectsReplacedRootAndPreservesError(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "repo")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	entries := []Workspace{{RepositoryID: "one", Root: root}}
	lease, err := NewRegistry().Acquire("task", []string{root})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	snap := FingerprintSnapshot{Combined: "same", Repositories: map[string]string{"one": "same"}}
	inspector := &sequenceInspector{snapshots: []FingerprintSnapshot{snap, snap}}
	sentinel := errors.New("agent failed")
	_, err = GuardedRun(context.Background(), lease, "task", entries, ReadOnly, "", inspector, func(context.Context) error {
		if err := os.Rename(root, root+"-old"); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(root, 0700); err != nil {
			t.Fatal(err)
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) || !errors.Is(err, ErrInvalidLease) {
		t.Fatalf("errors not preserved: %v", err)
	}
}
