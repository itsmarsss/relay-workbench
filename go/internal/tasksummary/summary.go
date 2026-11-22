// Package tasksummary selects current runs and compact task list metadata.
// HTTP and assistant boundaries add authorization and live workflow evidence.
package tasksummary

import (
	"encoding/json"
	"errors"
	"net/url"
	"sort"
	"strconv"
	"time"
)

func object(v any) map[string]any { m, _ := v.(map[string]any); return m }
func array(v any) []any           { a, _ := v.([]any); return a }
func stringValue(v any) string    { s, _ := v.(string); return s }

// pullRequests lists one pull request per repository for the task list. A
// pull request Relay observed wins over a link the user added by hand.
func pullRequests(task map[string]any) []any {
	entries := array(task["repositories"])
	if len(entries) <= 1 {
		entries = []any{task}
	}
	result := []any{}
	for _, value := range entries {
		entry := object(value)
		record, manual := object(entry["publication"]), false
		if stringValue(record["url"]) == "" {
			record, manual = object(entry["pullRequestLink"]), true
		}
		link, err := url.Parse(stringValue(record["url"]))
		if record == nil || err != nil || (link.Scheme != "http" && link.Scheme != "https") || link.Hostname() == "" || link.User != nil {
			continue
		}
		number := stringValue(record["number"])
		if value, ok := record["number"].(float64); ok && value == float64(int64(value)) {
			number = strconv.FormatInt(int64(value), 10)
		}
		item := map[string]any{"url": link.String(), "number": number, "manual": manual}
		if repo := object(entry["repository"]); repo != nil {
			item["repositoryId"] = repo["id"]
		}
		for key, fallback := range map[string]string{"state": "unknown", "checks": "unknown", "review": "unknown", "checkedAt": ""} {
			item[key] = fallback
			if text := stringValue(record[key]); text != "" {
				item[key] = text
			}
		}
		if draft, ok := record["draft"].(bool); ok {
			item["draft"] = draft
		}
		// Relay's own pull request records when it was observed on the monitor, not on the record.
		if monitor := object(entry["publicationMonitor"]); item["checkedAt"] == "" && !manual && stringValue(monitor["status"]) == "complete" {
			item["checkedAt"] = stringValue(monitor["finishedAt"])
		}
		result = append(result, item)
	}
	return result
}
func Summarize(raw json.RawMessage) (map[string]any, error) {
	var task map[string]any
	if err := json.Unmarshal(raw, &task); err != nil || task == nil {
		return nil, errors.New("invalid task")
	}
	id, ok := task["id"].(string)
	if !ok || id == "" {
		return nil, errors.New("invalid task ID")
	}
	result := map[string]any{}
	for _, key := range []string{"id", "title", "status", "stage", "updatedAt", "error", "preset"} {
		if v, ok := task[key]; ok {
			result[key] = v
		}
	}
	if repo := object(task["repository"]); repo != nil {
		result["repository"] = map[string]any{"id": repo["id"], "name": repo["name"]}
	}
	runs := []map[string]any{}
	indexes := map[string]int{}
	add := func(run map[string]any) {
		if run == nil {
			return
		}
		id := stringValue(run["id"])
		if id != "" {
			if pos, exists := indexes[id]; exists {
				runs[pos] = run
				return
			}
			indexes[id] = len(runs)
		}
		runs = append(runs, run)
	}
	for _, value := range array(task["attempts"]) {
		add(object(value))
	}
	for _, value := range array(task["deliveryRuns"]) {
		add(object(value))
	}
	if current := object(task["currentRun"]); current != nil && stringValue(current["id"]) != "" {
		add(current)
	}
	entries := array(task["repositories"])
	if len(entries) <= 1 {
		entries = []any{task}
	}
	for _, value := range entries {
		entry := object(value)
		for _, kind := range []struct{ key, stage string }{{"delivery", "publish"}, {"publicationMonitor", "monitor"}} {
			record := object(entry[kind.key])
			if record == nil {
				continue
			}
			id := stringValue(record["id"])
			if id == "" {
				id = stringValue(record["attemptId"])
			}
			if id == "" || stringValue(record["startedAt"]) == "" {
				continue
			}
			if _, exists := indexes[id]; exists {
				continue
			}
			run := map[string]any{}
			for key, v := range record {
				run[key] = v
			}
			run["id"] = id
			run["stage"] = kind.stage
			if repo := object(entry["repository"]); repo != nil {
				run["repositoryId"] = repo["id"]
			}
			status := stringValue(record["status"])
			switch status {
			case "idle":
				status = "complete"
			case "unavailable":
				status = "failed"
			case "paused":
				status = "interrupted"
			}
			run["status"] = status
			text := stringValue(record["summary"])
			if text == "" {
				text = stringValue(record["error"])
			}
			handoff := map[string]any{"summary": text}
			if status == "blocked" {
				handoff["verdict"] = "blocked"
			}
			run["handoff"] = handoff
			add(run)
		}
	}
	filtered := runs[:0]
	for _, run := range runs {
		if stringValue(run["stage"]) != "monitor" {
			filtered = append(filtered, run)
		}
	}
	runs = filtered
	sort.SliceStable(runs, func(i, j int) bool {
		a, e1 := time.Parse(time.RFC3339Nano, stringValue(runs[i]["startedAt"]))
		b, e2 := time.Parse(time.RFC3339Nano, stringValue(runs[j]["startedAt"]))
		return e1 == nil && e2 == nil && a.Before(b)
	})
	var current map[string]any
	if len(runs) > 0 {
		current = runs[len(runs)-1]
	}
	for i := len(runs) - 1; i >= 0; i-- {
		run := runs[i]
		aux, _ := run["auxiliary"].(bool)
		if stringValue(run["status"]) == "running" && (aux || stringValue(task["status"]) == "running" || stringValue(task["status"]) == "queued") {
			current = run
			break
		}
	}
	if current != nil {
		safe := map[string]any{}
		for _, key := range []string{"id", "stage", "role", "auxiliary", "status", "harness", "model", "actualModel", "startedAt"} {
			if v, ok := current[key]; ok {
				safe[key] = v
			}
		}
		result["currentRun"] = safe
	}
	summary := ""
	if current != nil {
		if v, ok := current["summary"]; ok && v != nil {
			summary = stringValue(v)
		} else if h := object(current["handoff"]); h != nil {
			summary = stringValue(h["summary"])
		}
	}
	result["latestSummary"] = summary
	if links := pullRequests(task); len(links) > 0 {
		result["pullRequests"] = links
	}
	return result, nil
}
