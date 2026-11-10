//go:build darwin || linux

package workspace

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

func lockWriter(root, owner string) (*os.File, error) {
	path := filepath.Join(root, "relay-writer.lock")
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CREAT|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	fail := func(err error) (*os.File, error) { file.Close(); return nil, err }
	if err = verifyWriter(file); err != nil {
		return fail(err)
	}
	if err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			err = ErrWorkspaceBusy
		}
		return fail(err)
	}
	if err = verifyWriter(file); err != nil {
		return fail(err)
	}
	data, _ := json.Marshal(map[string]any{"pid": os.Getpid(), "taskId": owner})
	if err = file.Truncate(0); err != nil {
		return fail(err)
	}
	if _, err = file.WriteAt(data, 0); err != nil {
		return fail(err)
	}
	return file, nil
}
func verifyWriter(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	path, err := os.Lstat(file.Name())
	if err != nil {
		return ErrInvalidLease
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || stat.Nlink != 1 || stat.Uid != uint32(os.Getuid()) || path.Mode()&os.ModeSymlink != 0 || !os.SameFile(info, path) {
		return ErrInvalidLease
	}
	return nil
}
