package store

/*
#include <sqlite3.h>
*/
import "C"
import "encoding/json"

// RecentActivity reads meaningful evidence without allowing transcript volume
// to hide the last operation. Results are chronological and bounded.
func (s *Store) RecentActivity(id string) ([]json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.verifyOwnership(); err != nil {
		return nil, err
	}
	stmt, err := s.prepare(`SELECT body,
 json_array(json_extract(body,'$.attemptId'),json_extract(body,'$.type'),json_extract(body,'$.kind'),json_extract(body,'$.summary'),json_extract(body,'$.details'),json_extract(body,'$.repositoryId'),json_extract(body,'$.checks')) AS signature
 FROM events WHERE task_id=? AND json_extract(body,'$.type') IN ('activity','check_evidence') ORDER BY seq DESC`)
	if err != nil {
		return nil, err
	}
	defer C.sqlite3_finalize(stmt)
	if err = s.bind(stmt, 1, id); err != nil {
		return nil, err
	}
	rows := []json.RawMessage{}
	previous := ""
	for {
		code := C.sqlite3_step(stmt)
		if code == C.SQLITE_DONE {
			break
		}
		if code != C.SQLITE_ROW {
			return nil, s.err()
		}
		signature := textColumn(stmt, 1)
		if len(rows) > 0 && signature == previous {
			// Preserve the first occurrence's clock while reading backwards.
			rows[len(rows)-1] = json.RawMessage(textColumn(stmt, 0))
			continue
		}
		if len(rows) == 200 {
			break
		}
		previous = signature
		rows = append(rows, json.RawMessage(textColumn(stmt, 0)))
	}
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	return rows, nil
}
