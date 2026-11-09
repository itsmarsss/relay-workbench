package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

var ErrConfigChanged = errors.New("configuration changed since it was inspected")

const maxConfigBytes = 1024 * 1024

type ConfigSnapshot struct {
	Data   []byte
	Exists bool
}

// WithConfig serializes configuration changes with task creation. The callback
// may use other Store methods but must not close the Store or re-enter WithConfig.
func (s *Store) WithConfig(fn func(ConfigSnapshot, func([]byte) error, func() error) error) error {
	if s == nil || fn == nil {
		return errors.New("configuration access required")
	}
	return s.WithOwnership(func(root string, verify func() error) error {
		s.configMu.Lock()
		defer s.configMu.Unlock()
		path := filepath.Join(root, "config.json")
		before, err := readConfigFile(path)
		if err != nil {
			return err
		}
		verifySnapshot := func() error {
			if err := verify(); err != nil {
				return err
			}
			current, err := readConfigFile(path)
			if err != nil {
				return err
			}
			if before.Exists != current.Exists || !bytes.Equal(before.Data, current.Data) {
				return ErrConfigChanged
			}
			return nil
		}
		replaced := false
		replace := func(data []byte) error {
			if replaced {
				return errors.New("configuration already replaced")
			}
			if len(data) > maxConfigBytes || !json.Valid(data) {
				return errors.New("invalid configuration JSON")
			}
			if err := verify(); err != nil {
				return err
			}
			current, err := readConfigFile(path)
			if err != nil {
				return err
			}
			if before.Exists != current.Exists || !bytes.Equal(before.Data, current.Data) {
				return ErrConfigChanged
			}
			temp, err := os.CreateTemp(root, ".config-*.tmp")
			if err != nil {
				return err
			}
			name := temp.Name()
			defer os.Remove(name)
			if err = temp.Chmod(0600); err == nil {
				_, err = temp.Write(data)
			}
			if err == nil {
				err = temp.Sync()
			}
			closeErr := temp.Close()
			if err == nil {
				err = closeErr
			}
			if err != nil {
				return err
			}
			if err = verify(); err != nil {
				return err
			}
			current, err = readConfigFile(path)
			if err != nil {
				return err
			}
			if before.Exists != current.Exists || !bytes.Equal(before.Data, current.Data) {
				return ErrConfigChanged
			}
			if err = os.Rename(name, path); err != nil {
				return err
			}
			replaced = true
			s.mu.Lock()
			s.notify()
			s.mu.Unlock()
			return nil
		}
		snapshot := ConfigSnapshot{Data: append([]byte(nil), before.Data...), Exists: before.Exists}
		return fn(snapshot, replace, verifySnapshot)
	})
}
