//go:build !aix && !darwin && !dragonfly && !freebsd && !linux && !netbsd && !openbsd && !solaris

package store

import "os"

// Fail closed until this platform has a reliable hard-link check.
func hasMultipleLinks(os.FileInfo) bool { return true }
