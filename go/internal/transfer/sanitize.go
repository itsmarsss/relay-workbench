package transfer

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"relay.local/relay/internal/assistant"
	"relay.local/relay/internal/store"
)

type sanitizer struct {
	legacy map[string][]assistant.Message
	names  map[string]string
	side   map[string][]assistant.Message
}

func newSanitizer() *sanitizer {
	return &sanitizer{legacy: map[string][]assistant.Message{}, names: map[string]string{}, side: map[string][]assistant.Message{}}
}
func (s *sanitizer) record(r store.TransferRecord) (*store.TransferRecord, error) {
	switch r.Kind {
	case "task":
		var value map[string]any
		if json.Unmarshal(r.Body, &value) != nil || value == nil {
			return nil, errors.New("invalid archived task")
		}
		oldStatus := str(value["status"])
		value["migration"] = map[string]any{"readOnly": true, "importedAt": time.Now().UTC().Format(time.RFC3339), "originalStatus": oldStatus, "originalStage": value["stage"], "originalWorkspace": value["workspaceRoot"]}
		value["status"], value["stage"] = "imported", "archived"
		for _, key := range []string{"statusOverride", "automation", "currentRun", "terminal", "terminalControl", "nativeSession", "executionBudget", "recovery", "blockerDecision", "publicationRecovery", "chosenApproach", "verifiedFingerprint", "reviewedFingerprint", "acceptedFingerprint", "workspaceRoot", "workspace", "workspaceDraft", "workspaceHead", "setupCompleted"} {
			delete(value, key)
		}
		value["approvals"] = []any{}
		entries, _ := value["repositories"].([]any)
		for _, item := range append(entries, value) {
			entry := obj(item)
			if entry == nil {
				continue
			}
			for _, key := range []string{"workspaceRoot", "workspace", "workspaceDraft", "workspaceHead", "setupCompleted", "acceptedFingerprint", "feedbackAutomation"} {
				delete(entry, key)
			}
			if monitor := obj(entry["publicationMonitor"]); monitor != nil {
				monitor["enabled"], monitor["status"] = false, "stopped"
			}
			if delivery := obj(entry["delivery"]); delivery != nil && (delivery["status"] == "running" || delivery["status"] == "queued") {
				delivery["status"] = "interrupted"
			}
		}
		for _, key := range []string{"attempts", "deliveryRuns"} {
			runs, _ := value[key].([]any)
			for _, item := range runs {
				run := obj(item)
				if run["status"] == "running" || run["status"] == "queued" {
					run["status"] = "interrupted"
				}
				delete(run, "terminal")
				delete(run, "nativeSession")
			}
		}
		if questions := value["questions"]; questions != nil {
			raw, _ := json.Marshal(questions)
			var messages []assistant.Message
			if json.Unmarshal(raw, &messages) == nil && len(messages) > 0 {
				s.side[r.ID] = messages
			}
		}
		raw, err := json.Marshal(value)
		r.Body = raw
		return &r, err
	case "event":
		return &r, nil
	case "meta":
		switch {
		case strings.HasPrefix(r.ID, "assistant:chat:"):
			var chat assistant.Chat
			if json.Unmarshal([]byte(r.Value), &chat) != nil {
				return nil, errors.New("invalid archived conversation")
			}
			sanitizeMessages(chat.Messages)
			chat.Revision++
			raw, _ := json.Marshal(chat)
			r.Value = string(raw)
			return &r, nil
		case r.ID == "workspace-conversations":
			var rows []map[string]any
			if json.Unmarshal([]byte(r.Value), &rows) != nil {
				return nil, errors.New("invalid legacy conversation list")
			}
			for _, row := range rows {
				s.names[str(row["id"])] = str(row["title"])
			}
			return nil, nil
		case r.ID == "workspace-agent" || strings.HasPrefix(r.ID, "workspace-agent:"):
			id := strings.TrimPrefix(r.ID, "workspace-agent:")
			if r.ID == "workspace-agent" {
				id = "default"
			}
			var messages []assistant.Message
			if json.Unmarshal([]byte(r.Value), &messages) != nil {
				return nil, errors.New("invalid legacy conversation")
			}
			s.legacy[id] = messages
			return nil, nil
		case strings.HasPrefix(r.ID, "memory:"):
			var value map[string]any
			if json.Unmarshal([]byte(r.Value), &value) != nil || value == nil {
				return nil, errors.New("invalid archived memory")
			}
			value["status"], value["approvedRevision"] = "disabled", 0
			raw, _ := json.Marshal(value)
			r.Value = string(raw)
			return &r, nil
		case strings.HasPrefix(r.ID, "checkpoints:"):
			// Retained as historical graph data. Workflow guards prohibit restore.
			return &r, nil
		default:
			return nil, nil // Session secrets, grants, processes and proposals expire.
		}
	default:
		return nil, errors.New("unknown archive record")
	}
}
func sanitizeMessages(messages []assistant.Message) {
	for i := range messages {
		m := &messages[i]
		if m.Status == "running" {
			m.Status = "interrupted"
			m.Error = "Imported from another instance; send again to continue."
		}
		if m.ToolCalls == nil {
			m.ToolCalls = []assistant.ToolCall{}
		}
		if m.Mentions == nil {
			m.Mentions = []string{}
		}
		for j := range m.ToolCalls {
			if m.ToolCalls[j].Status == "running" {
				m.ToolCalls[j].Status = "interrupted"
			}
		}
	}
}
func (s *sanitizer) legacyChats(db *store.Store) error {
	for id, messages := range s.legacy {
		name := s.names[id]
		if name == "" {
			name = "Imported conversation"
		}
		if err := saveLegacyChat(db, "legacy-"+id, name, "", messages); err != nil {
			return err
		}
	}
	for id, messages := range s.side {
		if err := saveLegacyChat(db, "legacy-task-"+id, "Imported task conversation", id, messages); err != nil {
			return err
		}
	}
	return nil
}
func saveLegacyChat(db *store.Store, id, name, taskID string, messages []assistant.Message) error {
	if len(id) > 80 || strings.ContainsAny(id, "/\\\x00") || len(messages) > 10000 {
		return errors.New("legacy conversation exceeds limits")
	}
	sanitizeMessages(messages)
	now := time.Now().UTC().Format(time.RFC3339)
	chat := assistant.Chat{ID: id, Name: name, TaskID: taskID, Revision: 1, CreatedAt: now, UpdatedAt: now, Messages: messages}
	raw, _ := json.Marshal(chat)
	if _, exists, err := db.GetMeta("assistant:chat:" + id); err != nil {
		return err
	} else if exists {
		return errors.New("legacy conversation ID collision")
	}
	return db.SetMeta("assistant:chat:"+id, string(raw))
}
