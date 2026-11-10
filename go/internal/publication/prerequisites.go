package publication

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
)

func object(value any) map[string]any { result, _ := value.(map[string]any); return result }
func array(value any) []any           { result, _ := value.([]any); return result }
func text(value any) string           { result, _ := value.(string); return result }

// Prerequisites enforces the user's repository dependency order without
// assuming a hosting provider or publication command.
func Prerequisites(task map[string]any, repositoryID string) error {
	if task == nil || repositoryID == "" || task["preset"] == "investigate" {
		return errors.New("this task cannot publish")
	}
	entries := array(task["repositories"])
	if len(entries) <= 1 {
		entries = []any{task}
	}
	byID := map[string]map[string]any{}
	for _, item := range entries {
		entry := object(item)
		id := text(object(entry["repository"])["id"])
		if id == "" || byID[id] != nil {
			return errors.New("invalid task repositories")
		}
		byID[id] = entry
	}
	if byID[repositoryID] == nil {
		return errors.New("select a task repository")
	}
	waiting := []string{}
	dependencies := array(task["dependencies"])
	if task["dependencies"] != nil && dependencies == nil {
		return errors.New("invalid repository dependencies")
	}
	for _, item := range dependencies {
		edge := object(item)
		if edge == nil || byID[text(edge["repositoryId"])] == nil || byID[text(edge["dependsOn"])] == nil || text(edge["repositoryId"]) == text(edge["dependsOn"]) {
			return errors.New("invalid repository dependency")
		}
		if text(edge["repositoryId"]) != repositoryID {
			continue
		}
		dependency := byID[text(edge["dependsOn"])]
		if dependency == nil {
			return errors.New("publication prerequisite is missing")
		}
		state := object(dependency["publication"])
		link, err := url.Parse(text(state["url"]))
		validURL := err == nil && link != nil && (link.Scheme == "http" || link.Scheme == "https") && link.Hostname() != "" && link.User == nil
		if !validURL || (text(state["state"]) != "open" && text(state["state"]) != "merged") {
			name := text(object(dependency["repository"])["name"])
			if name == "" {
				name = "repository"
			}
			waiting = append(waiting, name)
		}
	}
	if len(waiting) > 0 {
		return fmt.Errorf("publish prerequisite repositories first: %s", strings.Join(waiting, ", "))
	}
	return nil
}
