//go:build darwin || linux

package transfer

/*
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#if defined(__APPLE__)
static int relay_install_dir(const char *from, const char *to) {
  if (renamex_np(from, to, RENAME_EXCL) == 0) return 0;
  return errno;
}
#else
#include <fcntl.h>
#include <unistd.h>
#include <sys/syscall.h>
static int relay_install_dir(const char *from, const char *to) {
  if (syscall(SYS_renameat2, AT_FDCWD, from, AT_FDCWD, to, 1) == 0) return 0;
  return errno;
}
#endif
*/
import "C"
import (
	"syscall"
	"unsafe"
)

func installDirectory(from, to string) error {
	f, t := C.CString(from), C.CString(to)
	defer C.free(unsafe.Pointer(f))
	defer C.free(unsafe.Pointer(t))
	if code := C.relay_install_dir(f, t); code != 0 {
		return syscall.Errno(code)
	}
	return nil
}
