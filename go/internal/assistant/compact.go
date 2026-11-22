package assistant

import (
	"encoding/json"
	"strings"
)

// Agent CLIs cap a tool result well below a stored task: full attempts carry transcripts and
// handoffs, and a long task's record passes 500K characters. These views keep what an agent needs
// to answer about a task (state, pull requests, workspaces, recent runs and their summaries) and
// leave the rest to the dedicated history, changes and activity tools.

const (
	compactAttempts = 10
	compactText     = 1200
)

func clip(value any, limit int) string {
	s := strings.TrimSpace(text(value))
	if runes := []rune(s); len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return s
}

func pick(source map[string]any, keys ...string) map[string]any {
	out := map[string]any{}
	for _, key := range keys {
		if value, ok := source[key]; ok && value != nil && value != "" {
			out[key] = value
		}
	}
	return out
}

// compactRepository keeps a repository entry's workspace and pull request state.
func compactRepository(entry map[string]any) map[string]any {
	out := pick(entry, "branch", "baseCommit", "workspaceRoot", "workspaceHead", "setupCompleted", "workspaceCleanup", "branchUpdate")
	if repo := obj(entry["repository"]); repo != nil {
		out["repository"] = pick(repo, "id", "name", "path", "strategy")
	}
	for _, key := range []string{"publication", "pullRequestLink"} {
		if pr := obj(entry[key]); pr != nil {
			out[key] = pick(pr, "url", "number", "title", "state", "draft", "checks", "review", "checkedAt")
		}
	}
	if monitor := obj(entry["publicationMonitor"]); monitor != nil {
		out["publicationMonitor"] = pick(monitor, "enabled", "status", "summary", "finishedAt", "nextCheckAt")
	}
	if delivery := obj(entry["delivery"]); delivery != nil {
		out["delivery"] = map[string]any{"status": delivery["status"], "phase": delivery["phase"], "summary": clip(delivery["summary"], compactText)}
	}
	if feedback, ok := entry["feedback"].([]any); ok && len(feedback) > 0 {
		out["feedbackCount"] = len(feedback)
	}
	return out
}

func compactRun(run map[string]any) map[string]any {
	out := pick(run, "id", "stage", "role", "status", "harness", "model", "startedAt", "finishedAt", "relation")
	if handoff := obj(run["handoff"]); handoff != nil {
		out["verdict"] = handoff["verdict"]
		out["summary"] = clip(handoff["summary"], compactText)
	} else if summary := clip(run["summary"], compactText); summary != "" {
		out["summary"] = summary
	}
	if failure := clip(run["error"], 600); failure != "" {
		out["error"] = failure
	}
	return out
}

// compactTask is a task as an agent reads it: everything needed to explain its state, without
// transcripts. `omitted` says what was left out and which tool reads it.
func compactTask(value map[string]any) map[string]any {
	out := pick(value, "id", "title", "status", "stage", "preset", "ticket", "demo", "createdAt", "updatedAt", "statusOverride", "taskRevision", "routing", "health")
	out["description"] = clip(value["description"], 3000)
	if failure := clip(value["error"], compactText); failure != "" {
		out["error"] = failure
	}
	if approach := obj(value["chosenApproach"]); approach != nil {
		out["chosenApproach"] = map[string]any{"id": approach["id"], "title": approach["title"]}
	}
	approvals := []any{}
	for _, item := range array(value["approvals"]) {
		a := obj(item)
		approvals = append(approvals, pick(a, "type", "at", "repositoryId"))
	}
	out["approvals"] = approvals
	entries := array(value["repositories"])
	if len(entries) <= 1 {
		entries = []any{value}
	}
	repositories := []any{}
	for _, item := range entries {
		repositories = append(repositories, compactRepository(obj(item)))
	}
	out["repositories"] = repositories
	attempts := array(value["attempts"])
	runs := []any{}
	start := 0
	if len(attempts) > compactAttempts {
		start = len(attempts) - compactAttempts
	}
	for _, item := range attempts[start:] {
		runs = append(runs, compactRun(obj(item)))
	}
	out["recentAttempts"] = runs
	delivery := array(value["deliveryRuns"])
	if len(delivery) > 4 {
		delivery = delivery[len(delivery)-4:]
	}
	deliveryRuns := []any{}
	for _, item := range delivery {
		deliveryRuns = append(deliveryRuns, compactRun(obj(item)))
	}
	out["recentDeliveryRuns"] = deliveryRuns
	messages := array(value["messages"])
	if len(messages) > 5 {
		messages = messages[len(messages)-5:]
	}
	direction := []any{}
	for _, item := range messages {
		m := obj(item)
		direction = append(direction, map[string]any{"at": m["at"], "role": m["role"], "text": clip(m["text"], 600)})
	}
	out["recentDirection"] = direction
	out["omitted"] = map[string]any{
		"olderAttempts": start,
		"note":          "Transcripts, full handoffs and evidence are left out. Use read_task_history, read_task_changes or read_task_activity for them.",
	}
	return out
}

// compactActivity keeps the events a person would read (state changes, handoffs, decisions,
// failures) and drops streamed agent output, newest first.
func compactActivity(rows []json.RawMessage, limit int) []any {
	out := []any{}
	for i := len(rows) - 1; i >= 0 && len(out) < limit; i-- {
		var event map[string]any
		if json.Unmarshal(rows[i], &event) != nil {
			continue
		}
		if event["stream"] != nil || (text(event["summary"]) == "" && text(event["details"]) == "" && text(event["error"]) == "") {
			continue
		}
		row := pick(event, "at", "type", "kind", "stage", "source", "harness", "repositoryId")
		row["summary"] = clip(event["summary"], 600)
		if details := clip(event["details"], 600); details != "" {
			row["details"] = details
		}
		if failure := clip(event["error"], 400); failure != "" {
			row["error"] = failure
		}
		out = append(out, row)
	}
	return out
}
