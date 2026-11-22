package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"relay.local/relay/internal/storage"
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
	Before     map[string]any `json:"before,omitempty"`
	Error      string         `json:"error,omitempty"`
	Result     any            `json:"result,omitempty"`
}

func (s *Service) propose(chat Chat, name string, input map[string]any) (Proposal, error) {
	reason := text(input["reason"])
	if reason == "" || len(reason) > 4000 {
		return Proposal{}, errors.New("explain the proposed change")
	}
	p := Proposal{ID: uuid(), ChatID: chat.ID, Reason: reason, Status: "pending", CreatedAt: now(), Kind: "task", TaskID: text(input["taskId"]), Operation: text(input["operation"]), Body: obj(input["body"])}
	if name == "propose_storage_change" {
		p.Kind = "storage"
		snapshot, err := (storage.PolicyService{Store: s.Store}).Read()
		if err != nil {
			return p, err
		}
		raw, err := json.Marshal(input["policy"])
		if err != nil {
			return p, err
		}
		var policy storage.Policy
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err = decoder.Decode(&policy); err != nil {
			return p, err
		}
		if err = policy.Validate(); err != nil {
			return p, err
		}
		p.Before = map[string]any{"policy": snapshot.Policy}
		p.Body = map[string]any{"policy": policy, "policyRevision": snapshot.Revision}
	} else if name == "propose_config_change" {
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
		p.Before = map[string]any{"config": config.Value}
	} else {
		allowed := map[string]bool{"approve": true, "accept": true, "publish": true, "resolve": true, "recreate": true, "cleanup": true, "delete": true, "review-comment": true, "followup": true, "automation": true, "checkpoint": true, "edit": true, "status-override": true, "message": true, "request-changes": true, "replan": true, "publication": true, "feedback": true, "monitor": true, "start": true, "resume": true, "pause": true}
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
		if p.Operation == "edit" {
			p.Before = map[string]any{}
			for key := range p.Body {
				if key != "taskRevision" {
					p.Before[key] = value[key]
				}
			}
		}
		switch p.Operation {
		case "approve":
			if err := checkFields(p.Body, "taskRevision", "optionId", "note", "planAttemptId"); err != nil {
				return p, err
			}
		case "accept":
			if err := checkFields(p.Body, "taskRevision"); err != nil {
				return p, err
			}
		case "publish":
			if err := checkFields(p.Body, "taskRevision", "repositoryId"); err != nil {
				return p, err
			}
		case "resolve":
			if err := checkFields(p.Body, "taskRevision", "decisionId", "resolution", "optionId", "note"); err != nil {
				return p, err
			}
		case "cleanup":
			if err := checkFields(p.Body, "taskRevision", "includeIgnored"); err != nil {
				return p, err
			}
			// Removing a finished task's workspace takes its build output with it; that is most of
			// its size. Local changes still block the cleanup either way.
			if _, set := p.Body["includeIgnored"].(bool); !set {
				p.Body["includeIgnored"] = true
			}
		}
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
	if p.Kind == "configuration" || p.Kind == "storage" {
		permission = "proposeSettings"
	}
	if err == nil && obj(obj(config["workspaceAgent"])["permissions"])[permission] != true {
		err = errors.New("proposal permission was revoked")
	}
	if err == nil {
		if p.Kind == "storage" {
			raw, _ := json.Marshal(p.Body["policy"])
			var policy storage.Policy
			if err = json.Unmarshal(raw, &policy); err == nil {
				p.Result, err = (storage.PolicyService{Store: s.Store}).Replace(text(p.Body["policyRevision"]), policy)
			}
		} else if p.Kind == "configuration" {
			p.Result, err = (task.ConfigurationService{Store: s.Store}).Replace(text(p.Body["configRevision"]), obj(p.Body["config"]))
		} else {
			raw, readErr := s.Store.Get(p.TaskID)
			err = readErr
			if err == nil && store.TaskRevision(raw) != text(p.Body["taskRevision"]) {
				err = store.ErrTaskChanged
			}
			if err == nil {
				switch p.Operation {
				case "approve", "accept", "publish", "resolve":
					gated, ok := s.Actions.(interface {
						Approve(context.Context, string, string, string, string, string) (map[string]any, error)
						Accept(context.Context, string, string) (map[string]any, error)
						Publish(context.Context, string, string, string) (map[string]any, error)
						Resolve(context.Context, string, string, string, string, string, string) (map[string]any, error)
					})
					if !ok {
						err = errors.New("workflow approval actions unavailable")
						break
					}
					switch p.Operation {
					case "approve":
						p.Result, err = gated.Approve(ctx, p.TaskID, text(p.Body["optionId"]), text(p.Body["note"]), text(p.Body["planAttemptId"]), text(p.Body["taskRevision"]))
					case "accept":
						p.Result, err = gated.Accept(ctx, p.TaskID, text(p.Body["taskRevision"]))
					case "publish":
						p.Result, err = gated.Publish(ctx, p.TaskID, text(p.Body["taskRevision"]), text(p.Body["repositoryId"]))
					case "resolve":
						p.Result, err = gated.Resolve(ctx, p.TaskID, text(p.Body["taskRevision"]), text(p.Body["decisionId"]), text(p.Body["resolution"]), text(p.Body["optionId"]), text(p.Body["note"]))
					}
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
