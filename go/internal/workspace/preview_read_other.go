//go:build !darwin && !linux

package workspace

import "errors"

func readPreviewFile(string, string, int64) ([]byte, error) {
	return nil, errors.New("safe file previews are not supported on this platform")
}
