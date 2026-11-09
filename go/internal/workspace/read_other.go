//go:build !darwin && !linux

package workspace

import "errors"

func readUntracked(string) ([]byte, error) {
	return nil, errors.New("safe untracked-file inspection is unavailable on this platform")
}
