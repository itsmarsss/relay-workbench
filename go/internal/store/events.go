package store

/*
#include <sqlite3.h>
*/
import "C"
import (
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

func (s *Store) notify() {
	for ch := range s.listeners {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}
func (s *Store) Event(id string, raw json.RawMessage) (json.RawMessage, error) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, errors.New("invalid event")
	}
	if _, exists := object["taskId"]; !exists {
		object["taskId"], _ = json.Marshal(id)
	}
	if _, exists := object["at"]; !exists {
		object["at"], _ = json.Marshal(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	}
	body, err := json.Marshal(object)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err = s.ready(); err != nil {
		return nil, err
	}
	stmt, err := s.prepare("INSERT INTO events(task_id,body) VALUES (?,?)")
	if err != nil {
		return nil, err
	}
	defer C.sqlite3_finalize(stmt)
	if err = s.bind(stmt, 1, id); err != nil {
		return nil, err
	}
	if err = s.bind(stmt, 2, string(body)); err != nil {
		return nil, err
	}
	if C.sqlite3_step(stmt) != C.SQLITE_DONE {
		return nil, s.err()
	}
	object["seq"] = json.RawMessage(strconv.FormatInt(int64(C.sqlite3_last_insert_rowid(s.db)), 10))
	result, err := json.Marshal(object)
	if err != nil {
		return nil, err
	}
	s.notify()
	return result, nil
}
func (s *Store) DeleteTask(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return err
	}
	if err := s.exec("BEGIN IMMEDIATE"); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = s.exec("ROLLBACK")
		}
	}()
	for _, query := range []string{"DELETE FROM events WHERE task_id=?", "DELETE FROM tasks WHERE id=?"} {
		stmt, err := s.prepare(query)
		if err != nil {
			return err
		}
		if err = s.bind(stmt, 1, id); err == nil && C.sqlite3_step(stmt) != C.SQLITE_DONE {
			err = s.err()
		}
		C.sqlite3_finalize(stmt)
		if err != nil {
			return err
		}
	}
	if err := s.exec("COMMIT"); err != nil {
		return err
	}
	committed = true
	s.notify()
	return nil
}
