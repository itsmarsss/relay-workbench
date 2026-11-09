//go:build darwin || linux

package store

import (
	"errors"
	"io"
	"os"
	"syscall"
)

func readConfigFile(path string) (ConfigSnapshot, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if errors.Is(err, os.ErrNotExist) {
		return ConfigSnapshot{}, nil
	}
	if err != nil {
		return ConfigSnapshot{}, err
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return ConfigSnapshot{}, errors.New("could not open configuration")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return ConfigSnapshot{}, err
	}
	if !info.Mode().IsRegular() || hasMultipleLinks(info) {
		return ConfigSnapshot{}, errors.New("configuration must be a regular unlinked file")
	}
	if info.Size() > maxConfigBytes {
		return ConfigSnapshot{}, errors.New("configuration is too large")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxConfigBytes+1))
	if err != nil {
		return ConfigSnapshot{}, err
	}
	if len(data) > maxConfigBytes {
		return ConfigSnapshot{}, errors.New("configuration is too large")
	}
	return ConfigSnapshot{Data: data, Exists: true}, nil
}
