package task

import (
	"encoding/json"
	"errors"
	"time"
)

type TaskStore interface {
	InsertTask(json.RawMessage, json.RawMessage) (json.RawMessage, error)
}
type Service struct {
	Store TaskStore
	Now   func() time.Time
}

// Create persists a draft and its creation event atomically. Callers must
// authenticate the user and supply a current configuration snapshot.
func (s Service) Create(raw, config map[string]any) (map[string]any, error) {
	if s.Store == nil {
		return nil, errors.New("task store unavailable")
	}
	validated, err := ValidateConfig(config)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	created, err := NewTask(raw, validated, now)
	if err != nil {
		return nil, err
	}
	summary := "Task created. Ready to start."
	if created["demo"] == true {
		summary = "Demo task created. All results will be simulated."
	}
	body, err := json.Marshal(created)
	if err != nil {
		return nil, err
	}
	event, err := json.Marshal(map[string]any{"type": "created", "summary": summary})
	if err != nil {
		return nil, err
	}
	stored, err := s.Store.InsertTask(body, event)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if json.Unmarshal(stored, &result) != nil || result == nil {
		return nil, errors.New("invalid stored task")
	}
	return result, nil
}
