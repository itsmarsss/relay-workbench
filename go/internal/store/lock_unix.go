//go:build darwin || linux

package store

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// acquireStateLock serializes stale-lock recovery across preview processes.
// The persistent guard inode is never removed: flock releases on process exit.
func acquireStateLock(dir string) (os.FileInfo, string, error) {
	guardPath := filepath.Join(dir, "server.guard")
	fd, err := syscall.Open(guardPath, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, "", err
	}
	guard := os.NewFile(uintptr(fd), guardPath)
	defer guard.Close()
	info, err := guard.Stat()
	if err != nil || !info.Mode().IsRegular() || hasMultipleLinks(info) {
		return nil, "", errors.New("invalid state recovery guard")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			return nil, "", err
		}
		if time.Now().After(deadline) {
			return nil, "", errors.New("timed out waiting for state recovery guard")
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer syscall.Flock(fd, syscall.LOCK_UN)
	if err = verifyStateGuard(guardPath, info); err != nil {
		return nil, "", err
	}
	lock := filepath.Join(dir, "server.lock")
	f, err := os.OpenFile(lock, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		if err = removeDeadStateLock(lock); err != nil {
			return nil, "", err
		}
		if err = verifyStateGuard(guardPath, info); err != nil {
			return nil, "", err
		}
		f, err = os.OpenFile(lock, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	}
	if err != nil {
		return nil, "", err
	}
	lockInfo, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, "", err
	}
	owner := strconv.Itoa(os.Getpid())
	_, writeErr := f.WriteString(owner)
	if writeErr == nil {
		writeErr = f.Sync()
	}
	closeErr := f.Close()
	err = errors.Join(writeErr, closeErr, verifyStateGuard(guardPath, info))
	if err != nil {
		if existing, statErr := os.Lstat(lock); statErr == nil && os.SameFile(existing, lockInfo) {
			_ = os.Remove(lock)
		}
		return nil, "", err
	}
	return lockInfo, owner, nil
}

func verifyStateGuard(path string, expected os.FileInfo) error {
	current, err := os.Lstat(path)
	if err != nil || !current.Mode().IsRegular() || !os.SameFile(expected, current) || hasMultipleLinks(current) {
		return errors.New("state recovery guard changed")
	}
	return nil
}

func removeDeadStateLock(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || hasMultipleLinks(info) {
		return errors.New("invalid existing state lock")
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return errors.New("state lock changed while inspecting it")
	}
	data, err := io.ReadAll(io.LimitReader(file, 65))
	if err != nil || len(data) > 64 {
		return errors.New("invalid existing state lock")
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 1 {
		return errors.New("state lock owner is invalid; inspect it before recovery")
	}
	err = syscall.Kill(pid, 0)
	if err == nil || errors.Is(err, syscall.EPERM) {
		return fmt.Errorf("Relay state is already owned by process %d", pid)
	}
	if !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("could not inspect state lock owner: %w", err)
	}
	current, err := os.Lstat(path)
	if err != nil || !current.Mode().IsRegular() || !os.SameFile(info, current) || hasMultipleLinks(current) {
		return errors.New("state lock changed during recovery")
	}
	return os.Remove(path)
}
