package store

/*
#include <sqlite3.h>
*/
import "C"
import (
	"errors"
)

type MetaEntry struct{ Key, Value string }

func (s *Store) getMeta(key string) (string, bool, error) {
	stmt, err := s.prepare("SELECT value FROM meta WHERE key=?")
	if err != nil {
		return "", false, err
	}
	defer C.sqlite3_finalize(stmt)
	if err = s.bind(stmt, 1, key); err != nil {
		return "", false, err
	}
	code := C.sqlite3_step(stmt)
	if code == C.SQLITE_DONE {
		return "", false, nil
	}
	if code != C.SQLITE_ROW {
		return "", false, s.err()
	}
	return textColumn(stmt, 0), true, nil
}
func (s *Store) setMeta(key, value string) error {
	stmt, err := s.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)")
	if err != nil {
		return err
	}
	defer C.sqlite3_finalize(stmt)
	if err = s.bind(stmt, 1, key); err != nil {
		return err
	}
	if err = s.bind(stmt, 2, value); err != nil {
		return err
	}
	if C.sqlite3_step(stmt) != C.SQLITE_DONE {
		return s.err()
	}
	return nil
}

// GetMeta returns raw text because some legacy receipts are not JSON.
func (s *Store) GetMeta(key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return "", false, err
	}
	return s.getMeta(key)
}
func (s *Store) SetMeta(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return err
	}
	return s.setMeta(key, value)
}

// UpdateMeta serializes read/modify/write. The callback must not call Store.
func (s *Store) UpdateMeta(key string, update func(string, bool) (string, error)) error {
	if update == nil {
		return errors.New("metadata updater required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return err
	}
	old, exists, err := s.getMeta(key)
	if err != nil {
		return err
	}
	next, err := update(old, exists)
	if err != nil {
		return err
	}
	return s.setMeta(key, next)
}
func (s *Store) DeleteMeta(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return err
	}
	stmt, err := s.prepare("DELETE FROM meta WHERE key=?")
	if err != nil {
		return err
	}
	defer C.sqlite3_finalize(stmt)
	if err = s.bind(stmt, 1, key); err != nil {
		return err
	}
	if C.sqlite3_step(stmt) != C.SQLITE_DONE {
		return s.err()
	}
	return nil
}
func (s *Store) ListMeta(prefix string) ([]MetaEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return nil, err
	}
	stmt, err := s.prepare(`SELECT key,value FROM meta WHERE instr(key,?)=1 ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer C.sqlite3_finalize(stmt)
	if err = s.bind(stmt, 1, prefix); err != nil {
		return nil, err
	}
	result := []MetaEntry{}
	for {
		code := C.sqlite3_step(stmt)
		if code == C.SQLITE_DONE {
			break
		}
		if code != C.SQLITE_ROW {
			return nil, s.err()
		}
		result = append(result, MetaEntry{textColumn(stmt, 0), textColumn(stmt, 1)})
	}
	return result, nil
}
