//go:build !darwin && !linux

package storage

import (
	"context"
	"errors"
)

type ScanResult struct {
	AllocatedBytes   uint64 `json:"allocatedBytes,string"`
	LogicalBytes     uint64 `json:"logicalBytes,string"`
	Files            uint64 `json:"files"`
	Directories      uint64 `json:"directories"`
	SkippedSymlinks  uint64 `json:"skippedSymlinks"`
	SkippedHardlinks uint64 `json:"skippedHardlinks"`
	SkippedMounts    uint64 `json:"skippedMounts"`
	Complete         bool   `json:"complete"`
	Reason           string `json:"reason,omitempty"`
}

func Scan(context.Context, string, int) (ScanResult, error) {
	return ScanResult{}, errors.New("safe directory scanning is unavailable on this platform")
}
func Measure(context.Context, string, int) (ScanResult, error) {
	return ScanResult{}, errors.New("safe directory scanning is unavailable on this platform")
}
