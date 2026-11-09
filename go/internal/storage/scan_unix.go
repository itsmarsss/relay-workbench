//go:build darwin || linux

package storage

/*
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>
typedef struct { unsigned long long dev, ino, blocks; long long size; int kind; } relay_file_stat;
static int relay_stat_child(int fd, const char *name, relay_file_stat *out) {
  struct stat st;
  if (fstatat(fd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) return -1;
  out->dev=(unsigned long long)st.st_dev;out->ino=(unsigned long long)st.st_ino;
  out->blocks=(unsigned long long)(st.st_blocks < 0 ? 0 : st.st_blocks);out->size=(long long)st.st_size;
  out->kind=S_ISDIR(st.st_mode)?1:S_ISREG(st.st_mode)?2:S_ISLNK(st.st_mode)?3:4;return 0;
}
static int relay_open_child_dir(int fd, const char *name) { return openat(fd,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK); }
*/
import "C"
import (
	"context"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
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
type inode struct{ dev, ino uint64 }
type scanState struct {
	ctx       context.Context
	remaining int
	rootDev   uint64
	seen      map[inode]bool
	result    ScanResult
}

func (s *scanState) partial(reason string) {
	s.result.Complete = false
	if s.result.Reason == "" {
		s.result.Reason = reason
	}
}
func (s *scanState) addAllocated(blocks uint64) bool {
	if blocks > math.MaxUint64/512 || math.MaxUint64-s.result.AllocatedBytes < blocks*512 {
		s.partial("Total size overflow")
		return false
	}
	s.result.AllocatedBytes += blocks * 512
	return true
}
func (s *scanState) walk(dir *os.File, depth int) error {
	if depth > 64 {
		s.partial("Directory depth limit reached")
		return nil
	}
	for {
		if err := s.ctx.Err(); err != nil {
			return err
		}
		entries, readErr := dir.ReadDir(256)
		for _, entry := range entries {
			if err := s.ctx.Err(); err != nil {
				return err
			}
			if s.remaining <= 0 {
				s.partial("Entry limit reached")
				return nil
			}
			s.remaining--
			name := entry.Name()
			cname := C.CString(name)
			var st C.relay_file_stat
			rc, callErr := C.relay_stat_child(C.int(dir.Fd()), cname, &st)
			if rc != 0 {
				C.free(unsafe.Pointer(cname))
				if errors.Is(callErr, syscall.ENOENT) {
					s.partial("Files changed during scan")
					continue
				}
				s.partial("Some entries could not be inspected")
				continue
			}
			identity := inode{uint64(st.dev), uint64(st.ino)}
			if identity.dev != s.rootDev {
				s.result.SkippedMounts++
				s.partial("Other mounted filesystems were skipped")
				C.free(unsafe.Pointer(cname))
				continue
			}
			switch int(st.kind) {
			case 1:
				s.result.Directories++
				s.addAllocated(uint64(st.blocks))
				fd, openErr := C.relay_open_child_dir(C.int(dir.Fd()), cname)
				C.free(unsafe.Pointer(cname))
				if fd < 0 {
					_ = openErr
					s.partial("Some directories could not be opened")
					continue
				}
				child := os.NewFile(uintptr(fd), name)
				if child == nil {
					_ = syscall.Close(int(fd))
					s.partial("Some directories could not be opened")
					continue
				}
				var actual syscall.Stat_t
				if err := syscall.Fstat(int(fd), &actual); err != nil || uint64(actual.Dev) != identity.dev || uint64(actual.Ino) != identity.ino {
					s.partial("Directories changed during scan")
					_ = child.Close()
					continue
				}
				err := s.walk(child, depth+1)
				_ = child.Close()
				if err != nil {
					return err
				}
				if s.remaining <= 0 {
					s.partial("Entry limit reached")
					return nil
				}
			case 2:
				C.free(unsafe.Pointer(cname))
				s.result.Files++
				if s.seen[identity] {
					s.result.SkippedHardlinks++
					continue
				}
				s.seen[identity] = true
				if st.size < 0 || math.MaxUint64-s.result.LogicalBytes < uint64(st.size) {
					s.partial("File size overflow")
					continue
				}
				if !s.addAllocated(uint64(st.blocks)) {
					continue
				}
				s.result.LogicalBytes += uint64(st.size)
			case 3:
				C.free(unsafe.Pointer(cname))
				s.result.SkippedSymlinks++
			default:
				C.free(unsafe.Pointer(cname))
				s.partial("Special files were skipped")
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			s.partial("Some directories could not be read")
			return nil
		}
	}
}

func sameRoot(file *os.File, path string) bool {
	original, err := file.Stat()
	if err != nil {
		return false
	}
	current, err := os.Stat(path)
	return err == nil && os.SameFile(original, current)
}

// Scan inspects a user-selected directory without following symlinks, crossing
// mounts, deleting files, or counting hard-linked file contents twice.
func Scan(ctx context.Context, path string, maxEntries int) (ScanResult, error) {
	if ctx == nil || !filepath.IsAbs(path) || maxEntries <= 0 || maxEntries > 200000 {
		return ScanResult{}, errors.New("invalid storage scan")
	}
	if err := ctx.Err(); err != nil {
		return ScanResult{}, err
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return ScanResult{}, err
	}
	fd, err := syscall.Open(canonical, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return ScanResult{}, err
	}
	root := os.NewFile(uintptr(fd), path)
	if root == nil {
		_ = syscall.Close(fd)
		return ScanResult{}, errors.New("could not open directory")
	}
	defer root.Close()
	var st syscall.Stat_t
	if err = syscall.Fstat(fd, &st); err != nil {
		return ScanResult{}, err
	}
	state := scanState{ctx: ctx, remaining: maxEntries, rootDev: uint64(st.Dev), seen: map[inode]bool{}, result: ScanResult{Complete: true}}
	if st.Blocks >= 0 {
		state.addAllocated(uint64(st.Blocks))
	} else {
		state.partial("Directory size unavailable")
	}
	if err = state.walk(root, 0); err != nil {
		return state.result, err
	}
	if !sameRoot(root, path) {
		state.partial("Directory changed during scan")
	}
	return state.result, nil
}
