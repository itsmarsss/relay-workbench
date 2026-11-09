//go:build !darwin && !linux

package storage

import "errors"

func Filesystem(string) (Space, error) {
	return Space{}, errors.New("disk capacity inspection is unavailable on this platform")
}
