package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// MeasureLimit bounds one workspace measurement. A source tree with its build
// output runs to several hundred thousand entries.
const MeasureLimit = 5000000

const (
	usageChangedAge = 10 * time.Minute
	usageMaxAge     = time.Hour
	usageTimeout    = 10 * time.Minute
	usageTargets    = 2000
)

// UsageTarget names the directories one task owns. Stamp changes when the task does.
type UsageTarget struct {
	ID    string
	Paths []string
	Stamp string
}

// UsageSize is what a task's directories occupy on disk.
type UsageSize struct {
	AllocatedBytes uint64 `json:"allocatedBytes,string"`
	Complete       bool   `json:"complete"`
	MeasuredAt     string `json:"measuredAt"`
}
type usageEntry struct {
	bytes    uint64
	complete bool
	missing  bool
	stamp    string
	at       time.Time
}

// Usage measures task directories one at a time in the background and keeps
// the last result, so listing sizes never waits on a directory walk.
type Usage struct {
	// Saved, when set, receives every measurement after it changes so the results can outlive
	// the process. It is called without the lock held.
	Saved func([]UsageRecord)

	mu      sync.Mutex
	measure Scanner
	now     func() time.Time
	entries map[string]usageEntry
	queued  map[string]string
	queue   []string
	working bool
	idle    sync.WaitGroup
}

// UsageRecord is one directory's last measurement in a form that can be stored.
type UsageRecord struct {
	Path     string    `json:"path"`
	Bytes    uint64    `json:"bytes,string"`
	Complete bool      `json:"complete"`
	Missing  bool      `json:"missing,omitempty"`
	Stamp    string    `json:"stamp"`
	At       time.Time `json:"at"`
}

// Restore loads measurements kept from an earlier run. They are shown at once and measured
// again in the background when they have aged, like any other result.
func (u *Usage) Restore(records []UsageRecord) {
	u.mu.Lock()
	defer u.mu.Unlock()
	for _, record := range records {
		if !filepath.IsAbs(record.Path) || record.At.IsZero() || len(u.entries) >= usageTargets*4 {
			continue
		}
		path := filepath.Clean(record.Path)
		if _, known := u.entries[path]; !known {
			u.entries[path] = usageEntry{bytes: record.Bytes, complete: record.Complete, missing: record.Missing, stamp: record.Stamp, at: record.At}
		}
	}
}
func (u *Usage) records() []UsageRecord {
	records := make([]UsageRecord, 0, len(u.entries))
	for path, entry := range u.entries {
		records = append(records, UsageRecord{Path: path, Bytes: entry.bytes, Complete: entry.complete, Missing: entry.missing, Stamp: entry.stamp, At: entry.at})
	}
	return records
}

func NewUsage(measure Scanner) *Usage {
	if measure == nil {
		measure = Measure
	}
	return &Usage{measure: measure, now: time.Now, entries: map[string]usageEntry{}, queued: map[string]string{}}
}

// Sizes returns the known size of each target, the targets measured for the
// first time, and how many directories are queued. Unknown and outdated
// directories are queued.
func (u *Usage) Sizes(targets []UsageTarget) (map[string]UsageSize, []string, int) {
	u.mu.Lock()
	defer u.mu.Unlock()
	now := u.now()
	result := map[string]UsageSize{}
	measuring := []string{}
	wanted := map[string]bool{}
	if len(targets) > usageTargets {
		targets = targets[:usageTargets]
	}
	for _, target := range targets {
		size, known, found := UsageSize{Complete: true}, true, false
		var oldest time.Time
		for _, path := range target.Paths {
			if !filepath.IsAbs(path) {
				continue
			}
			path = filepath.Clean(path)
			wanted[path] = true
			entry, ok := u.entries[path]
			if age := now.Sub(entry.at); !ok || age >= usageMaxAge || (entry.stamp != target.Stamp && age >= usageChangedAge) {
				if _, pending := u.queued[path]; !pending {
					u.queue = append(u.queue, path)
				}
				u.queued[path] = target.Stamp
			}
			if !ok {
				known = false
				continue
			}
			if entry.missing {
				continue
			}
			found = true
			size.AllocatedBytes += entry.bytes
			size.Complete = size.Complete && entry.complete
			if oldest.IsZero() || entry.at.Before(oldest) {
				oldest = entry.at
			}
		}
		if !known {
			measuring = append(measuring, target.ID)
		} else if found {
			size.MeasuredAt = oldest.UTC().Format(time.RFC3339)
			result[target.ID] = size
		}
	}
	for path := range u.entries {
		if !wanted[path] {
			delete(u.entries, path)
		}
	}
	if len(u.queue) > 0 && !u.working {
		u.working = true
		u.idle.Add(1)
		go u.work()
	}
	return result, measuring, len(u.queued)
}

func (u *Usage) work() {
	defer u.idle.Done()
	for {
		u.mu.Lock()
		if len(u.queue) == 0 {
			u.working = false
			u.mu.Unlock()
			return
		}
		path := u.queue[0]
		u.queue = u.queue[1:]
		stamp := u.queued[path]
		u.mu.Unlock()
		entry := u.inspect(path)
		entry.stamp = stamp
		u.mu.Lock()
		entry.at = u.now()
		u.entries[path] = entry
		delete(u.queued, path)
		saved, records := u.Saved, []UsageRecord(nil)
		if saved != nil {
			records = u.records()
		}
		u.mu.Unlock()
		if saved != nil {
			saved(records)
		}
	}
}

func (u *Usage) inspect(path string) (entry usageEntry) {
	defer func() {
		if recover() != nil {
			entry = usageEntry{}
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), usageTimeout)
	defer cancel()
	result, err := u.measure(ctx, path, MeasureLimit)
	if errors.Is(err, os.ErrNotExist) || (err != nil && result.AllocatedBytes == 0) {
		return usageEntry{missing: true}
	}
	return usageEntry{bytes: result.AllocatedBytes, complete: err == nil && result.Complete}
}
