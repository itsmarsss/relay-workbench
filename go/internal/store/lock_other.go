//go:build !darwin && !linux

package store

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
)

// Other platforms fail closed on existing locks until safe recovery is ported.
func acquireStateLock(dir string) (os.FileInfo, string, error) {
	path := filepath.Join(dir, "server.lock")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, "", err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, "", err
	}
	owner := strconv.Itoa(os.Getpid())
	_, writeErr := f.WriteString(owner)
	closeErr := f.Close()
	if err = errors.Join(writeErr, closeErr); err != nil {
		if existing, statErr := os.Lstat(path); statErr == nil && os.SameFile(existing, info) {
			_ = os.Remove(path)
		}
		return nil, "", err
	}
	return info, owner, nil
}
