// Package insights derives observations from recorded workflow evidence.
package insights

import (
	"encoding/json"
	"math"
	"sort"
	"time"
)

func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func arr(v any) []any          { a, _ := v.([]any); return a }
func str(v any) string         { s, _ := v.(string); return s }

var stages = []string{"triage", "investigate", "plan", "implement", "review"}

type Outcome struct {
	Stage           string   `json:"stage"`
	Harness         string   `json:"harness"`
	Model           any      `json:"model"`
	Attempts        int      `json:"attempts"`
	Settled         int      `json:"settled"`
	Successful      int      `json:"successful"`
	Failed          int      `json:"failed"`
	Interrupted     int      `json:"interrupted"`
	Pending         int      `json:"pending"`
	ReviewFindings  int      `json:"reviewFindings"`
	Tasks           int      `json:"tasks"`
	AcceptedTasks   int      `json:"acceptedTasks"`
	MedianMS        *float64 `json:"medianMs"`
	P90MS           *float64 `json:"p90Ms"`
	SuccessRate     *float64 `json:"successRate"`
	ConfidenceLower float64  `json:"confidenceLower"`
	Eligible        bool     `json:"eligible"`
	durations       []float64
	taskIDs         map[string]bool
	acceptedIDs     map[string]bool
}

func percentile(values []float64, fraction float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	sort.Float64s(values)
	v := values[int(math.Ceil(float64(len(values))*fraction))-1]
	return &v
}
func lowerBound(successes, count int) float64 {
	if count == 0 {
		return 0
	}
	z := 1.96
	n := float64(count)
	p := float64(successes) / n
	return (p + z*z/(2*n) - z*math.Sqrt((p*(1-p)+z*z/(4*n))/n)) / (1 + z*z/n)
}
func Outcomes(tasks []map[string]any, config map[string]any, repositoryID string) map[string]any {
	groups := map[string]*Outcome{}
	rows := []*Outcome{}
	for _, task := range tasks {
		if task["demo"] == true {
			continue
		}
		entries := arr(task["repositories"])
		if len(entries) == 0 {
			entries = []any{task}
		}
		if repositoryID != "" {
			found := false
			for _, entry := range entries {
				if obj(obj(entry)["repository"])["id"] == repositoryID {
					found = true
				}
			}
			if !found {
				continue
			}
		}
		attempts := arr(task["attempts"])
		for index, item := range attempts {
			attempt := obj(item)
			stage, provider := str(attempt["stage"]), str(attempt["harness"])
			valid := false
			for _, s := range stages {
				if stage == s {
					valid = true
				}
			}
			if !valid || provider != "codex" && provider != "claude" && provider != "pi" || stage == "triage" && task["smartRouting"] != true {
				continue
			}
			if repositoryID != "" && str(attempt["repositoryId"]) != "" && attempt["repositoryId"] != repositoryID {
				continue
			}
			var model any
			if known, ok := attempt["model"].(string); ok {
				model = known
			}
			keyRaw, _ := json.Marshal([]any{stage, provider, model})
			key := string(keyRaw)
			group := groups[key]
			if group == nil {
				group = &Outcome{Stage: stage, Harness: provider, Model: model, taskIDs: map[string]bool{}, acceptedIDs: map[string]bool{}}
				groups[key] = group
				rows = append(rows, group)
			}
			group.Attempts++
			group.taskIDs[str(task["id"])] = true
			if task["status"] == "completed" {
				group.acceptedIDs[str(task["id"])] = true
			}
			started, e1 := time.Parse(time.RFC3339Nano, str(attempt["startedAt"]))
			finished, e2 := time.Parse(time.RFC3339Nano, str(attempt["finishedAt"]))
			if e1 == nil && e2 == nil && !finished.Before(started) {
				group.durations = append(group.durations, float64(finished.Sub(started).Milliseconds()))
			}
			handoff := obj(attempt["handoff"])
			group.ReviewFindings += len(arr(handoff["findings"]))
			if attempt["status"] == "interrupted" {
				group.Interrupted++
				continue
			}
			if attempt["status"] == "running" {
				group.Pending++
				continue
			}
			success := attempt["status"] == "complete" && handoff["verdict"] == "complete"
			if stage == "review" {
				success = attempt["status"] == "complete" && (handoff["verdict"] == "complete" || handoff["verdict"] == "changes_requested")
			}
			if success && stage == "implement" {
				var verification, review map[string]any
				for _, nextItem := range attempts[index+1:] {
					next := obj(nextItem)
					if next["stage"] == "implement" && next["repositoryId"] == attempt["repositoryId"] {
						break
					}
					if verification == nil && next["stage"] == "verify" && next["status"] != "running" {
						verification = next
					}
					if review == nil && next["stage"] == "review" && next["repositoryId"] == attempt["repositoryId"] && next["status"] != "running" {
						review = next
					}
				}
				if verification == nil || obj(verification["handoff"])["verdict"] == "complete" && review == nil {
					group.Pending++
					continue
				}
				success = verification["status"] == "complete" && obj(verification["handoff"])["verdict"] == "complete" && review != nil && review["status"] == "complete" && obj(review["handoff"])["verdict"] == "complete"
			}
			group.Settled++
			if success {
				group.Successful++
			} else {
				group.Failed++
			}
		}
	}
	for _, group := range rows {
		group.Tasks = len(group.taskIDs)
		group.AcceptedTasks = len(group.acceptedIDs)
		group.MedianMS = percentile(group.durations, .5)
		group.P90MS = percentile(group.durations, .9)
		if group.Settled > 0 {
			rate := float64(group.Successful) / float64(group.Settled)
			group.SuccessRate = &rate
		}
		group.ConfidenceLower = lowerBound(group.Successful, group.Settled)
		provider := obj(obj(config["harnesses"])[group.Harness])
		configuredModel := provider["model"]
		if configuredModel == nil {
			configuredModel = ""
		}
		group.Eligible = provider["enabled"] == true && group.Model != nil && group.Model != "" && group.Model == configuredModel && group.Settled >= 3 && group.Tasks >= 2
	}
	recommendations := []map[string]any{}
	for _, stage := range stages {
		candidates := []*Outcome{}
		for _, group := range rows {
			if group.Stage == stage && group.Eligible {
				candidates = append(candidates, group)
			}
		}
		sort.SliceStable(candidates, func(i, j int) bool {
			a, b := candidates[i], candidates[j]
			if a.ConfidenceLower != b.ConfidenceLower {
				return a.ConfidenceLower > b.ConfidenceLower
			}
			if a.MedianMS == nil {
				return false
			}
			return b.MedianMS == nil || *a.MedianMS < *b.MedianMS
		})
		if len(candidates) > 0 {
			best := candidates[0]
			recommendations = append(recommendations, map[string]any{"stage": stage, "harness": best.Harness, "model": best.Model, "samples": best.Settled, "alternatives": len(candidates), "confidenceLower": best.ConfidenceLower})
		}
	}
	return map[string]any{"repositoryId": repositoryID, "rows": rows, "recommendations": recommendations, "minimumSamples": 3, "minimumTasks": 2, "notes": "Observational evidence, not a controlled comparison. Difficulty, task mix, reviewer strictness, configuration and provider defaults can affect results. Implementation success requires passing checks and clean review before the next implementation. Interrupted attempts are excluded. Review success counts usable structured reviews, including actionable findings; finding defects does not penalize a reviewer. Unknown historical models are never recommended. No routing changes are automatic."}
}
