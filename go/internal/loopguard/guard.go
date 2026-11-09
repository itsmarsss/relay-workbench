// Package loopguard ports the repeated-failure guard. It is not wired to a runner.
package loopguard

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
)

const Guidance = "This exact failure already occurred on unchanged source. Read the prior command results, test a different supported hypothesis, and reuse passing checks. Do not rerun the same failed sequence without new evidence."

func object(v any) map[string]any { m, _ := v.(map[string]any); return m }
func array(v any) []any           { a, _ := v.([]any); return a }
func str(v any) string            { s, _ := v.(string); return s }
func failure(v any) bool {
	value, ok := v.(string)
	return ok && (value == "blocked" || value == "changes_requested")
}
func normalize(v any) (string, bool) {
	value, ok := v.(string)
	if !ok {
		return "", false
	}
	value = strings.TrimFunc(value, func(r rune) bool {
		return r >= 9 && r <= 13 || r == 0x20 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
	})
	// Avoid false matches from differences between Go and JavaScript Unicode case folding.
	for _, r := range value {
		if r > 127 {
			return value, true
		}
	}
	return strings.ToLower(value), true
}
func evidence(v any) ([]any, bool) {
	if v == nil {
		return []any{}, true
	}
	values, ok := v.([]any)
	if !ok {
		return nil, false
	}
	for _, value := range values {
		if _, ok := value.(string); !ok {
			return nil, false
		}
	}
	return values, true
}
func repo(v map[string]any) any { return v["repositoryId"] }

// Apply flags only identical failures; malformed evidence is not treated as a match.
// Callers must validate handoffs before using the result.
func Apply(task, attempt map[string]any) bool {
	h := object(attempt["handoff"])
	fingerprint := str(attempt["fingerprint"])
	if h == nil || !failure(h["verdict"]) || fingerprint == "" || fingerprint == "demo" {
		return false
	}
	targetEvidence, valid := evidence(h["evidence"])
	targetSummary, summaryValid := normalize(h["summary"])
	if !valid || !summaryValid {
		return false
	}
	attempts := array(task["attempts"])
	start := 0
	if n, ok := task["loopGuardAcknowledgedAt"].(float64); ok {
		if math.IsNaN(n) {
			start = 0
		} else if n >= float64(len(attempts)) {
			start = len(attempts)
		} else if n <= -float64(len(attempts)) {
			start = 0
		} else {
			start = int(n)
			if start < 0 {
				start += len(attempts)
			}
		}
	}
	previous := []map[string]any{}
	for _, item := range attempts[start:] {
		run := object(item)
		prior := object(run["handoff"])
		if run == nil || prior == nil || !reflect.DeepEqual(run["stage"], attempt["stage"]) || !reflect.DeepEqual(repo(run), repo(attempt)) || !failure(prior["verdict"]) || str(run["fingerprint"]) != fingerprint {
			continue
		}
		priorSummary, summaryValid := normalize(prior["summary"])
		priorEvidence, valid := evidence(prior["evidence"])
		if !summaryValid || !valid || priorSummary != targetSummary || !reflect.DeepEqual(priorEvidence, targetEvidence) {
			continue
		}
		previous = append(previous, run)
	}
	if len(previous) < 2 {
		return false
	}
	stopped := len(previous) >= 3
	entries := make([]any, 0, len(previous))
	allEvidence := []any{}
	for _, run := range previous {
		r := object(run["handoff"])
		items, _ := evidence(r["evidence"])
		entries = append(entries, map[string]any{"id": run["id"], "summary": r["summary"], "evidence": items})
		allEvidence = append(allEvidence, items...)
	}
	task["loopGuard"] = map[string]any{"count": len(previous), "stopped": stopped, "sourceAttemptId": attempt["id"], "guidance": Guidance, "evidence": entries}
	if stopped {
		task["status"] = "blocked"
		if recovery := object(task["recovery"]); recovery != nil {
			recovery["active"] = false
		}
		task["error"] = "Repeated failure on unchanged source after recovery attempts."
		if task["blockerDecision"] == nil {
			if len(allEvidence) > 12 {
				allEvidence = allEvidence[len(allEvidence)-12:]
			}
			task["blockerDecision"] = map[string]any{"id": attempt["id"], "kind": "loop_guard", "summary": task["error"], "explanation": Guidance, "evidence": allEvidence, "required": []any{"Choose a revised approach or supply new diagnostic direction before retrying."}, "options": []any{}, "resolved": false}
		}
	}
	return true
}

// Decode is a narrow helper for differential tests and copied fixtures.
func Decode(raw []byte) (map[string]any, error) {
	var result map[string]any
	err := json.Unmarshal(raw, &result)
	return result, err
}
