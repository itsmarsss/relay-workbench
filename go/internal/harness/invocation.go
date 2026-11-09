// Package harness ports argument construction only. It never executes commands.
package harness

import (
	"embed"
	"fmt"
)

//go:embed schema/*.json
var schemas embed.FS

type Config struct {
	Command string `json:"command"`
	Model   string `json:"model"`
	Effort  string `json:"effort"`
}
type Invocation struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

func schemaFor(stage string) string {
	switch stage {
	case "plan", "followup", "publish", "monitor", "verify":
	default:
		stage = "base"
	}
	data, err := schemas.ReadFile("schema/" + stage + ".json")
	if err != nil {
		panic("missing embedded handoff schema")
	}
	return string(data)
}

// Build validates model and effort before returning an argument vector.
func Build(provider string, config Config, schemaPath, stage, sessionID string) (Invocation, error) {
	validatedModel, validatedEffort, err := Options(provider, config.Model, config.Effort)
	if err != nil {
		return Invocation{}, err
	}
	config.Model, config.Effort = validatedModel, validatedEffort
	model := []string{}
	if config.Model != "" {
		model = append(model, "--model", config.Model)
	}
	if config.Effort != "" {
		switch provider {
		case "codex":
			model = append(model, "--config", `model_reasoning_effort="`+config.Effort+`"`)
		case "pi":
			model = append(model, "--thinking", config.Effort)
		default:
			model = append(model, "--effort", config.Effort)
		}
	}
	args := []string{}
	switch provider {
	case "codex":
		args = append(args, "exec", "--json", "--color", "never", "--dangerously-bypass-approvals-and-sandbox", "--output-schema", schemaPath)
		args = append(args, model...)
		args = append(args, "-")
	case "claude":
		args = append(args, "--print", "--verbose", "--output-format", "stream-json", "--json-schema", schemaFor(stage), "--permission-mode", "bypassPermissions", "--permission-prompts", "none", "--settings", `{"sandbox":{"enabled":false}}`)
		args = append(args, model...)
		if sessionID != "" {
			args = append(args, "--resume", sessionID)
		}
	case "pi":
		args = append(args, "--print", "--mode", "json")
		if sessionID != "" {
			args = append(args, "--session-id", sessionID)
		} else {
			args = append(args, "--no-session")
		}
		args = append(args, "--no-extensions", "--no-mcp", "--tools", "read,bash,edit,write,grep,find,ls")
		args = append(args, model...)
	default:
		return Invocation{}, fmt.Errorf("Unsupported harness: %s", provider)
	}
	return Invocation{Command: config.Command, Args: args}, nil
}
