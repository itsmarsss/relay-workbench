//go:build !darwin && !linux

package workspace

import (
	"errors"
	"os"
)

func lockWriter(string, string) (*os.File, error) {
	return nil, errors.New("repository writer locks are unsupported on this platform")
}
func verifyWriter(*os.File) error { return ErrInvalidLease }
