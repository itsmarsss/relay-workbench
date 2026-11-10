package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"relay.local/relay/internal/storage"
	"testing"
)

type admissionFunc func(context.Context, []string) error

func (f admissionFunc) Check(ctx context.Context, roots []string) error { return f(ctx, roots) }

var allowSpace = admissionFunc(func(context.Context, []string) error { return nil })

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
			_, err := GuardedRun(context.Background(), lease, "task", entries, tc.mode, tc.active, allowSpace, inspector, func(context.Context) error { ran = true; return nil })
			if !ran || !errors.Is(err, tc.want) {
				t.Fatalf("ran %v error %v", ran, err)
			}
		})
	}
	inspector := &sequenceInspector{snapshots: []FingerprintSnapshot{before}}
	if _, err = GuardedRun(context.Background(), lease, "other", entries, ReadOnly, "", allowSpace, inspector, func(context.Context) error { t.Fatal("wrong owner ran"); return nil }); !errors.Is(err, ErrInvalidLease) {
		t.Fatalf("wrong owner: %v", err)
	}
}
func TestGuardedRunDoesNotStartWhenReviewedFingerprintChanged(t *testing.T) {
	root := t.TempDir()
	entries := []Workspace{{RepositoryID: "one", Root: root}}
	lease, err := NewRegistry().Acquire("task", []string{root})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	inspector := &sequenceInspector{snapshots: []FingerprintSnapshot{{Combined: "new", Repositories: map[string]string{"one": "new"}}}}
	ran := false
	result, err := GuardedRunExpected(context.Background(), lease, "task", entries, WriteOne, "one", allowSpace, inspector, "reviewed", func(context.Context) error { ran = true; return nil })
	if !errors.Is(err, ErrFingerprintChanged) || ran || result.Before.Combined != "new" {
		t.Fatalf("stale workspace started work: ran %v result %#v err %v", ran, result, err)
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
	_, err = GuardedRun(context.Background(), lease, "task", entries, ReadOnly, "", allowSpace, inspector, func(context.Context) error {
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

func TestGuardedRunStopsBeforeWorkWhenStorageIsCritical(t *testing.T) {
	root := t.TempDir()
	entries := []Workspace{{RepositoryID: "one", Root: root}}
	lease, err := NewRegistry().Acquire("task", []string{root})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	inspector := &sequenceInspector{}
	admission := admissionFunc(func(context.Context, []string) error { return storage.ErrLowSpace })
	ran := false
	_, err = GuardedRun(context.Background(), lease, "task", entries, WriteOne, "one", admission, inspector, func(context.Context) error { ran = true; return nil })
	if !errors.Is(err, storage.ErrLowSpace) || ran || inspector.calls != 0 {
		t.Fatalf("low disk should stop before work: ran %v scans %d error %v", ran, inspector.calls, err)
	}
}
func TestGuardedRunRechecksSpaceAfterInspection(t *testing.T) {
	root := t.TempDir()
	entries := []Workspace{{RepositoryID: "one", Root: root}}
	lease, err := NewRegistry().Acquire("task", []string{root})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	snap := FingerprintSnapshot{Combined: "same", Repositories: map[string]string{"one": "same"}}
	inspector := &sequenceInspector{snapshots: []FingerprintSnapshot{snap}}
	checks := 0
	admission := admissionFunc(func(context.Context, []string) error {
		checks++
		if checks == 2 {
			return storage.ErrLowSpace
		}
		return nil
	})
	ran := false
	_, err = GuardedRun(context.Background(), lease, "task", entries, WriteOne, "one", admission, inspector, func(context.Context) error { ran = true; return nil })
	if !errors.Is(err, storage.ErrLowSpace) || ran || checks != 2 {
		t.Fatalf("changed space should stop before work: ran %v checks %d error %v", ran, checks, err)
	}
}

type nilAdmission struct{}

func (*nilAdmission) Check(context.Context, []string) error { panic("nil admission used") }
func TestGuardedRunRejectsTypedNilAdmission(t *testing.T) {
	root := t.TempDir()
	lease, err := NewRegistry().Acquire("task", []string{root})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	var admission *nilAdmission
	inspector := &sequenceInspector{}
	if _, err = GuardedRun(context.Background(), lease, "task", []Workspace{{RepositoryID: "one", Root: root}}, ReadOnly, "", admission, inspector, func(context.Context) error { return nil }); err == nil {
		t.Fatal("typed nil admission accepted")
	}
}
