//go:build !darwin && !linux

package store

import "errors"

func readConfigFile(string) (ConfigSnapshot, error) {
	return ConfigSnapshot{}, errors.New("safe configuration file access is unavailable on this platform")
}
