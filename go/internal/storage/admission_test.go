package storage

import (
	"context"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestAdmissionChecksEveryVolumeWithoutInterruptingExistingWork(t *testing.T) {
	state, repo := t.TempDir(), t.TempDir()
	var calls atomic.Int32
	guard := Guard{Policy: Defaults(), DataRoot: state, Probe: func(path string) (Space, error) {
		calls.Add(1)
		if path == repo {
			return Space{100 * GiB, GiB}, nil
		}
		return Space{100 * GiB, 50 * GiB}, nil
	}}
	err := guard.Check(context.Background(), []string{repo})
	if !errors.Is(err, ErrLowSpace) || calls.Load() != 2 {
		t.Fatalf("expected workspace pressure: %v calls %d", err, calls.Load())
	}
	guard.Policy.Enabled = false
	calls.Store(0)
	if err = guard.Check(context.Background(), []string{repo}); err != nil || calls.Load() != 0 {
		t.Fatalf("disabled policy: %v", err)
	}
}
func TestProbeTimeoutAndCancellationAreDistinct(t *testing.T) {
	release := make(chan struct{})
	probe := func(string) (Space, error) { <-release; return Space{100, 50}, nil }
	_, err := ProbeWithTimeout(context.Background(), filepath.Join(t.TempDir(), "slow"), 20*time.Millisecond, probe)
	if !errors.Is(err, ErrProbeTimeout) {
		t.Fatalf("timeout %v", err)
	}
	close(release)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = ProbeWithTimeout(ctx, filepath.Join(t.TempDir(), "cancelled"), time.Second, func(string) (Space, error) { time.Sleep(20 * time.Millisecond); return Space{}, nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}
func TestProbeRejectsRelativePaths(t *testing.T) {
	_, err := ProbeWithTimeout(context.Background(), "relative", time.Second, func(string) (Space, error) { t.Fatal("probe ran"); return Space{}, nil })
	if err == nil {
		t.Fatal("relative path accepted")
	}
}

func TestProbePanicDoesNotCrashAndCancelledGuardDoesNotProbe(t *testing.T) {
	path := t.TempDir()
	_, err := ProbeWithTimeout(context.Background(), path, time.Second, func(string) (Space, error) { panic("probe") })
	if err == nil {
		t.Fatal("probe panic ignored")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	guard := Guard{Policy: Defaults(), DataRoot: path, Probe: func(string) (Space, error) { t.Fatal("cancelled probe ran"); return Space{}, nil }}
	if err = guard.Check(ctx, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled guard: %v", err)
	}
}

func TestAdmissionIncludesExplicitExternalVolumes(t *testing.T) {
	state, workspace, cache := t.TempDir(), t.TempDir(), t.TempDir()
	policy := Defaults()
	policy.MonitoredPaths = []string{cache}
	visited := map[string]bool{}
	guard := Guard{Policy: policy, DataRoot: state, Probe: func(path string) (Space, error) {
		visited[path] = true
		if path == cache {
			return Space{100 * GiB, GiB}, nil
		}
		return Space{100 * GiB, 50 * GiB}, nil
	}}
	err := guard.Check(context.Background(), []string{workspace})
	if !errors.Is(err, ErrLowSpace) || !visited[state] || !visited[workspace] || !visited[cache] {
		t.Fatalf("external cache volume not checked: %#v %v", visited, err)
	}
}

func TestAdmissionBoundsTotalInspectionTime(t *testing.T) {
	root, cache := t.TempDir(), t.TempDir()
	policy := Defaults()
	policy.MonitoredPaths = []string{cache}
	guard := Guard{Policy: policy, DataRoot: root, Timeout: time.Second, TotalTimeout: 30 * time.Millisecond, Probe: func(string) (Space, error) {
		time.Sleep(100 * time.Millisecond)
		return Space{100 * GiB, 50 * GiB}, nil
	}}
	started := time.Now()
	err := guard.Check(context.Background(), nil)
	if !errors.Is(err, ErrProbeTimeout) || time.Since(started) > time.Second {
		t.Fatalf("unbounded inspection: %v", err)
	}
}
