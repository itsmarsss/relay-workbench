package storage

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestScanTimeoutCancelsAndBoundsWork(t *testing.T) {
	stopped := make(chan struct{})
	scan := func(ctx context.Context, _ string, _ int) (ScanResult, error) {
		defer close(stopped)
		<-ctx.Done()
		return ScanResult{}, ctx.Err()
	}
	_, err := ScanWithTimeout(context.Background(), t.TempDir(), 100, 20*time.Millisecond, scan)
	if !errors.Is(err, ErrScanTimeout) {
		t.Fatalf("timeout: %v", err)
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("scan was not cancelled")
	}
}
func TestScanPanicAndInvalidInputsAreContained(t *testing.T) {
	_, err := ScanWithTimeout(context.Background(), t.TempDir(), 100, time.Second, func(context.Context, string, int) (ScanResult, error) { panic("scan") })
	if err == nil {
		t.Fatal("panic ignored")
	}
	_, err = ScanWithTimeout(context.Background(), "relative", 100, time.Second, nil)
	if err == nil {
		t.Fatal("relative path accepted")
	}
}

func TestConcurrentScansAreBounded(t *testing.T) {
	root := t.TempDir()
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	started := make(chan struct{}, 2)
	results := make(chan error, 2)
	scan := func(context.Context, string, int) (ScanResult, error) {
		started <- struct{}{}
		<-release
		return ScanResult{Complete: true}, nil
	}
	for i := 0; i < 2; i++ {
		go func() { _, err := ScanWithTimeout(context.Background(), root, 10, time.Second, scan); results <- err }()
	}
	<-started
	<-started
	if _, err := ScanWithTimeout(context.Background(), root, 10, time.Second, scan); !errors.Is(err, ErrScanBusy) {
		t.Fatalf("third scan: %v", err)
	}
	releaseOnce.Do(func() { close(release) })
	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
}
