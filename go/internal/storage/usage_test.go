package storage

import (
	"context"
	"errors"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestUsageMeasuresInBackgroundAndKeepsResultsUntilTheyAge(t *testing.T) {
	var mu sync.Mutex
	calls := []string{}
	sizes := map[string]uint64{"/work/a": 100, "/work/b": 20, "/work/c": 7}
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	usage := NewUsage(func(_ context.Context, path string, limit int) (ScanResult, error) {
		mu.Lock()
		defer mu.Unlock()
		calls = append(calls, path)
		if limit != MeasureLimit {
			t.Errorf("limit %d", limit)
		}
		switch path {
		case "/work/gone":
			return ScanResult{}, os.ErrNotExist
		case "/work/denied":
			return ScanResult{}, errors.New("permission denied")
		case "/work/c":
			return ScanResult{AllocatedBytes: sizes[path], Complete: false, Reason: "Entry limit reached"}, nil
		}
		return ScanResult{AllocatedBytes: sizes[path], Complete: true}, nil
	})
	usage.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return clock }
	advance := func(d time.Duration) { mu.Lock(); clock = clock.Add(d); mu.Unlock() }
	measured := func() []string { mu.Lock(); defer mu.Unlock(); out := calls; calls = []string{}; return out }
	targets := []UsageTarget{
		{ID: "one", Paths: []string{"/work/a", "/work/b/", "relative"}, Stamp: "1"},
		{ID: "partial", Paths: []string{"/work/c"}, Stamp: "1"},
		{ID: "gone", Paths: []string{"/work/gone"}, Stamp: "1"},
		{ID: "denied", Paths: []string{"/work/denied"}, Stamp: "1"},
	}
	// Nothing is known yet: the call returns at once and every directory is queued once.
	got, measuring, pending := usage.Sizes(targets)
	if len(got) != 0 || !reflect.DeepEqual(measuring, []string{"one", "partial", "gone", "denied"}) || pending != 5 {
		t.Fatalf("first %v %v %d", got, measuring, pending)
	}
	if _, _, pending = usage.Sizes(targets); pending > 5 {
		t.Fatalf("queued twice: %d", pending)
	}
	usage.idle.Wait()
	if paths := measured(); !reflect.DeepEqual(paths, []string{"/work/a", "/work/b", "/work/c", "/work/gone", "/work/denied"}) {
		t.Fatalf("measured %v", paths)
	}
	got, measuring, pending = usage.Sizes(targets)
	at := clock.Format(time.RFC3339)
	want := map[string]UsageSize{"one": {AllocatedBytes: 120, Complete: true, MeasuredAt: at}, "partial": {AllocatedBytes: 7, Complete: false, MeasuredAt: at}}
	if !reflect.DeepEqual(got, want) || len(measuring) != 0 || pending != 0 {
		t.Fatalf("known %v %v %d", got, measuring, pending)
	}
	// A changed task is measured again only once its result is ten minutes old.
	targets[0].Stamp = "2"
	advance(usageChangedAge - time.Second)
	if _, _, pending = usage.Sizes(targets); pending != 0 {
		t.Fatalf("remeasured too soon: %d", pending)
	}
	advance(time.Second)
	sizes["/work/a"] = 300
	got, measuring, pending = usage.Sizes(targets)
	if pending != 2 || got["one"].AllocatedBytes != 120 || len(measuring) != 0 {
		t.Fatalf("stale read %v %v %d", got, measuring, pending)
	}
	usage.idle.Wait()
	if paths := measured(); !reflect.DeepEqual(paths, []string{"/work/a", "/work/b"}) {
		t.Fatalf("remeasured %v", paths)
	}
	if got, _, _ = usage.Sizes(targets); got["one"].AllocatedBytes != 320 {
		t.Fatalf("updated %v", got)
	}
	// Everything is measured again after an hour, and directories of removed tasks are dropped.
	advance(usageMaxAge)
	if _, _, pending = usage.Sizes(targets[:1]); pending != 2 {
		t.Fatalf("hourly refresh queued %d", pending)
	}
	usage.idle.Wait()
	if paths := measured(); !reflect.DeepEqual(paths, []string{"/work/a", "/work/b"}) {
		t.Fatalf("hourly %v", paths)
	}
	usage.mu.Lock()
	kept := len(usage.entries)
	usage.mu.Unlock()
	if kept != 2 {
		t.Fatalf("kept %d entries", kept)
	}
}

func TestUsageSurvivesAPanickingMeasurement(t *testing.T) {
	usage := NewUsage(func(context.Context, string, int) (ScanResult, error) { panic("broken") })
	if _, measuring, pending := usage.Sizes([]UsageTarget{{ID: "one", Paths: []string{"/work/a"}}}); len(measuring) != 1 || pending != 1 {
		t.Fatal("not queued")
	}
	usage.idle.Wait()
	if got, measuring, pending := usage.Sizes([]UsageTarget{{ID: "one", Paths: []string{"/work/a"}}}); len(got) != 1 || got["one"].Complete || len(measuring) != 0 || pending != 0 {
		t.Fatalf("after panic %v %v %d", got, measuring, pending)
	}
}
