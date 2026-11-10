package insights

import (
	"encoding/json"
	"time"

	"relay.local/relay/internal/tasksummary"
)

// Health reports recorded progress, never a completion estimate. Repeated
// identical output and transcript heartbeats do not reset its quiet clock.
func Health(task map[string]any, events []json.RawMessage, now time.Time) map[string]any {
	raw, _ := json.Marshal(task)
	summary, err := tasksummary.Summarize(raw)
	if err != nil {
		return map[string]any{"state": "unknown", "summary": "Task state unavailable", "quiet": false}
	}
	run := obj(summary["currentRun"])
	if run["status"] != "running" || run["auxiliary"] != true && task["status"] != "running" {
		descriptions := map[string]string{"queued": "Waiting for an available agent or workspace", "awaiting_plan": "Waiting for an approach", "awaiting_final": "Waiting for final review", "paused": "Paused", "blocked": "Waiting for a blocker resolution", "interrupted": "Waiting to resume interrupted work", "manual": "You have terminal control"}
		return map[string]any{"state": task["status"], "summary": descriptions[str(task["status"])], "quiet": false}
	}
	started, _ := time.Parse(time.RFC3339Nano, str(run["startedAt"]))
	last := started
	operation := "Waiting for first output"
	signature := ""
	checks := []any{}
	for _, raw := range events {
		var event map[string]any
		if json.Unmarshal(raw, &event) != nil {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, str(event["at"]))
		if err != nil || at.Before(started) || event["attemptId"] != run["id"] || event["type"] != "activity" && event["type"] != "check_evidence" {
			continue
		}
		sig, _ := json.Marshal([]any{event["type"], event["kind"], event["summary"], event["details"], event["repositoryId"], event["checks"]})
		if string(sig) == signature {
			continue
		}
		signature = string(sig)
		if at.After(last) {
			last = at
		}
		operation = str(event["summary"])
		if operation == "" {
			operation = str(event["details"])
		}
		if operation == "" {
			operation = "Agent is working"
		}
		if len(operation) > 240 {
			operation = string([]rune(operation)[:min(len([]rune(operation)), 240)])
		}
		if event["type"] == "check_evidence" {
			checks = arr(event["checks"])
		}
	}
	waiting, running := 0, 0
	for _, item := range checks {
		switch obj(item)["status"] {
		case "waiting":
			waiting++
		case "running":
			running++
		}
	}
	quiet := !last.IsZero() && now.Sub(last) >= 10*time.Minute
	state, message := "working", operation
	var waitingOn any
	if waiting > 0 {
		state = "waiting_resource"
		waitingOn = "Verification resources"
	} else if running > 0 {
		state = "checking"
		waitingOn = "Running checks"
	}
	if quiet {
		state = "quiet"
		message = "No recent output · inspect the last operation"
	} else if waitingOn != nil {
		message = str(waitingOn) + " · " + operation
	}
	var lastAt any
	if !last.IsZero() {
		lastAt = last.UTC().Format(time.RFC3339Nano)
	} else {
		lastAt = run["startedAt"]
	}
	return map[string]any{"state": state, "waitingOn": waitingOn, "quiet": quiet, "attemptId": run["id"], "lastAt": lastAt, "operation": operation, "summary": message, "quietAfterMs": 600000}
}
