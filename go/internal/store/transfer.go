package store

/*
#include <sqlite3.h>
#include <stdlib.h>
*/
import "C"

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"unsafe"
)

type TransferRecord struct {
	Kind  string          `json:"kind"`
	ID    string          `json:"id,omitempty"`
	Seq   int64           `json:"seq,omitempty"`
	Body  json.RawMessage `json:"body,omitempty"`
	Value string          `json:"value,omitempty"`
}

var transferID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

// OwnedRoot returns the verified location without taking another lifecycle
// lease. It can be called inside WithConfig/WithOwnership without nested locks.
func (s *Store) OwnedRoot() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.verifyOwnership()
}

// ExportRecords emits a coherent database snapshot one row at a time. Config
// callers hold WithConfig around this method to keep both snapshots aligned.
func (s *Store) ExportRecords(ctx context.Context, w io.Writer) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.verifyOwnership(); err != nil {
		return err
	}
	return s.exportRecords(ctx, w)
}
func (s *Store) exportRecords(ctx context.Context, w io.Writer) (err error) {
	if err = s.exec("BEGIN"); err != nil {
		return err
	}
	defer func() { err = errors.Join(err, s.exec("ROLLBACK")) }()
	encode := json.NewEncoder(w)
	for _, query := range []struct{ kind, sql string }{{"task", "SELECT id,body FROM tasks ORDER BY rowid"}, {"event", "SELECT task_id,body,seq FROM events ORDER BY seq"}, {"meta", "SELECT key,value FROM meta ORDER BY key"}} {
		stmt, e := s.prepare(query.sql)
		if e != nil {
			return e
		}
		err = func() error {
			defer C.sqlite3_finalize(stmt)
			for {
				if e := ctx.Err(); e != nil {
					return e
				}
				code := C.sqlite3_step(stmt)
				if code == C.SQLITE_DONE {
					return nil
				}
				if code != C.SQLITE_ROW {
					return s.err()
				}
				r := TransferRecord{Kind: query.kind, ID: textColumn(stmt, 0)}
				if query.kind == "meta" {
					r.Value = textColumn(stmt, 1)
				} else {
					r.Body = json.RawMessage(textColumn(stmt, 1))
					if !json.Valid(r.Body) {
						return errors.New("invalid snapshot JSON")
					}
				}
				if query.kind == "event" {
					r.Seq = int64(C.sqlite3_column_int64(stmt, 2))
				}
				if e := encode.Encode(r); e != nil {
					return e
				}
			}
		}()
		if err != nil {
			return err
		}
	}
	return nil
}

// ExportLegacyRecords only reads a closed, checkpointed legacy database. The
// immutable connection never creates a WAL, SHM file, lock or state marker.
func ExportLegacyRecords(ctx context.Context, root string, w io.Writer) error {
	if _, err := os.Lstat(filepath.Join(root, "server.lock")); !errors.Is(err, os.ErrNotExist) {
		return errors.New("legacy export requires a stopped source or an offline copy")
	}
	if info, err := os.Lstat(filepath.Join(root, "relay.sqlite-wal")); err == nil && info.Size() > 0 {
		return errors.New("legacy WAL is not checkpointed; close the source before exporting")
	}
	path := filepath.Join(root, "relay.sqlite")
	before, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() || hasMultipleLinks(before) {
		return errors.New("legacy database must be a regular unlinked file")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	uri := url.URL{Scheme: "file", Path: absolute, RawQuery: "mode=ro&immutable=1"}
	name := C.CString(uri.String())
	defer C.free(unsafe.Pointer(name))
	s := &Store{}
	if C.sqlite3_open_v2(name, &s.db, C.SQLITE_OPEN_READONLY|C.SQLITE_OPEN_URI|C.SQLITE_OPEN_FULLMUTEX, nil) != C.SQLITE_OK {
		if s.db != nil {
			defer C.sqlite3_close(s.db)
		}
		return s.err()
	}
	defer C.sqlite3_close(s.db)
	if err = s.exec("PRAGMA trusted_schema=OFF"); err != nil {
		return err
	}
	if err = s.exportRecords(ctx, w); err != nil {
		return err
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) || before.Size() != after.Size() {
		return errors.New("legacy database changed during export")
	}
	if _, err = os.Lstat(filepath.Join(root, "server.lock")); !errors.Is(err, os.ErrNotExist) {
		return errors.New("legacy source started during export")
	}
	return nil
}

// ImportRecords is atomic and accepts only a fresh database. transform may
// quarantine tasks and drop runtime capabilities; it must never call Store.
func (s *Store) ImportRecords(ctx context.Context, r io.Reader, transform func(TransferRecord) (*TransferRecord, error)) (err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err = s.verifyOwnership(); err != nil {
		return err
	}
	check, e := s.prepare("SELECT (SELECT count(*) FROM tasks)+(SELECT count(*) FROM events)+(SELECT count(*) FROM meta)")
	if e != nil {
		return e
	}
	code := C.sqlite3_step(check)
	empty := code == C.SQLITE_ROW && C.sqlite3_column_int64(check, 0) == 0
	C.sqlite3_finalize(check)
	if !empty {
		return errors.New("import requires an empty destination")
	}
	if err = s.exec("BEGIN IMMEDIATE"); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = s.exec("ROLLBACK")
		}
	}()
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 4096), 32*1024*1024)
	count := 0
	for scanner.Scan() {
		if err = ctx.Err(); err != nil {
			return err
		}
		count++
		if count > 1000000 {
			return errors.New("snapshot has too many records")
		}
		var record TransferRecord
		if json.Unmarshal(scanner.Bytes(), &record) != nil {
			return errors.New("invalid snapshot record")
		}
		if transform != nil {
			next, e := transform(record)
			if e != nil {
				return e
			}
			if next == nil {
				continue
			}
			record = *next
		}
		var stmt *C.sqlite3_stmt
		switch record.Kind {
		case "task", "event":
			if !transferID.MatchString(record.ID) || !json.Valid(record.Body) {
				return errors.New("invalid task or event snapshot")
			}
			if record.Kind == "task" {
				var body map[string]any
				if json.Unmarshal(record.Body, &body) != nil || body["id"] != record.ID {
					return errors.New("snapshot task ID mismatch")
				}
				stmt, err = s.prepare("INSERT INTO tasks(id,body) VALUES (?,?)")
			} else {
				if record.Seq < 1 {
					return errors.New("invalid event sequence")
				}
				stmt, err = s.prepare("INSERT INTO events(task_id,body,seq) VALUES (?,?,?)")
			}
			if err == nil {
				err = s.bind(stmt, 1, record.ID)
			}
			if err == nil {
				err = s.bind(stmt, 2, string(record.Body))
			}
			if err == nil && record.Kind == "event" && C.sqlite3_bind_int64(stmt, 3, C.sqlite3_int64(record.Seq)) != C.SQLITE_OK {
				err = s.err()
			}
		case "meta":
			if len(record.ID) > 300 || len(record.ID) == 0 || len(record.Value) > 32*1024*1024 {
				return errors.New("invalid metadata snapshot")
			}
			stmt, err = s.prepare("INSERT INTO meta(key,value) VALUES (?,?)")
			if err == nil {
				err = s.bind(stmt, 1, record.ID)
			}
			if err == nil {
				err = s.bind(stmt, 2, record.Value)
			}
		default:
			return fmt.Errorf("unknown snapshot record: %s", record.Kind)
		}
		if stmt != nil {
			if err == nil && C.sqlite3_step(stmt) != C.SQLITE_DONE {
				err = s.err()
			}
			C.sqlite3_finalize(stmt)
		}
		if err != nil {
			return err
		}
	}
	if err = scanner.Err(); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = s.exec("COMMIT"); err != nil {
		return err
	}
	committed = true
	s.notify()
	return nil
}
