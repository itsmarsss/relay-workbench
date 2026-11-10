//go:build !darwin && !linux

package workspace

import (
	"errors"
	"os"
)

func readPreviewFile(string, string, int64) ([]byte, error) {
	return nil, errors.New("safe file previews are not supported on this platform")
}
func readBoundedFile(string, string, int64) ([]byte, os.FileMode, error) {
	return nil, 0, errors.New("safe file inspection is not supported on this platform")
}
func readOwnedFile(string, string, int64) ([]byte, error) {
	return nil, errors.New("safe private file inspection is not supported on this platform")
}
