//go:build darwin || linux

package workspace

import (
	"errors"
	"io"
	"os"
	"syscall"
)

func readUntracked(path string) ([]byte, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("could not open file")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("untracked file must be regular")
	}
	if info.Size() > 16*1024*1024 {
		return nil, errors.New("untracked file exceeds 16 MiB")
	}
	data, err := io.ReadAll(io.LimitReader(file, 16*1024*1024+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 16*1024*1024 {
		return nil, errors.New("untracked file exceeds 16 MiB")
	}
	return data, nil
}
