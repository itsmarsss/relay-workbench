package storage

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"time"
)

var ErrProbeTimeout = errors.New("disk capacity inspection timed out")
var ErrProbeBusy = errors.New("too many disk inspections are pending")

type Probe func(string) (Space, error)
type probeResult struct {
	space Space
	err   error
}

var probeSlots = make(chan struct{}, 8)

// ProbeWithTimeout bounds waiting for slow filesystems. A stuck syscall cannot
// be cancelled, so outstanding probes are capped to avoid unbounded goroutines.
func ProbeWithTimeout(ctx context.Context, path string, timeout time.Duration, probe Probe) (Space, error) {
	if ctx == nil || probe == nil || !filepath.IsAbs(path) || timeout <= 0 {
		return Space{}, errors.New("invalid disk inspection")
	}
	if err := ctx.Err(); err != nil {
		return Space{}, err
	}
	select {
	case probeSlots <- struct{}{}:
	default:
		return Space{}, ErrProbeBusy
	}
	result := make(chan probeResult, 1)
	go func() {
		defer func() { <-probeSlots }()
		defer func() {
			if recovered := recover(); recovered != nil {
				result <- probeResult{err: fmt.Errorf("disk inspection failed: %v", recovered)}
			}
		}()
		space, err := probe(path)
		result <- probeResult{space, err}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case r := <-result:
		return r.space, r.err
	case <-ctx.Done():
		return Space{}, ctx.Err()
	case <-timer.C:
		return Space{}, ErrProbeTimeout
	}
}

// Guard checks Relay's state volume and each selected workspace volume before
// new work. Existing work is never cancelled by this check.
type Guard struct {
	Policy       Policy
	DataRoot     string
	Probe        Probe
	Timeout      time.Duration
	TotalTimeout time.Duration
}

func (g Guard) Check(ctx context.Context, workspaceRoots []string) error {
	if ctx == nil {
		return errors.New("context required")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := g.Policy.Validate(); err != nil {
		return err
	}
	if !g.Policy.Enabled {
		return nil
	}
	if !filepath.IsAbs(g.DataRoot) {
		return errors.New("Relay data root must be absolute")
	}
	probe := g.Probe
	if probe == nil {
		probe = Filesystem
	}
	timeout := g.Timeout
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	totalTimeout := g.TotalTimeout
	if totalTimeout <= 0 {
		totalTimeout = 5 * time.Second
	}
	guardCtx, cancel := context.WithTimeout(ctx, totalTimeout)
	defer cancel()
	paths := append([]string{g.DataRoot}, workspaceRoots...)
	paths = append(paths, g.Policy.MonitoredPaths...)
	seen := map[string]bool{}
	for _, path := range paths {
		if !filepath.IsAbs(path) {
			return errors.New("workspace root must be absolute")
		}
		path = filepath.Clean(path)
		if seen[path] {
			continue
		}
		seen[path] = true
		space, err := ProbeWithTimeout(guardCtx, path, timeout, probe)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
				return fmt.Errorf("inspect storage for %s: %w", path, ErrProbeTimeout)
			}
			return fmt.Errorf("inspect storage for %s: %w", path, err)
		}
		if err = Admission(g.Policy, space); err != nil {
			return fmt.Errorf("%w on the volume holding %s; free some space before starting more work", err, path)
		}
	}
	return nil
}
