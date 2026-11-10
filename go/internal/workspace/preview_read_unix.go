//go:build darwin || linux

package workspace

/*
#include <fcntl.h>
#include <stdlib.h>
static int relay_preview_open_dir(int fd, const char *name) { return openat(fd, name, O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK); }
static int relay_preview_open_file(int fd, const char *name) { return openat(fd, name, O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK); }
*/
import "C"

import (
	"errors"
	"io"
	"os"
	"strings"
	"syscall"
	"unsafe"
)

// Resolve each component relative to an open directory, without following
// symlinks, so a preview cannot escape if an agent changes a parent directory.
func readPreviewFile(root, name string, max int64) ([]byte, error) {
	data, _, err := readBoundedFile(root, name, max)
	return data, err
}

func readBoundedFile(root, name string, max int64) ([]byte, os.FileMode, error) {
	return readFile(root, name, max, false)
}
func readOwnedFile(root, name string, max int64) ([]byte, error) {
	data, _, err := readFile(root, name, max, true)
	return data, err
}
func readFile(root, name string, max int64, private bool) ([]byte, os.FileMode, error) {
	fd, err := syscall.Open(root, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, 0, err
	}
	current := os.NewFile(uintptr(fd), root)
	defer func() { _ = current.Close() }()
	parts := strings.Split(name, "/")
	for index, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, 0, errors.New("invalid preview path")
		}
		value := C.CString(part)
		var next C.int
		if index == len(parts)-1 {
			next, err = C.relay_preview_open_file(C.int(current.Fd()), value)
		} else {
			next, err = C.relay_preview_open_dir(C.int(current.Fd()), value)
		}
		C.free(unsafe.Pointer(value))
		if next < 0 {
			return nil, 0, err
		}
		file := os.NewFile(uintptr(next), part)
		if file == nil {
			_ = syscall.Close(int(next))
			return nil, 0, errors.New("could not open preview file")
		}
		_ = current.Close()
		current = file
	}
	info, err := current.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > max {
		return nil, 0, errors.New("file is not a small regular file")
	}
	if private {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Nlink != 1 || stat.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0077 != 0 {
			return nil, 0, errors.New("private file ownership changed")
		}
	}
	data, err := io.ReadAll(io.LimitReader(current, max+1))
	if err != nil || int64(len(data)) > max {
		return nil, 0, errors.New("file exceeds preview limit")
	}
	return data, info.Mode(), nil
}
