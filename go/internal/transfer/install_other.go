//go:build !darwin && !linux

package transfer

import "errors"

func installDirectory(string, string) error {
	return errors.New("atomic state import is supported on macOS and Linux")
}
