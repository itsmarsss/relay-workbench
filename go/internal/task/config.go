package task

import (
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"relay.local/relay/internal/harness"
	"strings"
	"unicode/utf16"
)

func nullish(value, fallback any) any {
	if value == nil {
		return fallback
	}
	return value
}
func truthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case float64:
		return v != 0 && !math.IsNaN(v)
	default:
		return true
	}
}
func commandList(value any) ([]any, error) {
	if value == nil {
		return []any{}, nil
	}
	items, ok := value.([]any)
	if !ok {
		return nil, errors.New("Invalid repository commands")
	}
	if len(items) > 30 {
		return nil, errors.New("Too many commands")
	}
	result := make([]any, 0, len(items))
	for _, item := range items {
		v, err := command(item)
		if err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	return result, nil
}

// ValidateConfig normalizes local configuration; it does not inspect paths or
// execute commands. All writes must be authenticated by the caller.
func ValidateConfig(raw map[string]any) (map[string]any, error) {
	if raw == nil {
		return nil, errors.New("Configuration must be an object")
	}
	config := Defaults()
	for _, limit := range []struct {
		key      string
		min, max int
	}{{"concurrency", 1, 8}, {"maxRepairRounds", 1, 10}, {"maxRecoveryAttempts", 0, 5}, {"timeoutMinutes", 1, 240}} {
		v := nullish(raw[limit.key], config[limit.key])
		n, ok := v.(float64)
		if !ok || math.Trunc(n) != n || n < float64(limit.min) || n > float64(limit.max) {
			return nil, fmt.Errorf("%s must be between %d and %d", limit.key, limit.min, limit.max)
		}
		config[limit.key] = n
	}
	harnesses := object(config["harnesses"])
	incoming := object(raw["harnesses"])
	for _, id := range []string{"codex", "claude", "pi"} {
		base := object(harnesses[id])
		h := object(incoming[id])
		if incoming[id] == nil {
			h = base
		}
		if h == nil {
			return nil, errors.New("invalid harness settings")
		}
		cmd, err := checkedText(h["command"], "Executable", 1000, false)
		if err != nil {
			return nil, err
		}
		model, err := checkedText(nullish(h["model"], ""), "Model", 200, true)
		if err != nil {
			return nil, err
		}
		harnesses[id] = map[string]any{"command": cmd, "model": model, "enabled": h["enabled"] != false}
		if value, exists := h["effort"]; exists {
			effort, ok := value.(string)
			if !ok {
				return nil, errors.New("invalid agent effort")
			}
			_, effort, err = harness.Options(id, model, effort)
			if err != nil {
				return nil, err
			}
			object(harnesses[id])["effort"] = effort
		}
	}
	assistant := object(raw["workspaceAgent"])
	if raw["workspaceAgent"] == nil {
		assistant = object(config["workspaceAgent"])
	}
	if assistant == nil {
		return nil, errors.New("Invalid workspace agent settings")
	}
	model, err := checkedText(nullish(assistant["model"], ""), "Relay model", 200, true)
	if err != nil {
		return nil, err
	}
	effort, err := checkedText(nullish(assistant["effort"], ""), "Relay effort", 20, true)
	if err != nil {
		return nil, err
	}
	assistantProvider := textValue(assistant["provider"])
	if assistantProvider == "" {
		assistantProvider = "claude"
	}
	if _, _, err = harness.Options(assistantProvider, model, effort); err != nil {
		return nil, errors.New("Unsupported Relay effort")
	}
	permissions := object(object(config["workspaceAgent"])["permissions"])
	incomingPermissions := object(assistant["permissions"])
	for key, def := range permissions {
		value := nullish(incomingPermissions[key], def)
		if _, ok := value.(bool); !ok {
			return nil, errors.New("Permissions must be true or false")
		}
		permissions[key] = value
	}
	config["workspaceAgent"] = map[string]any{"model": model, "effort": effort, "permissions": permissions}
	if value, exists := assistant["provider"]; exists {
		provider, ok := value.(string)
		if !ok || (provider != "codex" && provider != "claude" && provider != "pi") {
			return nil, errors.New("invalid Relay provider")
		}
		object(config["workspaceAgent"])["provider"] = provider
	}
	routing := object(config["routing"])
	incomingRouting := object(raw["routing"])
	for _, stage := range []string{"triage", "investigate", "plan", "implement", "review"} {
		value := nullish(incomingRouting[stage], routing[stage])
		id := textValue(value)
		if id != "codex" && id != "claude" && id != "pi" {
			return nil, fmt.Errorf("Unknown harness for %s", stage)
		}
		routing[stage] = id
	}
	repositories := []any{}
	if raw["repositories"] != nil {
		var ok bool
		repositories, ok = raw["repositories"].([]any)
		if !ok || len(repositories) > 100 {
			return nil, errors.New("Repositories must be an array of at most 100 profiles")
		}
	}
	result := make([]any, 0, len(repositories))
	seen := map[string]bool{}
	for _, value := range repositories {
		profile := object(value)
		if profile == nil {
			return nil, errors.New("Invalid repository profile")
		}
		strategy := textValue(nullish(profile["strategy"], "worktree"))
		if strategy != "worktree" && strategy != "managed" && strategy != "attach" {
			return nil, errors.New("Unknown workspace strategy")
		}
		if strategy == "managed" && !truthy(profile["workspaceCommand"]) {
			return nil, errors.New("Managed workspaces require a creation command")
		}
		if value, exists := profile["verificationMode"]; exists && value != "agent" && value != "commands" {
			return nil, errors.New("Invalid verification mode")
		}
		checks, err := commandList(profile["checks"])
		if err != nil {
			return nil, err
		}
		setup, err := commandList(profile["setup"])
		if err != nil {
			return nil, err
		}
		access := object(profile["developmentAccess"])
		if profile["developmentAccess"] == nil {
			access = map[string]any{}
		}
		if access == nil {
			return nil, errors.New("Invalid development access")
		}
		for _, key := range []string{"analysisCommands", "networkAccess"} {
			if value, exists := access[key]; exists {
				if _, ok := value.(bool); !ok {
					return nil, fmt.Errorf("Invalid %s", key)
				}
			}
		}
		roots := []any{}
		if access["writableRoots"] != nil {
			var ok bool
			roots, ok = access["writableRoots"].([]any)
			if !ok || len(roots) > 20 {
				return nil, errors.New("Writable roots must be explicit absolute directories")
			}
		}
		for _, value := range roots {
			path, ok := value.(string)
			if !ok || !filepath.IsAbs(path) || filepath.Clean(path) == filepath.VolumeName(path)+string(filepath.Separator) || len(utf16.Encode([]rune(path))) > 2000 || strings.ContainsRune(path, '\x00') {
				return nil, errors.New("Writable roots must be explicit absolute directories")
			}
			for _, part := range strings.Split(path, "/") {
				if part == ".." {
					return nil, errors.New("Writable roots must be explicit absolute directories")
				}
			}
		}
		id := ""
		if truthy(profile["id"]) {
			id, err = checkedText(profile["id"], "Repository ID", 100, false)
		} else {
			id, err = uuid()
		}
		if err != nil {
			return nil, err
		}
		if seen[id] {
			return nil, errors.New("Duplicate repository IDs")
		}
		seen[id] = true
		name, err := checkedText(profile["name"], "Repository name", 100, false)
		if err != nil {
			return nil, err
		}
		path, err := checkedText(profile["path"], "Repository path", 2000, false)
		if err != nil {
			return nil, err
		}
		cwd, err := checkedText(nullish(profile["cwd"], "."), "Working subdirectory", 2000, false)
		if err != nil {
			return nil, err
		}
		instructions, err := checkedText(nullish(profile["instructions"], ""), "Instructions", 50000, true)
		if err != nil {
			return nil, err
		}
		// cleanupCommand removes a managed workspace the way workspaceCommand made it.
		var workspaceCommand, cleanupCommand, issueCommand, prCommand any
		for _, field := range []struct {
			key         string
			destination *any
		}{{"workspaceCommand", &workspaceCommand}, {"cleanupCommand", &cleanupCommand}, {"issueCommand", &issueCommand}, {"prCommand", &prCommand}} {
			if truthy(profile[field.key]) {
				v, err := command(profile[field.key])
				if err != nil {
					return nil, err
				}
				*field.destination = v
			}
		}
		workspacePath := ""
		if strategy == "managed" {
			workspacePath, err = checkedText(profile["workspacePath"], "Managed workspace path template", 2000, false)
			if err != nil {
				return nil, err
			}
		}
		result = append(result, map[string]any{"developmentAccess": map[string]any{"analysisCommands": access["analysisCommands"] == true, "networkAccess": access["networkAccess"] == true, "writableRoots": roots}, "id": id, "name": name, "path": path, "cwd": cwd, "strategy": strategy, "workspaceCommand": workspaceCommand, "workspacePath": workspacePath, "verificationMode": nullish(profile["verificationMode"], "agent"), "checks": checks, "setup": setup, "instructions": instructions, "issueCommand": issueCommand, "prCommand": prCommand})
		if cleanupCommand != nil {
			result[len(result)-1].(map[string]any)["cleanupCommand"] = cleanupCommand
		}
	}
	config["repositories"] = result
	return config, nil
}
