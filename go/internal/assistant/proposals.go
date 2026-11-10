package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
)

type Proposal struct {
	ID         string         `json:"id"`
	ChatID     string         `json:"chatId"`
	Kind       string         `json:"kind"`
	Reason     string         `json:"reason"`
	Status     string         `json:"status"`
	CreatedAt  string         `json:"createdAt"`
	FinishedAt string         `json:"finishedAt,omitempty"`
	TaskID     string         `json:"taskId,omitempty"`
	TaskTitle  string         `json:"taskTitle,omitempty"`
	Operation  string         `json:"operation,omitempty"`
	Body       map[string]any `json:"body"`
	Error      string         `json:"error,omitempty"`
	Result     any            `json:"result,omitempty"`
}

func (s *Service) propose(chat Chat, name string, input map[string]any) (Proposal, error) {
	reason := text(input["reason"])
	if reason == "" || len(reason) > 4000 {
		return Proposal{}, errors.New("explain the proposed change")
	}
	p := Proposal{ID: uuid(), ChatID: chat.ID, Reason: reason, Status: "pending", CreatedAt: now(), Kind: "task", TaskID: text(input["taskId"]), Operation: text(input["operation"]), Body: obj(input["body"])}
	if name == "propose_config_change" {
		p.Kind = "configuration"
		config, err := (task.ConfigurationService{Store: s.Store}).Read()
		if err != nil {
			return p, err
		}
		validated, err := task.ValidateConfig(obj(input["config"]))
		if err != nil {
			return p, err
		}
		p.Body = map[string]any{"config": validated, "configRevision": config.Revision}
	} else {
		allowed := map[string]bool{"automation": true, "checkpoint": true, "edit": true, "status-override": true, "message": true, "request-changes": true, "replan": true, "publication": true, "feedback": true, "monitor": true, "start": true, "resume": true, "pause": true}
		if !allowed[p.Operation] || p.Body == nil {
			return p, errors.New("unsupported task proposal operation")
		}
		raw, err := s.Store.Get(p.TaskID)
		if err != nil {
			return p, err
		}
		var value map[string]any
		if json.Unmarshal(raw, &value) != nil {
			return p, errors.New("invalid task")
		}
		p.TaskTitle = text(value["title"])
		p.Body["taskRevision"] = store.TaskRevision(raw)
		if p.Operation == "start" || p.Operation == "resume" || p.Operation == "pause" {
			if err := checkFields(p.Body, "taskRevision"); err != nil {
				return p, err
			}
		}
	}
	entries, err := s.Store.ListMeta("assistant:proposal:")
	if err != nil {
		return p, err
	}
	if len(entries) >= 500 {
		return p, errors.New("proposal limit reached")
	}
	encoded, _ := json.Marshal(p)
	if err = s.Store.SetMeta("assistant:proposal:"+p.ID, string(encoded)); err == nil {
		s.Store.NotifyChange()
	}
	return p, err
}
func (s *Service) Proposals(chatID string) ([]Proposal, error) {
	entries, err := s.Store.ListMeta("assistant:proposal:")
	if err != nil {
		return nil, err
	}
	result := []Proposal{}
	for _, entry := range entries {
		var p Proposal
		if json.Unmarshal([]byte(entry.Value), &p) != nil {
			return nil, errors.New("invalid proposal")
		}
		if p.ChatID == chatID {
			result = append(result, p)
		}
	}
	return result, nil
}
func (s *Service) Decide(ctx context.Context, chatID string, body map[string]any) (Proposal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Proposal{}, errors.New("Relay is shutting down")
	}
	if _, err := s.Get(chatID); err != nil {
		return Proposal{}, err
	}
	if err := checkFields(body, "proposalId", "decision"); err != nil {
		return Proposal{}, err
	}
	id := text(body["proposalId"])
	decision := text(body["decision"])
	if !identifier.MatchString(id) || (decision != "approve" && decision != "reject") {
		return Proposal{}, errors.New("select an exact proposal and decision")
	}
	var p Proposal
	err := s.Store.UpdateMeta("assistant:proposal:"+id, func(raw string, exists bool) (string, error) {
		if !exists {
			return "", os.ErrNotExist
		}
		if json.Unmarshal([]byte(raw), &p) != nil {
			return "", errors.New("invalid proposal")
		}
		if p.ChatID != chatID || p.Status != "pending" {
			return "", errors.New("proposal is not awaiting approval in this conversation")
		}
		p.Status = "applying"
		if decision == "reject" {
			p.Status = "rejected"
			p.FinishedAt = now()
		}
		encoded, _ := json.Marshal(p)
		return string(encoded), nil
	})
	if err != nil {
		return p, err
	}
	s.Store.NotifyChange()
	if decision == "reject" {
		return p, nil
	}
	// Recheck permission at execution. The model never receives this endpoint.
	config, err := s.configuration()
	permission := "proposeTasks"
	if p.Kind == "configuration" {
		permission = "proposeSettings"
	}
	if err == nil && obj(obj(config["workspaceAgent"])["permissions"])[permission] != true {
		err = errors.New("proposal permission was revoked")
	}
	if err == nil {
		if p.Kind == "configuration" {
			p.Result, err = (task.ConfigurationService{Store: s.Store}).Replace(text(p.Body["configRevision"]), obj(p.Body["config"]))
		} else {
			raw, readErr := s.Store.Get(p.TaskID)
			err = readErr
			if err == nil && store.TaskRevision(raw) != text(p.Body["taskRevision"]) {
				err = store.ErrTaskChanged
			}
			if err == nil {
				switch p.Operation {
				case "start":
					p.Result, err = s.Actions.Start(p.TaskID)
				case "resume":
					p.Result, err = s.Actions.Resume(p.TaskID)
				case "pause":
					err = s.Actions.Pause(p.TaskID)
				default:
					p.Result, err = s.Actions.Control(ctx, p.TaskID, p.Operation, p.Body)
					if err == nil && (p.Operation == "request-changes" || p.Operation == "replan") {
						p.Result, err = s.Actions.Resume(p.TaskID)
					}
				}
			}
		}
	}
	p.Status = "applied"
	if err != nil {
		p.Status = "failed"
		p.Error = err.Error()
	}
	p.FinishedAt = now()
	encoded, _ := json.Marshal(p)
	saveErr := s.Store.SetMeta("assistant:proposal:"+id, string(encoded))
	s.Store.NotifyChange()
	return p, saveErr
}
