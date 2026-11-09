package storage

import (
	"context"
	"errors"
	"path/filepath"
	"time"
)

var ErrScanTimeout = errors.New("storage scan timed out")
var ErrScanBusy = errors.New("too many storage scans are pending")

type Scanner func(context.Context, string, int) (ScanResult, error)
type scanResponse struct {
	result ScanResult
	err    error
}

var scanSlots = make(chan struct{}, 2)

// ScanWithTimeout limits waiting and concurrent scans, including filesystems
// whose blocking operations cannot be interrupted immediately.
func ScanWithTimeout(ctx context.Context, path string, maxEntries int, timeout time.Duration, scan Scanner) (ScanResult, error) {
	if ctx == nil || !filepath.IsAbs(path) || maxEntries <= 0 || maxEntries > 200000 || timeout <= 0 {
		return ScanResult{}, errors.New("invalid storage scan")
	}
	if err := ctx.Err(); err != nil {
		return ScanResult{}, err
	}
	if scan == nil {
		scan = Scan
	}
	select {
	case scanSlots <- struct{}{}:
	default:
		return ScanResult{}, ErrScanBusy
	}
	scanCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	result := make(chan scanResponse, 1)
	go func() {
		defer func() { <-scanSlots }()
		defer func() {
			if recovered := recover(); recovered != nil {
				result <- scanResponse{err: errors.New("storage scan failed")}
			}
		}()
		value, err := scan(scanCtx, path, maxEntries)
		result <- scanResponse{value, err}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case value := <-result:
		return value.result, value.err
	case <-ctx.Done():
		return ScanResult{}, ctx.Err()
	case <-timer.C:
		return ScanResult{}, ErrScanTimeout
	}
}
