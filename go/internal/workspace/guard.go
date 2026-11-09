package workspace

import (
	"context"
	"errors"
	"fmt"
	"reflect"
)

var ErrReadOnlyChanged = errors.New("read-only stage modified a workspace")
var ErrOtherWorkspaceChanged = errors.New("stage modified a different repository")
var ErrInspectionIncomplete = errors.New("workspace inspection was incomplete")

type GuardMode string

const (
	ReadOnly GuardMode = "read-only"
	WriteOne GuardMode = "write-one"
)

type Admission interface {
	Check(context.Context, []string) error
}
type Inspector interface {
	Snapshot(context.Context, []Workspace) (FingerprintSnapshot, error)
}
type GuardResult struct{ Before, After FingerprintSnapshot }

func nilDependency(value any) bool {
	if value == nil {
		return true
	}
	v := reflect.ValueOf(value)
	switch v.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return v.IsNil()
	}
	return false
}

func validSnapshot(snapshot FingerprintSnapshot, entries []Workspace) bool {
	if snapshot.Combined == "" || len(snapshot.Repositories) != len(entries) {
		return false
	}
	for _, entry := range entries {
		if snapshot.Repositories[entry.RepositoryID] == "" {
			return false
		}
	}
	return true
}

// GuardedRun verifies before and after an operation under the same lease. It
// detects unauthorized writes; it does not sandbox processes or authorize them.
// Cross-process workspace ownership must be provided by the future scheduler.
func GuardedRun(ctx context.Context, lease *Lease, owner string, entries []Workspace, mode GuardMode, activeID string, admission Admission, inspector Inspector, run func(context.Context) error) (GuardResult, error) {
	if nilDependency(ctx) || nilDependency(admission) || nilDependency(inspector) || run == nil || owner == "" || len(entries) == 0 {
		return GuardResult{}, errors.New("incomplete guarded run")
	}
	if mode != ReadOnly && mode != WriteOne {
		return GuardResult{}, errors.New("invalid guard mode")
	}
	ids := map[string]bool{}
	roots := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.RepositoryID == "" || entry.Root == "" || ids[entry.RepositoryID] {
			return GuardResult{}, errors.New("invalid guarded workspaces")
		}
		ids[entry.RepositoryID] = true
		roots = append(roots, entry.Root)
	}
	if mode == WriteOne && !ids[activeID] {
		return GuardResult{}, errors.New("active repository is not selected")
	}
	result := GuardResult{}
	err := lease.Protect(owner, roots, func(revalidate func() error) error {
		if err := admission.Check(ctx, roots); err != nil {
			return err
		}
		before, err := inspector.Snapshot(ctx, entries)
		if err != nil {
			return err
		}
		if !validSnapshot(before, entries) {
			return ErrInspectionIncomplete
		}
		result.Before = before
		if err = ctx.Err(); err != nil {
			return err
		}
		if err = admission.Check(ctx, roots); err != nil {
			return err
		}
		runErr := run(ctx)
		// A cancelled run is never considered successful; preserve its work and
		// require a fresh inspection before any later progression.
		if err = ctx.Err(); err != nil {
			return errors.Join(runErr, err)
		}
		after, err := inspector.Snapshot(ctx, entries)
		if err != nil {
			return errors.Join(runErr, err)
		}
		if !validSnapshot(after, entries) {
			return errors.Join(runErr, ErrInspectionIncomplete)
		}
		result.After = after
		if err = revalidate(); err != nil {
			return errors.Join(runErr, err)
		}
		if mode == ReadOnly && before.Combined != after.Combined {
			return errors.Join(runErr, ErrReadOnlyChanged)
		}
		if mode == WriteOne {
			for _, entry := range entries {
				if entry.RepositoryID != activeID && before.Repositories[entry.RepositoryID] != after.Repositories[entry.RepositoryID] {
					return errors.Join(runErr, fmt.Errorf("%w: %s", ErrOtherWorkspaceChanged, entry.RepositoryID))
				}
			}
		}
		return runErr
	})
	return result, err
}
