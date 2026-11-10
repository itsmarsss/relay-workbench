package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"relay.local/relay/internal/harness"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
)

func fields(body map[string]any, allowed ...string) error {
	valid := map[string]bool{"taskRevision": true}
	for _, key := range allowed {
		valid[key] = true
	}
	for key := range body {
		if !valid[key] {
			return errors.New("unexpected field: " + key)
		}
	}
	return nil
}
func (c *Coordinator) inspected(id string, body map[string]any) (json.RawMessage, map[string]any, error) {
	return c.inspectedMode(id, body, false)
}
func (c *Coordinator) inspectedMode(id string, body map[string]any, allowImported bool) (json.RawMessage, map[string]any, error) {
	raw, err := c.store.Get(id)
	if err != nil {
		return nil, nil, err
	}
	if revision := text(body["taskRevision"]); revision == "" || revision != store.TaskRevision(raw) {
		return nil, nil, store.ErrTaskChanged
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, nil, errors.New("invalid task state")
	}
	if object(value["migration"])["readOnly"] == true && !allowImported {
		return nil, nil, errors.New("imported history is read-only; create a fresh draft")
	}
	return raw, value, nil
}

// Control is the authenticated task-edit boundary. It never accepts persisted
// attempts, approvals, workspace paths or workflow state from HTTP clients.
func (c *Coordinator) Control(ctx context.Context, id, operation string, body map[string]any) (any, error) {
	return c.control(ctx, id, operation, body, nil)
}

func (c *Coordinator) control(ctx context.Context, id, operation string, body map[string]any, receipt *feedbackReceipt) (any, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, errors.New("request was cancelled")
	}
	if operation == "cleanup" {
		return c.Cleanup(ctx, id, body)
	}
	if operation == "automation" {
		return c.setAutomation(id, body)
	}
	if operation == "checkpoint" {
		return c.ForkCheckpoint(ctx, id, body)
	}
	if operation == "monitor" {
		if err := fields(body, "repositoryId"); err != nil {
			return nil, err
		}
		return c.Monitor(ctx, id, text(body["taskRevision"]), text(body["repositoryId"]))
	}
	if operation == "followup" {
		return c.Followup(ctx, id, body)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, errors.New("Relay is shutting down")
	}
	raw, value, err := c.inspectedMode(id, body, operation == "delete" || operation == "recreate" || operation == "status-override")
	if err != nil {
		return nil, err
	}
	active := c.jobs[id] != nil || value["status"] == "running" || value["status"] == "queued" || value["status"] == "manual"
	summary := ""
	switch operation {
	case "recreate":
		if err = fields(body); err != nil {
			return nil, err
		}
		if object(value["migration"])["readOnly"] != true {
			return nil, errors.New("only imported history can be recreated")
		}
		settings, err := (task.ConfigurationService{Store: c.store}).Read()
		if err != nil {
			return nil, err
		}
		draft := map[string]any{}
		for _, key := range []string{"title", "description", "ticket", "demo", "preset", "routing", "models", "efforts", "execution", "dependencies", "smartRouting"} {
			if v, ok := value[key]; ok {
				draft[key] = v
			}
		}
		ids := []any{}
		for _, item := range array(value["repositories"]) {
			ids = append(ids, object(object(item)["repository"])["id"])
		}
		if len(ids) == 0 && object(value["repository"])["id"] != nil {
			ids = append(ids, object(value["repository"])["id"])
		}
		if value["demo"] != true {
			draft["repositoryIds"], draft["repositoryId"] = ids, object(value["repository"])["id"]
		}
		created, err := (task.Service{Store: c.store}).Create(draft, settings.Value)
		if err != nil {
			return nil, err
		}
		_, _ = c.store.Event(id, mustJSON(map[string]any{"type": "migration", "source": "user", "summary": "Created a fresh draft from imported history.", "taskId": id, "newTaskId": created["id"]}))
		return created, nil
	case "delete":
		if err = fields(body); err != nil {
			return nil, err
		}
		if active {
			return nil, errors.New("pause active work before deleting this task")
		}
		if err = c.store.DeleteTask(id); err != nil {
			return nil, err
		}
		return map[string]any{"deleted": true, "id": id}, nil
	case "edit":
		if err = fields(body, "title", "description", "ticket", "preset", "repositoryId", "repositoryIds", "repositorySettings", "dependencies", "smartRouting", "routing", "models", "efforts", "execution"); err != nil {
			return nil, err
		}
		if active {
			return nil, errors.New("pause active work before editing configuration")
		}
		config, err := (task.ConfigurationService{Store: c.store}).Read()
		if err != nil {
			return nil, err
		}
		draft := map[string]any{}
		for _, key := range []string{"title", "description", "ticket", "preset", "demo", "smartRouting", "routing", "models", "efforts", "execution", "dependencies"} {
			if item, ok := value[key]; ok {
				draft[key] = item
			}
		}
		entries := array(value["repositories"])
		ids := []any{}
		for _, item := range entries {
			ids = append(ids, object(object(item)["repository"])["id"])
		}
		if len(ids) == 0 {
			ids = append(ids, object(value["repository"])["id"])
		}
		if value["demo"] != true {
			draft["repositoryIds"], draft["repositoryId"] = ids, object(value["repository"])["id"]
		}
		hasWorkspace := text(value["workspaceRoot"]) != ""
		for key, item := range body {
			if key == "taskRevision" {
				continue
			}
			if hasWorkspace && (key == "repositoryId" || key == "repositoryIds" || key == "repositorySettings" || key == "dependencies" || key == "preset") {
				return nil, errors.New("repository scope is fixed once a workspace exists; create a continuation instead")
			}
			draft[key] = item
		}
		if hasWorkspace {
			profiles := []any{}
			if len(entries) == 0 {
				entries = []any{value}
			}
			for _, item := range entries {
				profiles = append(profiles, object(item)["repository"])
			}
			config.Value["repositories"] = profiles
		}
		validated, err := task.NewTask(draft, config.Value, time.Now())
		if err != nil {
			return nil, err
		}
		if !hasWorkspace {
			for _, key := range []string{"repositories", "repository", "dependencies", "preset", "workflowGuidance"} {
				value[key] = validated[key]
			}
		}
		for _, key := range []string{"title", "description", "ticket", "routing", "models", "efforts", "execution", "smartRouting"} {
			value[key] = validated[key]
		}
		summary = "Task configuration updated."
	case "publication", "feedback":
		if err = fields(body, "repositoryId", "enabled"); err != nil {
			return nil, err
		}
		if active {
			return nil, ErrStageBusy
		}
		enabled, ok := body["enabled"].(bool)
		if !ok {
			return nil, errors.New("choose whether automation is enabled")
		}
		repositoryID := text(body["repositoryId"])
		entry := publicationEntry(value, repositoryID)
		if entry == nil {
			return nil, errors.New("select a task repository")
		}
		if enabled && (!harness.HasFinalApproval(value) || text(object(entry["publication"])["url"]) == "") {
			return nil, errors.New("publish an accepted task before enabling monitoring")
		}
		err = updateWorkspace(value, repositoryID, func(target map[string]any) {
			key := "publicationMonitor"
			if operation == "feedback" {
				key = "feedbackAutomation"
			}
			state := object(target[key])
			if state == nil {
				state = map[string]any{}
				target[key] = state
			}
			state["enabled"], state["updatedAt"] = enabled, timestamp(time.Now())
			if operation == "feedback" && enabled {
				monitor := object(target["publicationMonitor"])
				if monitor == nil {
					monitor = map[string]any{}
					target["publicationMonitor"] = monitor
				}
				monitor["enabled"] = true
			}
		})
		if err != nil {
			return nil, err
		}
		summary = "Pull request automation updated."
	case "status-override":
		if err = fields(body, "value", "lane"); err != nil {
			return nil, err
		}
		lanes := map[string]string{"backlog": "draft", "discovery": "running", "approach": "awaiting_plan", "progress": "running", "review": "review", "final": "awaiting_final", "done": "completed", "finished": "finished", "attention": "blocked", "cancelled": "cancelled"}
		if body["value"] == nil {
			value["statusOverride"] = nil
		} else {
			state := text(body["value"])
			valid := false
			for _, v := range lanes {
				if v == state {
					valid = true
				}
			}
			lane := text(body["lane"])
			if !valid || (lane != "" && lanes[lane] != state) {
				return nil, errors.New("select a valid board column")
			}
			value["statusOverride"] = map[string]any{"value": state, "lane": lane, "at": timestamp(time.Now())}
		}
		summary = "Board status updated. Workflow gates are unchanged."
	case "message", "request-changes", "replan":
		if err = fields(body, "message", "provider", "model", "effort"); err != nil {
			return nil, err
		}
		message, ok := body["message"].(string)
		if !ok || strings.TrimSpace(message) == "" || len(message) > 20000 {
			return nil, errors.New("enter direction of at most 20000 characters")
		}
		if len(array(value["messages"])) >= 500 {
			return nil, errors.New("task message limit reached")
		}
		if operation != "message" {
			if active {
				return nil, ErrStageBusy
			}
			if operation == "request-changes" && !harness.HasApprovedApproach(value) {
				return nil, errors.New("choose an implementation approach before requesting code changes")
			}
			if err = c.configureContinuation(value, body); err != nil {
				return nil, err
			}
			value["stage"], value["status"], value["repositoryCursor"], value["round"] = "implement", "paused", 0, 0
			if operation == "replan" {
				value["stage"], value["chosenApproach"] = "plan", nil
			}
			value["verifiedFingerprint"], value["reviewedFingerprint"], value["error"], value["recovery"], value["blockerDecision"] = nil, nil, nil, nil, nil
			value["publicationRecovery"] = nil
		}
		messageID, err := stageUUID()
		if err != nil {
			return nil, err
		}
		value["messages"] = append(array(value["messages"]), map[string]any{"id": messageID, "at": timestamp(time.Now()), "role": "user", "text": message, "delivery": "pending"})
		summary = "Direction saved for the next agent turn."
	case "review-comment":
		if err = fields(body, "commentId", "text", "file", "line", "repositoryId", "resolved", "side", "fingerprint"); err != nil {
			return nil, err
		}
		if active {
			return nil, errors.New("wait for the current operation before changing review comments")
		}
		if value["status"] != "awaiting_final" {
			return nil, errors.New("review comments require final review")
		}
		if expected := text(body["fingerprint"]); expected != "" && expected != text(value["reviewedFingerprint"]) {
			return nil, errors.New("changes were updated since this diff was opened; refresh before commenting")
		}
		comments := array(value["reviewComments"])
		if commentID := text(body["commentId"]); commentID != "" {
			found := false
			for _, item := range comments {
				comment := object(item)
				if text(comment["id"]) == commentID {
					resolved, ok := body["resolved"].(bool)
					if !ok {
						return nil, errors.New("choose a comment status")
					}
					comment["resolved"] = resolved
					comment["status"] = "open"
					if resolved {
						comment["status"] = "resolved"
					}
					found = true
				}
			}
			if !found {
				return nil, errors.New("review comment not found")
			}
		} else {
			if text(body["fingerprint"]) == "" {
				return nil, errors.New("refresh the diff before commenting")
			}
			content := strings.TrimSpace(text(body["text"]))
			file := text(body["file"])
			if strings.HasPrefix(file, "/") || strings.Contains(file, "\\") || strings.ContainsRune(file, '\x00') {
				return nil, errors.New("invalid comment file")
			}
			for _, part := range strings.Split(file, "/") {
				if part == ".." {
					return nil, errors.New("invalid comment file")
				}
			}
			if content == "" || file == "" || len(content) > 10000 || len(file) > 1000 || len(comments) >= 200 {
				return nil, errors.New("invalid review comment")
			}
			repoID := text(body["repositoryId"])
			if publicationEntry(value, repoID) == nil {
				return nil, errors.New("select a task repository")
			}
			line, _ := body["line"].(float64)
			if line < 1 || line > 10000000 || line != float64(int(line)) {
				return nil, errors.New("invalid comment line")
			}
			if side := text(body["side"]); side != "old" && side != "new" {
				return nil, errors.New("select the old or new side of the diff")
			}
			commentID, err := stageUUID()
			if err != nil {
				return nil, err
			}
			comments = append(comments, map[string]any{"id": commentID, "text": content, "file": file, "line": line, "side": text(body["side"]), "fingerprint": value["reviewedFingerprint"], "repositoryId": repoID, "resolved": false, "status": "open", "at": timestamp(time.Now())})
		}
		value["reviewComments"] = comments
		summary = "Review comments updated."
	default:
		return nil, errors.New("unknown task action")
	}
	if receipt != nil {
		entry := publicationEntry(value, receipt.repositoryID)
		if entry == nil || object(entry["feedbackAutomation"])["enabled"] != true {
			return nil, errors.New("feedback automation is no longer enabled")
		}
		handled := object(entry["feedbackHandled"])
		if handled == nil {
			handled = map[string]any{}
			entry["feedbackHandled"] = handled
		}
		for _, key := range receipt.keys {
			if handled[key] == true {
				return nil, errors.New("feedback already handled")
			}
			handled[key] = true
		}
	}
	next, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	event, _ := json.Marshal(map[string]any{"type": operation, "source": "user", "summary": summary})
	saved, err := c.store.CompareAndSwap(id, raw, next, event)
	if err != nil {
		return nil, err
	}
	if json.Unmarshal(saved, &value) != nil {
		return nil, errors.New("invalid saved task")
	}
	value["taskRevision"] = store.TaskRevision(saved)
	return value, nil
}
func (c *Coordinator) configureContinuation(value, body map[string]any) error {
	provider := text(body["provider"])
	if provider == "" {
		provider = text(object(value["routing"])["implement"])
	}
	config, err := (task.ConfigurationService{Store: c.store}).Read()
	if err != nil {
		return err
	}
	enabled, _ := enabledAgents(config.Value)
	if !enabled[provider] {
		return errors.New("select an available provider")
	}
	model, effort, err := harness.Options(provider, text(body["model"]), text(body["effort"]))
	if err != nil {
		return err
	}
	routing := object(value["routing"])
	models := object(value["models"])
	if routing == nil || models == nil {
		return errors.New("invalid task routing")
	}
	routing["implement"] = provider
	if _, exists := body["model"]; exists {
		models["implement"] = model
	}
	if _, exists := body["effort"]; exists {
		efforts := object(value["efforts"])
		if efforts == nil {
			efforts = map[string]any{}
			value["efforts"] = efforts
		}
		efforts["implement"] = effort
	}
	return nil
}
