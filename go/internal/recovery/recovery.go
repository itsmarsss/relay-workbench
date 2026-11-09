// Package recovery ports task recovery bookkeeping. It does not start agents.
package recovery

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"unicode/utf16"
)

func object(v any) map[string]any { m, _ := v.(map[string]any); return m }
func list(v any) []any            { a, _ := v.([]any); return a }
func text(v any) string           { s, _ := v.(string); return s }
func number(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	default:
		return 0
	}
}
func index(task map[string]any) int { return number(task["repositoryCursor"]) }
func copyMap(input map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range input {
		out[k] = v
	}
	return out
}
func last(items []any) map[string]any {
	if len(items) == 0 {
		return nil
	}
	return object(items[len(items)-1])
}
func emptyIfNil(value any, fallback any) any {
	if value == nil {
		return fallback
	}
	return value
}
func tail(items []any, n int) []any {
	if len(items) > n {
		return items[len(items)-n:]
	}
	if items == nil {
		return []any{}
	}
	return items
}
func tailText(value string, n int) string {
	units := utf16.Encode([]rune(value))
	if len(units) > n {
		units = units[len(units)-n:]
	}
	return string(utf16.Decode(units))
}
func key(task map[string]any) string { return fmt.Sprintf("%s:%d", text(task["stage"]), index(task)) }

// InPlace gives the original specialist one continuation before escalation.
func InPlace(task map[string]any, reason string) bool {
	attempt := last(list(task["attempts"]))
	localKey := fmt.Sprintf("%s:%d:%d", text(task["stage"]), index(task), number(task["round"]))
	if attempt == nil || text(attempt["sessionId"]) == "" || text(attempt["role"]) == "debug" || text(attempt["harness"]) == "checks" {
		return false
	}
	local := object(task["localRecovery"])
	if text(local["key"]) == localKey && number(local["attempts"]) >= 1 {
		return false
	}
	task["localRecovery"] = map[string]any{"key": localKey, "attempts": 1, "sourceAttemptId": attempt["id"]}
	recovery := copyMap(object(task["recovery"]))
	recovery["key"] = key(task)
	recovery["phase"] = "continue"
	recovery["active"] = false
	recovery["sourceAttemptId"] = attempt["id"]
	recovery["reason"] = reason
	task["recovery"] = recovery
	task["status"] = "queued"
	task["error"] = nil
	task["blockerDecision"] = nil
	return true
}

// Blocked either schedules bounded diagnosis or records a decision for a human.
func Blocked(task, handoff map[string]any, limit int, explicit bool) (bool, error) {
	if task == nil || handoff == nil || text(task["stage"]) == "" || text(handoff["summary"]) == "" {
		return false, errors.New("invalid blocked recovery input")
	}
	currentKey := key(task)
	var previous map[string]any
	if candidate := object(task["recovery"]); text(candidate["key"]) == currentKey {
		previous = candidate
	}
	attempts := number(previous["attempts"])
	repeated := reflect.DeepEqual(previous["reason"], handoff["summary"])
	runs := list(task["attempts"])
	latest := last(runs)
	options := list(handoff["options"])
	design := !explicit && text(latest["role"]) == "debug" && len(options) > 0
	if design {
		for _, value := range options {
			option := object(value)
			id, ok := option["id"].(string)
			if !ok {
				return false, errors.New("invalid debugger option")
			}
			if !strings.HasPrefix(id, "design-") {
				design = false
				break
			}
		}
	}
	retry := !design && attempts < limit && !(repeated && attempts > 1)
	var source any
	if previous != nil {
		source = previous["sourceAttemptId"]
	}
	if source == nil {
		for i := len(runs) - 1; i >= 0; i-- {
			a := object(runs[i])
			if text(a["role"]) != "debug" && text(a["role"]) != "verifier" && reflect.DeepEqual(a["stage"], task["stage"]) && reflect.DeepEqual(a["repositoryId"], latest["repositoryId"]) {
				source = a["id"]
				break
			}
		}
	}
	var selectedRepo any
	repos := list(task["repositories"])
	stage := text(task["stage"])
	if len(repos) > 1 && (stage == "investigate" || stage == "implement" || stage == "review") {
		position := index(task)
		if position < 0 || position >= len(repos) {
			return false, errors.New("invalid repository cursor")
		}
		repo := object(object(repos[position])["repository"])
		if repo == nil || repo["id"] == nil {
			return false, errors.New("invalid repository")
		}
		selectedRepo = repo["id"]
	}
	evidence := []any{}
	for _, value := range runs {
		attempt := object(value)
		h := object(attempt["handoff"])
		if !reflect.DeepEqual(attempt["stage"], task["stage"]) || !reflect.DeepEqual(attempt["repositoryId"], selectedRepo) || text(h["verdict"]) != "blocked" {
			continue
		}
		item := map[string]any{"summary": h["summary"]}
		if v, ok := attempt["harness"]; ok {
			item["harness"] = v
		}
		if v, ok := h["details"].(string); ok {
			item["details"] = tailText(v, 4000)
		}
		if v, ok := h["evidence"].([]any); ok {
			item["evidence"] = tail(v, 12)
		}
		if v, ok := h["risks"].([]any); ok {
			item["risks"] = tail(v, 8)
		}
		evidence = append(evidence, item)
	}
	evidence = tail(evidence, 3)
	nextAttempts := attempts
	if retry {
		nextAttempts++
	}
	strategy := "fresh_diagnosis"
	if attempts >= 1 {
		strategy = "independent_diagnosis"
	}
	recovery := map[string]any{"key": currentKey, "attempts": nextAttempts, "reason": handoff["summary"], "phase": "debug", "strategy": strategy, "evidence": evidence, "active": retry, "exhausted": !retry}
	if source != nil {
		recovery["sourceAttemptId"] = source
	}
	task["recovery"] = recovery
	if retry {
		task["blockerDecision"] = nil
		task["status"] = "queued"
		task["error"] = nil
	} else {
		task["blockerDecision"] = BlockerDecision(task, handoff)
		task["status"] = "blocked"
		task["error"] = handoff["summary"]
	}
	return retry, nil
}
func BlockerDecision(task, handoff map[string]any) map[string]any {
	attempts := list(task["attempts"])
	debug := []map[string]any{}
	for _, value := range attempts {
		a := object(value)
		if text(a["role"]) == "debug" && reflect.DeepEqual(a["stage"], task["stage"]) {
			debug = append(debug, a)
		}
	}
	var id any
	if len(debug) > 0 {
		id = debug[len(debug)-1]["id"]
	}
	if id == nil {
		id = last(attempts)["id"]
	}
	if id == nil {
		id = fmt.Sprintf("%s:%d", text(task["stage"]), number(task["round"]))
	}
	return map[string]any{"id": id, "stage": task["stage"], "summary": handoff["summary"], "explanation": emptyIfNil(handoff["details"], ""), "evidence": emptyIfNil(handoff["evidence"], []any{}), "required": emptyIfNil(handoff["risks"], []any{}), "options": emptyIfNil(handoff["options"], []any{}), "debugAttempts": len(debug), "resolved": false}
}

// RepositoryRef preserves the distinction between absent and explicit null
// when matching native sessions across repositories.
type RepositoryRef struct {
	Value   any
	Present bool
}

func sameRepositoryStrict(attempt map[string]any, reference RepositoryRef) bool {
	value, present := attempt["repositoryId"]
	return present == reference.Present && reflect.DeepEqual(value, reference.Value)
}

// Resumable returns the original specialist session, never a debugger session.
func Resumable(task map[string]any, stage, harness string, repository RepositoryRef) map[string]any {
	recovery := object(task["recovery"])
	if recovery["active"] == true {
		return nil
	}
	phase := text(recovery["phase"])
	continuing := phase == "continue" || phase == "retry_stage"
	runs := list(task["attempts"])
	var latest map[string]any
	for i := len(runs) - 1; i >= 0; i-- {
		a := object(runs[i])
		if a == nil || text(a["role"]) == "debug" || (text(a["role"]) == "verifier" && stage != "verify") || text(a["stage"]) != stage || text(a["harness"]) != harness || !sameRepositoryStrict(a, repository) {
			continue
		}
		if continuing && text(recovery["sourceAttemptId"]) != "" && !reflect.DeepEqual(a["id"], recovery["sourceAttemptId"]) {
			continue
		}
		latest = a
		break
	}
	if latest == nil || text(latest["sessionId"]) == "" {
		return nil
	}
	if continuing || latest["handoff"] == nil && (text(latest["status"]) == "failed" || text(latest["status"]) == "interrupted") {
		return latest
	}
	return nil
}

// Continuation summarizes the preserved specialist attempt and diagnosis.
func Continuation(task map[string]any, stage string, repository any) map[string]any {
	recovery := object(task["recovery"])
	phase := text(recovery["phase"])
	if (phase != "continue" && phase != "retry_stage") || text(recovery["key"]) != fmt.Sprintf("%s:%d", stage, index(task)) {
		return nil
	}
	runs := list(task["attempts"])
	var source map[string]any
	for i := len(runs) - 1; i >= 0; i-- {
		a := object(runs[i])
		if a == nil || text(a["role"]) == "debug" || text(a["role"]) == "verifier" || text(a["stage"]) != stage || !reflect.DeepEqual(a["repositoryId"], repository) {
			continue
		}
		if text(recovery["sourceAttemptId"]) != "" && !reflect.DeepEqual(a["id"], recovery["sourceAttemptId"]) {
			continue
		}
		source = a
		break
	}
	result := map[string]any{"completedWork": emptyIfNil(source["handoff"], nil), "filesPreserved": true}
	if value := source["id"]; value != nil {
		result["sourceAttemptId"] = value
	}
	if value := source["error"]; value != nil {
		result["interruption"] = value
	} else if value, exists := recovery["reason"]; exists {
		result["interruption"] = value
	}
	if value, exists := recovery["lastDiagnosis"]; exists {
		result["diagnosis"] = value
	}
	return result
}

type Harness struct {
	ID      string
	Enabled bool
}

// Harnesses keeps caller-provided configuration order during fallback.
func Harnesses(task map[string]any, configured string, harnesses []Harness) []string {
	recovery := object(task["recovery"])
	if recovery["active"] != true || number(recovery["attempts"]) < 2 {
		return []string{configured}
	}
	out := []string{}
	for _, h := range harnesses {
		if h.ID != configured && h.Enabled {
			out = append(out, h.ID)
		}
	}
	return append(out, configured)
}
