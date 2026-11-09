//go:build darwin || linux

package storage

import (
	"errors"
	"math"
	"syscall"
)

func product(a, b uint64) (uint64, error) {
	if b != 0 && a > math.MaxUint64/b {
		return 0, errors.New("filesystem capacity overflow")
	}
	return a * b, nil
}
func Filesystem(path string) (Space, error) {
	var value syscall.Statfs_t
	if err := syscall.Statfs(path, &value); err != nil {
		return Space{}, err
	}
	if value.Bsize <= 0 {
		return Space{}, errors.New("invalid filesystem block size")
	}
	size := uint64(value.Bsize)
	total, err := product(value.Blocks, size)
	if err != nil {
		return Space{}, err
	}
	available, err := product(value.Bavail, size)
	if err != nil {
		return Space{}, err
	}
	return Space{TotalBytes: total, AvailableBytes: available}, nil
}
