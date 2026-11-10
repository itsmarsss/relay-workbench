package store

/*
#include <sqlite3.h>
*/
import "C"
import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"
)

func TaskRevision(raw json.RawMessage) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

var ErrTaskChanged = errors.New("task changed since it was inspected")
var ErrMetadataChanged = errors.New("authorization or settings changed since inspection")

type MetaSnapshot struct {
	Value  string
	Exists bool
}

// CompareAndSwap commits a task and optional event only if the exact stored
// snapshot still matches. Callers must separately hold workspace ownership and
// establish any filesystem fingerprints before using an approval decision.
func (s *Store) CompareAndSwap(id string, expected, next, event json.RawMessage) (json.RawMessage, error) {
	return s.CompareAndSwapWithMeta(id, expected, next, event, nil)
}

// CompareAndSwapWithMeta also guards exact metadata snapshots inside the same
// transaction, so revoked delegation cannot race a committed decision.
func (s *Store) CompareAndSwapWithMeta(id string, expected, next, event json.RawMessage, guards map[string]MetaSnapshot) (json.RawMessage, error) {
	return s.CompareAndSwapMetadata(id, expected, next, event, guards, nil)
}

// CompareAndSwapMetadata commits a task, event and metadata together.
func (s *Store) CompareAndSwapMetadata(id string, expected, next, event json.RawMessage, guards map[string]MetaSnapshot, writes map[string]string) (json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(next, &fields) != nil || fields == nil {
		return nil, errors.New("invalid task")
	}
	var nextID string
	if json.Unmarshal(fields["id"], &nextID) != nil || id == "" || strings.ContainsRune(id, '\x00') || nextID != id {
		return nil, errors.New("task identity changed")
	}
	var entry map[string]json.RawMessage
	if event != nil {
		if json.Unmarshal(event, &entry) != nil || entry == nil {
			return nil, errors.New("invalid event")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return nil, err
	}
	if err := s.exec("BEGIN IMMEDIATE"); err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = s.exec("ROLLBACK")
		}
	}()
	stmt, err := s.prepare("SELECT body FROM tasks WHERE id=?")
	if err != nil {
		return nil, err
	}
	if err = s.bind(stmt, 1, id); err != nil {
		C.sqlite3_finalize(stmt)
		return nil, err
	}
	code := C.sqlite3_step(stmt)
	if code == C.SQLITE_DONE {
		C.sqlite3_finalize(stmt)
		return nil, os.ErrNotExist
	}
	if code != C.SQLITE_ROW {
		err = s.err()
		C.sqlite3_finalize(stmt)
		return nil, err
	}
	current := bytesColumn(stmt, 0)
	C.sqlite3_finalize(stmt)
	if !bytes.Equal(current, expected) {
		return nil, ErrTaskChanged
	}
	for key, expectedMeta := range guards {
		value, exists, err := s.getMeta(key)
		if err != nil {
			return nil, err
		}
		if exists != expectedMeta.Exists || (exists && value != expectedMeta.Value) {
			return nil, ErrMetadataChanged
		}
	}
	now, _ := json.Marshal(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	fields["updatedAt"] = now
	body, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	stmt, err = s.prepare("UPDATE tasks SET body=? WHERE id=?")
	if err != nil {
		return nil, err
	}
	if err = s.bind(stmt, 1, string(body)); err == nil {
		err = s.bind(stmt, 2, id)
	}
	if err == nil && C.sqlite3_step(stmt) != C.SQLITE_DONE {
		err = s.err()
	}
	C.sqlite3_finalize(stmt)
	if err != nil {
		return nil, err
	}
	if entry != nil {
		if _, exists := entry["taskId"]; !exists {
			entry["taskId"], _ = json.Marshal(id)
		}
		if _, exists := entry["at"]; !exists {
			entry["at"] = now
		}
		eventBody, marshalErr := json.Marshal(entry)
		if marshalErr != nil {
			return nil, marshalErr
		}
		stmt, err = s.prepare("INSERT INTO events(task_id,body) VALUES (?,?)")
		if err != nil {
			return nil, err
		}
		if err = s.bind(stmt, 1, id); err == nil {
			err = s.bind(stmt, 2, string(eventBody))
		}
		if err == nil && C.sqlite3_step(stmt) != C.SQLITE_DONE {
			err = s.err()
		}
		C.sqlite3_finalize(stmt)
		if err != nil {
			return nil, err
		}
	}
	for key, value := range writes {
		if err = s.setMeta(key, value); err != nil {
			return nil, err
		}
	}
	if err = s.exec("COMMIT"); err != nil {
		return nil, err
	}
	committed = true
	s.notify()
	return body, nil
}
