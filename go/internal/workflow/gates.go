// Package workflow ports approval transitions. These pure functions are not an
// HTTP authorization boundary; callers must authenticate the human separately.
package workflow

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf16"
)

type Authorization struct {
	Human               bool
	AutomationID, Scope string
}
type GateResult struct {
	Task  map[string]any
	Event map[string]any
}
type Fingerprints struct {
	Combined     string
	Repositories map[string]string
}

func object(value any) map[string]any { v, _ := value.(map[string]any); return v }
func array(value any) []any           { v, _ := value.([]any); return v }
func text(value any) string           { v, _ := value.(string); return v }
func copyTask(task map[string]any) (map[string]any, error) {
	raw, err := json.Marshal(task)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err = json.Unmarshal(raw, &out); err != nil || out == nil {
		return nil, errors.New("invalid task")
	}
	return out, nil
}
func nonempty(value string) bool { return strings.TrimSpace(value) != "" }
func presentID(value any) string { return text(value) }
func date(value any) (time.Time, bool) {
	v, err := time.Parse(time.RFC3339Nano, text(value))
	return v, err == nil
}

// CompletedPlan excludes debugger handoffs and stale follow-up plans.
func CompletedPlan(task map[string]any) map[string]any {
	return object(completedPlanAttempt(task)["handoff"])
}

func completedPlanAttempt(task map[string]any) map[string]any {
	attempts := array(task["attempts"])
	follow := object(task["followUpContext"])
	followID := presentID(follow["id"])
	for i := len(attempts) - 1; i >= 0; i-- {
		a := object(attempts[i])
		if a == nil || text(a["stage"]) != "plan" || text(a["status"]) != "complete" || text(a["role"]) == "debug" {
			continue
		}
		h := object(a["handoff"])
		if text(h["verdict"]) != "complete" {
			continue
		}
		if followID != "" {
			if id := text(a["followUpId"]); id != "" {
				if id != followID {
					continue
				}
			} else {
				at, aok := date(a["startedAt"])
				after, bok := date(follow["startedAt"])
				if !aok || !bok || at.Before(after) {
					continue
				}
			}
		}
		return a
	}
	return nil
}
func authenticate(auth Authorization, automation map[string]any) (string, error) {
	if auth.Human {
		if auth.AutomationID != "" || auth.Scope != "" {
			return "", errors.New("ambiguous approval authority")
		}
		return "user", nil
	}
	if auth.AutomationID == "" || automation["enabled"] != true || automation["error"] != nil || text(automation["authorizationId"]) != auth.AutomationID {
		return "", errors.New("Auto delegation changed; the automatic action was stopped")
	}
	scope := text(automation["scope"])
	if scope != "reviewed" && scope != "draft_pr" {
		return "", errors.New("invalid Auto scope")
	}
	if auth.Scope != "" && auth.Scope != scope {
		return "", errors.New("Auto delegation changed; the automatic action was stopped")
	}
	return "relay", nil
}
func validateState(task map[string]any, requireAttempts bool) error {
	for _, key := range []string{"messages", "approvals"} {
		values, ok := task[key].([]any)
		if !ok {
			return errors.New("Invalid task state")
		}
		for _, value := range values {
			if object(value) == nil {
				return errors.New("Invalid task state")
			}
		}
	}
	if requireAttempts {
		values, ok := task["attempts"].([]any)
		if !ok {
			return errors.New("Invalid task state")
		}
		for _, value := range values {
			if object(value) == nil {
				return errors.New("Invalid task state")
			}
		}
	}
	if value, exists := task["reviewComments"]; exists && value != nil {
		values, ok := value.([]any)
		if !ok {
			return errors.New("Invalid task state")
		}
		for _, item := range values {
			if object(item) == nil {
				return errors.New("Invalid task state")
			}
		}
	}
	return nil
}
func hasPending(task map[string]any) bool {
	for _, value := range array(task["messages"]) {
		if text(object(value)["delivery"]) == "pending" {
			return true
		}
	}
	return false
}
func jsTrim(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return r >= 9 && r <= 13 || r == 0x20 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
	})
}
func timestamp(now time.Time) string { return now.UTC().Format("2006-01-02T15:04:05.000Z") }

// ApprovePlan authorizes one current option. It never launches an agent.
func ApprovePlan(task map[string]any, optionID, note string, auth Authorization, automation map[string]any, now time.Time) (GateResult, error) {
	if task == nil {
		return GateResult{}, errors.New("task not found")
	}
	if err := validateState(task, true); err != nil {
		return GateResult{}, err
	}
	if text(task["preset"]) == "investigate" {
		return GateResult{}, errors.New("Investigation-only tasks cannot implement changes")
	}
	if hasPending(task) {
		return GateResult{}, errors.New("Pending direction must be processed before approval. Request proposal changes first.")
	}
	if text(task["status"]) != "awaiting_plan" {
		return GateResult{}, errors.New("Task is not awaiting an approach")
	}
	plan := CompletedPlan(task)
	var option map[string]any
	for _, value := range array(plan["options"]) {
		candidate := object(value)
		if text(candidate["id"]) == optionID && optionID != "" {
			option = candidate
			break
		}
	}
	if option == nil {
		return GateResult{}, errors.New("Select one of the proposed approaches")
	}
	matches := 0
	for _, value := range array(plan["options"]) {
		candidate := object(value)
		if text(candidate["id"]) == optionID {
			matches++
		}
	}
	if matches != 1 || !nonempty(text(option["title"])) || !nonempty(text(option["description"])) || !nonempty(text(option["tradeoffs"])) {
		return GateResult{}, errors.New("Invalid proposed approach")
	}
	source, err := authenticate(auth, automation)
	if err != nil {
		return GateResult{}, err
	}
	if len(utf16.Encode([]rune(note))) > 10000 {
		return GateResult{}, errors.New("Note must be a string of at most 10000 characters")
	}
	result, err := copyTask(task)
	if err != nil {
		return GateResult{}, err
	}
	plan = CompletedPlan(result)
	for _, value := range array(plan["options"]) {
		candidate := object(value)
		if text(candidate["id"]) == optionID {
			option = candidate
			break
		}
	}
	result["chosenApproach"] = option
	approval := map[string]any{"type": "approach", "option": option, "at": timestamp(now), "note": jsTrim(note)}
	if source == "relay" {
		scope := auth.Scope
		if scope == "" {
			scope = text(automation["scope"])
		}
		approval["automation"] = map[string]any{"authorizationId": auth.AutomationID, "scope": scope}
	}
	result["approvals"] = append(array(result["approvals"]), approval)
	result["status"] = "queued"
	result["stage"] = "implement"
	result["repositoryCursor"] = 0
	result["error"] = nil
	return GateResult{result, map[string]any{"type": "approval", "source": source, "summary": fmt.Sprintf("Approach approved: %s", text(option["title"])), "details": note}}, nil
}

// AcceptFinal requires fingerprints produced by a trusted workspace inspection.
// Callers must inspect the leased workspace and authenticate approval authority.
func AcceptFinal(task map[string]any, fingerprints Fingerprints, auth Authorization, automation map[string]any, now time.Time) (GateResult, error) {
	if task == nil {
		return GateResult{}, errors.New("task not found")
	}
	if err := validateState(task, false); err != nil {
		return GateResult{}, err
	}
	for _, value := range array(task["reviewComments"]) {
		if text(object(value)["status"]) == "open" || object(value)["resolved"] == false {
			return GateResult{}, errors.New("Resolve inline comments or request focused repairs before acceptance")
		}
	}
	if hasPending(task) {
		return GateResult{}, errors.New("Pending direction must be processed before acceptance. Request changes first.")
	}
	if text(task["status"]) != "awaiting_final" {
		return GateResult{}, errors.New("Task is not awaiting final approval")
	}
	demo := task["demo"] == true
	reviewed := text(task["reviewedFingerprint"])
	if !demo {
		if !nonempty(reviewed) || fingerprints.Combined != reviewed || text(task["verifiedFingerprint"]) != reviewed {
			return GateResult{}, errors.New("The workspace changed after review or lacks matching verification.")
		}
		entries := array(task["repositories"])
		if len(entries) <= 1 {
			entries = []any{task}
		}
		seen := map[string]bool{}
		for _, value := range entries {
			entry := object(value)
			id := text(object(entry["repository"])["id"])
			if id == "" || seen[id] || !nonempty(fingerprints.Repositories[id]) {
				return GateResult{}, errors.New("Current repository fingerprints are required")
			}
			seen[id] = true
		}
	}
	source, err := authenticate(auth, automation)
	if err != nil {
		return GateResult{}, err
	}
	result, err := copyTask(task)
	if err != nil {
		return GateResult{}, err
	}
	if !demo {
		entries := array(result["repositories"])
		if len(entries) <= 1 {
			entries = []any{result}
		}
		for _, value := range entries {
			entry := object(value)
			id := text(object(entry["repository"])["id"])
			entry["acceptedFingerprint"] = fingerprints.Repositories[id]
		}
	}
	result["status"] = "completed"
	approval := map[string]any{"type": "final", "at": timestamp(now), "fingerprint": result["reviewedFingerprint"]}
	if source == "relay" {
		scope := auth.Scope
		if scope == "" {
			scope = text(automation["scope"])
		}
		approval["automation"] = map[string]any{"authorizationId": auth.AutomationID, "scope": scope}
	}
	result["approvals"] = append(array(result["approvals"]), approval)
	return GateResult{result, map[string]any{"type": "accepted", "source": source, "summary": "Final result accepted. Workspace and branch retained."}}, nil
}
