// Package store owns an isolated Relay database using the legacy schema.
package store

/*
#cgo pkg-config: sqlite3
#include <sqlite3.h>
#include <stdlib.h>
static int relay_bind_text(sqlite3_stmt *stmt, int idx, const char *value, int len) {
  return sqlite3_bind_text(stmt, idx, value, len, SQLITE_TRANSIENT);
}
*/
import "C"

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"
)

const markerName = ".relay-go-experimental"
const markerContent = "relay experimental go state v1\n"

// Store serializes database access and owns the same lock name as the legacy
// process. The marker prevents accidentally opening a real Relay state dir.
type Store struct {
	configMu                                        sync.Mutex
	lifecycle                                       sync.RWMutex
	mu                                              sync.Mutex
	db                                              *C.sqlite3
	lock                                            string
	lockOwner                                       string
	lockIdentity, directoryIdentity, markerIdentity os.FileInfo
	listeners                                       map[chan struct{}]struct{}
}

func Open(dir string) (*Store, error) {
	if dir == "" {
		return nil, errors.New("an explicit isolated state directory is required")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("state directory must be a real directory")
	}
	marker := filepath.Join(dir, markerName)
	markerInfo, err := os.Lstat(marker)
	if errors.Is(err, os.ErrNotExist) {
		entries, listErr := os.ReadDir(dir)
		if listErr != nil {
			return nil, listErr
		}
		if len(entries) != 0 {
			return nil, errors.New("refusing to initialize a nonempty state directory")
		}
		f, createErr := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if createErr != nil {
			return nil, createErr
		}
		if _, err = f.WriteString(markerContent); err != nil {
			_ = f.Close()
			return nil, err
		}
		if err = f.Close(); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	} else if !markerInfo.Mode().IsRegular() {
		return nil, errors.New("invalid state marker")
	}
	b, err := os.ReadFile(marker)
	if err != nil || string(b) != markerContent {
		return nil, errors.New("invalid experimental state marker")
	}
	markerInfo, err = os.Lstat(marker)
	if err != nil || !markerInfo.Mode().IsRegular() {
		return nil, errors.New("invalid state marker")
	}
	lock := filepath.Join(dir, "server.lock")
	f, err := os.OpenFile(lock, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, fmt.Errorf("state is already locked or unavailable: %w", err)
	}
	lockIdentity, err := f.Stat()
	if err != nil {
		_ = f.Close()
		_ = os.Remove(lock)
		return nil, err
	}
	owner := strconv.Itoa(os.Getpid())
	if _, err = f.WriteString(owner); err != nil {
		_ = f.Close()
		_ = os.Remove(lock)
		return nil, err
	}
	if err = f.Close(); err != nil {
		_ = os.Remove(lock)
		return nil, err
	}
	s := &Store{lock: lock, lockOwner: owner, lockIdentity: lockIdentity, directoryIdentity: info, markerIdentity: markerInfo, listeners: make(map[chan struct{}]struct{})}
	if err = os.Chmod(dir, 0700); err != nil {
		_ = s.Close()
		return nil, err
	}
	for _, name := range []string{"relay.sqlite", "relay.sqlite-wal", "relay.sqlite-shm", "relay.sqlite-journal"} {
		entry, statErr := os.Lstat(filepath.Join(dir, name))
		if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
			_ = s.Close()
			return nil, statErr
		}
		if statErr == nil && !entry.Mode().IsRegular() {
			_ = s.Close()
			return nil, errors.New("database files must be regular files")
		}
		if statErr == nil && hasMultipleLinks(entry) {
			_ = s.Close()
			return nil, errors.New("database files must not be hard-linked")
		}
	}
	path := C.CString(filepath.Join(dir, "relay.sqlite"))
	defer C.free(unsafe.Pointer(path))
	if C.sqlite3_open_v2(path, &s.db, C.SQLITE_OPEN_READWRITE|C.SQLITE_OPEN_CREATE|C.SQLITE_OPEN_FULLMUTEX, nil) != C.SQLITE_OK {
		err = s.err()
		_ = s.Close()
		return nil, err
	}
	if err = s.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`); err != nil {
		_ = s.Close()
		return nil, err
	}
	if err = os.Chmod(filepath.Join(dir, "relay.sqlite"), 0600); err != nil {
		_ = s.Close()
		return nil, err
	}
	if _, err = s.verifyOwnership(); err != nil {
		_ = s.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) err() error {
	if s.db == nil {
		return errors.New("database unavailable")
	}
	return errors.New(C.GoString(C.sqlite3_errmsg(s.db)))
}
func (s *Store) exec(query string) error {
	q := C.CString(query)
	defer C.free(unsafe.Pointer(q))
	if C.sqlite3_exec(s.db, q, nil, nil, nil) != C.SQLITE_OK {
		return s.err()
	}
	return nil
}
func (s *Store) prepare(query string) (*C.sqlite3_stmt, error) {
	q := C.CString(query)
	defer C.free(unsafe.Pointer(q))
	var stmt *C.sqlite3_stmt
	if C.sqlite3_prepare_v2(s.db, q, -1, &stmt, nil) != C.SQLITE_OK {
		return nil, s.err()
	}
	return stmt, nil
}
func (s *Store) bind(stmt *C.sqlite3_stmt, index int, value string) error {
	p := C.CString(value)
	defer C.free(unsafe.Pointer(p))
	if C.relay_bind_text(stmt, C.int(index), p, C.int(len(value))) != C.SQLITE_OK {
		return s.err()
	}
	return nil
}
func textColumn(stmt *C.sqlite3_stmt, index int) string {
	ptr := C.sqlite3_column_text(stmt, C.int(index))
	size := C.sqlite3_column_bytes(stmt, C.int(index))
	if ptr == nil {
		return ""
	}
	return C.GoStringN((*C.char)(unsafe.Pointer(ptr)), size)
}
func bytesColumn(stmt *C.sqlite3_stmt, index int) []byte {
	ptr := C.sqlite3_column_blob(stmt, C.int(index))
	size := C.sqlite3_column_bytes(stmt, C.int(index))
	if ptr == nil {
		return nil
	}
	return C.GoBytes(ptr, size)
}
func (s *Store) ready() error {
	if s.db == nil {
		return errors.New("store is closed")
	}
	return nil
}

type Task = json.RawMessage

// Visit reads one task at a time while holding the database lock. The callback
// must not call back into Store or perform slow I/O.
func (s *Store) Visit(visit func(Task) error) error {
	if visit == nil {
		return errors.New("visitor required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return err
	}
	stmt, err := s.prepare("SELECT body FROM tasks ORDER BY rowid DESC")
	if err != nil {
		return err
	}
	defer C.sqlite3_finalize(stmt)
	for {
		code := C.sqlite3_step(stmt)
		if code == C.SQLITE_DONE {
			return nil
		}
		if code != C.SQLITE_ROW {
			return s.err()
		}
		body := bytesColumn(stmt, 0)
		if !json.Valid(body) {
			return errors.New("invalid stored task JSON")
		}
		if err := visit(json.RawMessage(body)); err != nil {
			return err
		}
	}
}
func (s *Store) All() ([]Task, error) {
	result := []Task{}
	err := s.Visit(func(task Task) error { result = append(result, task); return nil })
	if err != nil {
		return nil, err
	}
	return result, nil
}
func (s *Store) Get(id string) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return nil, err
	}
	stmt, err := s.prepare("SELECT body FROM tasks WHERE id=?")
	if err != nil {
		return nil, err
	}
	defer C.sqlite3_finalize(stmt)
	if err = s.bind(stmt, 1, id); err != nil {
		return nil, err
	}
	code := C.sqlite3_step(stmt)
	if code == C.SQLITE_DONE {
		return nil, os.ErrNotExist
	}
	if code != C.SQLITE_ROW {
		return nil, s.err()
	}
	body := textColumn(stmt, 0)
	if !json.Valid([]byte(body)) {
		return nil, errors.New("invalid stored task JSON")
	}
	return json.RawMessage(body), nil
}
func (s *Store) Events(id string, after int64, limit int) ([]json.RawMessage, error) {
	if after < 0 || limit < 1 || limit > 1000 {
		return nil, errors.New("invalid event cursor or limit")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return nil, err
	}
	stmt, err := s.prepare("SELECT seq,body FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?")
	if err != nil {
		return nil, err
	}
	defer C.sqlite3_finalize(stmt)
	if err = s.bind(stmt, 1, id); err != nil {
		return nil, err
	}
	if C.sqlite3_bind_int64(stmt, 2, C.sqlite3_int64(after)) != C.SQLITE_OK || C.sqlite3_bind_int(stmt, 3, C.int(limit)) != C.SQLITE_OK {
		return nil, s.err()
	}
	events := []json.RawMessage{}
	for {
		code := C.sqlite3_step(stmt)
		if code == C.SQLITE_DONE {
			break
		}
		if code != C.SQLITE_ROW {
			return nil, s.err()
		}
		var entry map[string]json.RawMessage
		if err = json.Unmarshal([]byte(textColumn(stmt, 1)), &entry); err != nil || entry == nil {
			return nil, errors.New("invalid stored event JSON")
		}
		entry["seq"] = json.RawMessage(strconv.FormatInt(int64(C.sqlite3_column_int64(stmt, 0)), 10))
		b, err := json.Marshal(entry)
		if err != nil {
			return nil, err
		}
		events = append(events, b)
	}
	return events, nil
}

var ErrTaskExists = errors.New("task already exists")

// Save updates or inserts a task in the isolated migration store.
func (s *Store) Save(task json.RawMessage, event json.RawMessage) error {
	_, err := s.save(task, event, false)
	return err
}

// InsertTask never overwrites an existing task, even on an ID collision.
func (s *Store) InsertTask(task json.RawMessage, event json.RawMessage) (json.RawMessage, error) {
	return s.save(task, event, true)
}
func (s *Store) save(task json.RawMessage, event json.RawMessage, createOnly bool) (json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(task, &fields) != nil || fields == nil {
		return nil, errors.New("invalid task")
	}
	var id string
	if json.Unmarshal(fields["id"], &id) != nil || id == "" || strings.ContainsRune(id, '\x00') {
		return nil, errors.New("invalid task")
	}
	now, _ := json.Marshal(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	fields["updatedAt"] = now
	var err error
	task, err = json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	if event != nil {
		var object map[string]json.RawMessage
		if json.Unmarshal(event, &object) != nil || object == nil {
			return nil, errors.New("invalid event")
		}
		if _, ok := object["taskId"]; !ok {
			object["taskId"], _ = json.Marshal(id)
		}
		if _, ok := object["at"]; !ok {
			object["at"] = now
		}
		event, err = json.Marshal(object)
		if err != nil {
			return nil, err
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
	query := "INSERT INTO tasks(id,body) VALUES (?,?)"
	if !createOnly {
		query += " ON CONFLICT(id) DO UPDATE SET body=excluded.body"
	}
	stmt, err := s.prepare(query)
	if err != nil {
		return nil, err
	}
	if err = s.bind(stmt, 1, id); err == nil {
		err = s.bind(stmt, 2, string(task))
	}
	if err == nil && C.sqlite3_step(stmt) != C.SQLITE_DONE {
		if createOnly && (C.sqlite3_extended_errcode(s.db) == C.SQLITE_CONSTRAINT_PRIMARYKEY || C.sqlite3_extended_errcode(s.db) == C.SQLITE_CONSTRAINT_UNIQUE) {
			err = ErrTaskExists
		} else {
			err = s.err()
		}
	}
	C.sqlite3_finalize(stmt)
	if err != nil {
		return nil, err
	}
	if event != nil {
		stmt, err = s.prepare("INSERT INTO events(task_id,body) VALUES (?,?)")
		if err != nil {
			return nil, err
		}
		if err = s.bind(stmt, 1, id); err == nil {
			err = s.bind(stmt, 2, string(event))
		}
		if err == nil && C.sqlite3_step(stmt) != C.SQLITE_DONE {
			err = s.err()
		}
		C.sqlite3_finalize(stmt)
		if err != nil {
			return nil, err
		}
	}
	if err = s.exec("COMMIT"); err != nil {
		return nil, err
	}
	committed = true
	for ch := range s.listeners {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
	return task, nil
}
func (s *Store) Subscribe() (<-chan struct{}, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := make(chan struct{}, 1)
	if s.db != nil {
		s.listeners[ch] = struct{}{}
	} else {
		close(ch)
	}
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if _, ok := s.listeners[ch]; ok {
				delete(s.listeners, ch)
				close(ch)
			}
		})
	}
}

// verifyOwnership requires s.mu when the store is shared.
func (s *Store) verifyOwnership() (string, error) {
	if err := s.ready(); err != nil {
		return "", err
	}
	if s.lock == "" || s.lockIdentity == nil || s.directoryIdentity == nil || s.markerIdentity == nil {
		return "", errors.New("state ownership unavailable")
	}
	dir := filepath.Dir(s.lock)
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || !os.SameFile(info, s.directoryIdentity) {
		return "", errors.New("state directory changed")
	}
	marker := filepath.Join(dir, markerName)
	markerInfo, markerErr := os.Lstat(marker)
	if markerErr != nil || !markerInfo.Mode().IsRegular() || !os.SameFile(markerInfo, s.markerIdentity) {
		return "", errors.New("state marker changed")
	}
	markerBytes, markerErr := os.ReadFile(marker)
	if markerErr != nil || string(markerBytes) != markerContent {
		return "", errors.New("state marker changed")
	}
	lock, err := os.Lstat(s.lock)
	if err != nil || !lock.Mode().IsRegular() || !os.SameFile(lock, s.lockIdentity) {
		return "", errors.New("state ownership lock changed")
	}
	contents, err := os.ReadFile(s.lock)
	if err != nil || string(contents) != s.lockOwner {
		return "", errors.New("state ownership lock changed")
	}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	return filepath.Abs(root)
}

// WithOwnership holds the store open while fn runs. fn may use Store methods,
// but must not close the Store. Revalidate after long operations before writes.
func (s *Store) WithOwnership(fn func(string, func() error) error) error {
	if s == nil || fn == nil {
		return errors.New("state ownership required")
	}
	s.lifecycle.RLock()
	defer s.lifecycle.RUnlock()
	verify := func() error { s.mu.Lock(); defer s.mu.Unlock(); _, err := s.verifyOwnership(); return err }
	s.mu.Lock()
	root, err := s.verifyOwnership()
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return fn(root, verify)
}
func (s *Store) Close() error {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.listeners {
		close(ch)
		delete(s.listeners, ch)
	}
	var err error
	if s.db != nil {
		if C.sqlite3_close(s.db) != C.SQLITE_OK {
			return s.err()
		}
		s.db = nil
	}
	if s.lock != "" {
		contents, readErr := os.ReadFile(s.lock)
		lockInfo, statErr := os.Lstat(s.lock)
		if readErr == nil && statErr == nil && lockInfo.Mode().IsRegular() && os.SameFile(lockInfo, s.lockIdentity) && string(contents) == s.lockOwner {
			if removeErr := os.Remove(s.lock); removeErr != nil {
				err = errors.Join(err, removeErr)
			}
		} else {
			err = errors.Join(err, errors.New("state ownership lock changed"))
		}
		s.lock = ""
	}
	return err
}
