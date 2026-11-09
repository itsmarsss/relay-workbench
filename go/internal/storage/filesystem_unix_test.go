//go:build darwin || linux

package storage

import (
	"math"
	"testing"
)

func TestFilesystemProbeAndOverflow(t *testing.T) {
	space, err := Filesystem(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if space.TotalBytes == 0 || space.AvailableBytes > space.TotalBytes {
		t.Fatalf("invalid space: %#v", space)
	}
	if _, err = product(math.MaxUint64, 2); err == nil {
		t.Fatal("capacity overflow accepted")
	}
}
