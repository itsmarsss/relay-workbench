// Package task ports draft-task construction. It does not start workflows.
package task

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"relay.local/relay/internal/harness"
	"strings"
	"time"
	"unicode/utf16"
)

//go:embed defaults.json presets.json
var data embed.FS

func object(v any) map[string]any { m, _ := v.(map[string]any); return m }
func textValue(v any) string      { s, _ := v.(string); return s }
func clone(value any) (any, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var out any
	err = json.Unmarshal(raw, &out)
	return out, err
}
func trim(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return r >= 9 && r <= 13 || r == 0x20 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
	})
}
func checkedText(value any, label string, max int, optional bool) (string, error) {
	s, ok := value.(string)
	kind := "a nonempty"
	if optional {
		kind = "a"
	}
	if !ok || len(utf16.Encode([]rune(s))) > max || (!optional && trim(s) == "") {
		return "", fmt.Errorf("%s must be %s string of at most %d characters", label, kind, max)
	}
	return trim(s), nil
}
func Defaults() map[string]any {
	raw, err := data.ReadFile("defaults.json")
	if err != nil {
		panic(err)
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil {
		panic("invalid embedded defaults")
	}
	return value
}
func preset(id string) (map[string]any, bool) {
	raw, err := data.ReadFile("presets.json")
	if err != nil {
		panic(err)
	}
	var values []map[string]any
	if json.Unmarshal(raw, &values) != nil {
		panic("invalid embedded presets")
	}
	for _, v := range values {
		if textValue(v["id"]) == id {
			return v, true
		}
	}
	return nil, false
}
func uuid() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	s := hex.EncodeToString(raw)
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:], nil
}
func command(value any) (map[string]any, error) {
	v := object(value)
	if v == nil {
		return nil, errors.New("Command must be an object")
	}
	name, err := checkedText(v["command"], "Executable", 1000, false)
	if err != nil {
		return nil, err
	}
	args, ok := v["args"].([]any)
	if !ok || len(args) > 100 {
		return nil, errors.New("Command args must be an array of strings")
	}
	for _, arg := range args {
		s, ok := arg.(string)
		if !ok || len(utf16.Encode([]rune(s))) >= 20000 {
			return nil, errors.New("Command args must be an array of strings")
		}
	}
	return map[string]any{"command": name, "args": args}, nil
}
func selectedOptions(raw, config map[string]any) (map[string]any, error) {
	configRouting := object(config["routing"])
	if len(configRouting) == 0 {
		return nil, errors.New("invalid configured routing")
	}
	routing := map[string]any{}
	for k, v := range configRouting {
		routing[k] = v
	}
	if value := raw["routing"]; value != nil {
		overrides := object(value)
		if overrides == nil {
			return nil, errors.New("Invalid harness routing")
		}
		for k, v := range overrides {
			if _, exists := configRouting[k]; !exists {
				return nil, errors.New("Invalid harness routing")
			}
			routing[k] = v
		}
	}
	for _, value := range routing {
		provider := textValue(value)
		if provider != "codex" && provider != "claude" && provider != "pi" {
			return nil, errors.New("Invalid harness routing")
		}
	}
	models := map[string]any{}
	if value := raw["models"]; value != nil {
		v := object(value)
		if v == nil {
			return nil, errors.New("Invalid stage models")
		}
		for stage, model := range v {
			if _, ok := configRouting[stage]; !ok {
				return nil, errors.New("Invalid stage models")
			}
			m, err := checkedText(model, "Model", 200, true)
			if err != nil {
				return nil, err
			}
			models[stage] = m
		}
	}
	efforts := map[string]any{}
	if raw["efforts"] != nil {
		incoming := object(raw["efforts"])
		if incoming == nil {
			return nil, errors.New("Invalid stage efforts")
		}
		for stage, value := range incoming {
			if _, ok := routing[stage]; !ok {
				return nil, errors.New("Invalid stage efforts")
			}
			effort, ok := value.(string)
			if !ok {
				return nil, errors.New("Invalid stage effort")
			}
			_, normalized, err := harness.Options(textValue(routing[stage]), "", effort)
			if err != nil {
				return nil, err
			}
			efforts[stage] = normalized
		}
	}
	execution := map[string]any{}
	if value := raw["execution"]; value != nil {
		v := object(value)
		if v == nil {
			return nil, errors.New("Invalid execution settings")
		}
		for k, val := range v {
			if k != "timeoutMinutes" && k != "maxRepairRounds" && k != "maxRecoveryAttempts" {
				return nil, errors.New("Invalid execution settings")
			}
			execution[k] = val
		}
	}
	limits := []struct {
		key      string
		min, max int
	}{{"timeoutMinutes", 1, 240}, {"maxRepairRounds", 1, 10}, {"maxRecoveryAttempts", 0, 5}}
	for _, limit := range limits {
		v := execution[limit.key]
		if v == nil {
			v = config[limit.key]
		}
		num, ok := v.(float64)
		if !ok || math.Trunc(num) != num || num < float64(limit.min) || num > float64(limit.max) {
			return nil, fmt.Errorf("%s must be between %d and %d", limit.key, limit.min, limit.max)
		}
		execution[limit.key] = num
	}
	if value, exists := raw["smartRouting"]; exists {
		if _, ok := value.(bool); !ok {
			return nil, errors.New("Smart routing must be a boolean")
		}
	}
	result := map[string]any{"routing": routing, "models": models, "execution": execution}
	if raw["efforts"] != nil {
		result["efforts"] = efforts
	}
	return result, nil
}
func applySettings(entries []map[string]any, value any) error {
	if value == nil {
		return nil
	}
	settings, ok := value.([]any)
	if !ok || len(settings) > 12 {
		return errors.New("Invalid repository settings")
	}
	seen := map[string]bool{}
	for _, item := range settings {
		setting := object(item)
		if setting == nil {
			return errors.New("Invalid task repository settings")
		}
		for key := range setting {
			if key != "id" && key != "cwd" && key != "checks" && key != "setup" && key != "instructions" && key != "verificationMode" {
				return errors.New("Invalid task repository settings")
			}
		}
		id := textValue(setting["id"])
		var repo map[string]any
		for _, entry := range entries {
			candidate := object(entry["repository"])
			if textValue(candidate["id"]) == id {
				repo = candidate
				break
			}
		}
		if repo == nil || seen[id] {
			return errors.New("Repository settings must match distinct selected repositories")
		}
		seen[id] = true
		for _, field := range []struct {
			key, label string
			max        int
			optional   bool
		}{{"cwd", "Working subdirectory", 2000, false}, {"instructions", "Repository instructions", 50000, true}} {
			if v, exists := setting[field.key]; exists {
				value, err := checkedText(v, field.label, field.max, field.optional)
				if err != nil {
					return err
				}
				repo[field.key] = value
			}
		}
		if v, exists := setting["verificationMode"]; exists {
			if v != "agent" && v != "commands" {
				return errors.New("Invalid verification mode")
			}
			repo["verificationMode"] = v
		}
		for _, key := range []string{"checks", "setup"} {
			if v, exists := setting[key]; exists {
				commands, ok := v.([]any)
				if !ok || len(commands) > 30 {
					return errors.New("Too many repository commands")
				}
				normalized := make([]any, 0, len(commands))
				for _, item := range commands {
					c, err := command(item)
					if err != nil {
						return err
					}
					normalized = append(normalized, c)
				}
				repo[key] = normalized
			}
		}
	}
	return nil
}

type edge struct{ repository, dependsOn string }

// NewTask creates an isolated draft using a validated configuration. It never
// runs repository commands or starts a workflow.
func NewTask(raw, config map[string]any, now time.Time) (map[string]any, error) {
	if raw == nil || config == nil {
		return nil, errors.New("task and configuration are required")
	}
	presetID := ""
	presetProvided := raw["preset"] != nil
	if v := raw["preset"]; v != nil {
		id, ok := v.(string)
		if !ok {
			return nil, errors.New("Choose a supported workflow preset")
		}
		presetID = id
	}
	guidance := ""
	if presetProvided {
		p, ok := preset(presetID)
		if !ok {
			return nil, errors.New("Choose a supported workflow preset")
		}
		guidance = textValue(p["guidance"])
	}
	demo := raw["demo"] == true
	profiles, ok := config["repositories"].([]any)
	if !ok {
		return nil, errors.New("invalid configured repositories")
	}
	byID := map[string]map[string]any{}
	for _, v := range profiles {
		p := object(v)
		id := textValue(p["id"])
		if p == nil || id == "" || byID[id] != nil {
			return nil, errors.New("invalid configured repositories")
		}
		byID[id] = p
	}
	primary := textValue(raw["repositoryId"])
	ids := []any{}
	if value := raw["repositoryIds"]; value != nil {
		var ok bool
		ids, ok = value.([]any)
		if !ok {
			return nil, errors.New("Select at most 12 repositories")
		}
	} else if byID[primary] != nil {
		ids = []any{primary}
	}
	if len(ids) > 12 {
		return nil, errors.New("Select at most 12 repositories")
	}
	if !demo && len(ids) == 0 {
		return nil, errors.New("Select a configured repository")
	}
	seen := map[string]bool{}
	entries := make([]map[string]any, 0, len(ids))
	for _, value := range ids {
		id, ok := value.(string)
		if !ok {
			return nil, errors.New("Select at most 12 repositories")
		}
		if seen[id] {
			return nil, errors.New("Duplicate task repositories")
		}
		seen[id] = true
		profile := byID[id]
		if profile == nil {
			return nil, errors.New("Unknown task repository")
		}
		copied, err := clone(profile)
		if err != nil {
			return nil, err
		}
		entries = append(entries, map[string]any{"repository": copied, "workspace": nil, "baseCommit": nil, "branch": nil})
	}
	if primary != "" && !seen[primary] {
		return nil, errors.New("Primary repository must be selected")
	}
	if settings, exists := raw["repositorySettings"]; exists && settings == nil {
		return nil, errors.New("Invalid repository settings")
	}
	if err := applySettings(entries, raw["repositorySettings"]); err != nil {
		return nil, err
	}
	options, err := selectedOptions(raw, config)
	if err != nil {
		return nil, err
	}
	dependencies := []any{}
	if value := raw["dependencies"]; value != nil {
		var ok bool
		dependencies, ok = value.([]any)
		if !ok || len(dependencies) > 132 {
			return nil, errors.New("Invalid repository dependencies")
		}
	}
	edges := []edge{}
	edgeSet := map[edge]bool{}
	for _, value := range dependencies {
		v := object(value)
		r, d := textValue(v["repositoryId"]), textValue(v["dependsOn"])
		if v == nil || !seen[r] || !seen[d] || r == d {
			return nil, errors.New("Dependencies must connect distinct selected repositories")
		}
		e := edge{r, d}
		if edgeSet[e] {
			return nil, errors.New("Duplicate dependencies")
		}
		edgeSet[e] = true
		edges = append(edges, e)
	}
	ordered := []any{}
	done := map[string]bool{}
	for len(ordered) < len(entries) {
		var next map[string]any
		for _, entry := range entries {
			id := textValue(object(entry["repository"])["id"])
			if done[id] {
				continue
			}
			ready := true
			for _, e := range edges {
				if e.repository == id && !done[e.dependsOn] {
					ready = false
					break
				}
			}
			if ready {
				next = entry
				break
			}
		}
		if next == nil {
			return nil, errors.New("Repository dependencies contain a cycle")
		}
		done[textValue(object(next["repository"])["id"])] = true
		ordered = append(ordered, next)
	}
	title, err := checkedText(raw["title"], "Title", 240, false)
	if err != nil {
		return nil, err
	}
	description := raw["description"]
	if description == nil {
		description = ""
	}
	desc, err := checkedText(description, "Description", 50000, true)
	if err != nil {
		return nil, err
	}
	ticket := raw["ticket"]
	if ticket == nil {
		ticket = ""
	}
	ref, err := checkedText(ticket, "Ticket", 2000, true)
	if err != nil {
		return nil, err
	}
	id, err := uuid()
	if err != nil {
		return nil, err
	}
	var repo map[string]any
	if demo {
		repo = map[string]any{"id": "demo", "name": "Example service", "path": "", "cwd": ".", "strategy": "worktree", "checks": []any{}, "setup": []any{}, "instructions": ""}
		ordered = []any{}
	} else {
		for _, entry := range entries {
			p := object(entry["repository"])
			if textValue(p["id"]) == primary {
				repo = p
				break
			}
		}
		if repo == nil {
			repo = object(entries[0]["repository"])
		}
		v, err := clone(repo)
		if err != nil {
			return nil, err
		}
		repo = object(v)
	}
	var presetValue any
	if presetID != "" {
		presetValue = presetID
	}
	created := now.UTC().Format("2006-01-02T15:04:05.000Z")
	deps, err := clone(dependencies)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"repositories": ordered, "dependencies": deps, "repositoryCursor": 0, "preset": presetValue, "workflowGuidance": guidance, "id": id, "title": title, "description": desc, "ticket": ref, "demo": demo, "repository": repo, "routing": options["routing"], "models": options["models"], "execution": options["execution"], "configRevision": 0, "smartRouting": raw["smartRouting"] == true, "status": "draft", "stage": "triage", "round": 0, "attempts": []any{}, "approvals": []any{}, "messages": []any{}, "workspace": nil, "baseCommit": nil, "branch": nil, "chosenApproach": nil, "reviewedFingerprint": nil, "createdAt": created, "updatedAt": created, "error": nil}
	if options["efforts"] != nil {
		result["efforts"] = options["efforts"]
	}
	return result, nil
}
