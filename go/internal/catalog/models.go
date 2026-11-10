// Package catalog discovers model metadata without sending an agent prompt.
package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"relay.local/relay/internal/process"
	"sync"
	"time"
)

type Model struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Efforts []string `json:"efforts"`
}
type Result struct {
	Models    []Model `json:"models"`
	Status    string  `json:"status"`
	Error     string  `json:"error,omitempty"`
	CheckedAt string  `json:"checkedAt"`
}
type Catalog struct {
	Worker      string
	Args        []string
	Environment map[string]string
	mu          sync.Mutex
	cache       map[string]Result
	pending     map[string]chan struct{}
}

func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func text(v any) string        { s, _ := v.(string); return s }
func (c *Catalog) Provider(ctx context.Context, provider, command string, force bool) Result {
	key := provider + ":" + command
	c.mu.Lock()
	if c.cache == nil {
		c.cache = map[string]Result{}
		c.pending = map[string]chan struct{}{}
	}
	if result, exists := c.cache[key]; exists && !force {
		at, _ := time.Parse(time.RFC3339Nano, result.CheckedAt)
		if time.Since(at) < 5*time.Minute {
			c.mu.Unlock()
			return result
		}
	}
	if pending := c.pending[key]; pending != nil {
		c.mu.Unlock()
		select {
		case <-pending:
		case <-ctx.Done():
			return Result{Models: []Model{}, Status: "unavailable", Error: ctx.Err().Error()}
		}
		return c.Provider(ctx, provider, command, false)
	}
	done := make(chan struct{})
	c.pending[key] = done
	c.mu.Unlock()
	result := c.probe(ctx, provider, command)
	c.mu.Lock()
	c.cache[key] = result
	delete(c.pending, key)
	close(done)
	c.mu.Unlock()
	return result
}
func (c *Catalog) probe(parent context.Context, provider, command string) Result {
	result := Result{Models: []Model{}, Status: "unavailable", CheckedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	directory, err := os.MkdirTemp("", "relay-models-")
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer os.RemoveAll(directory)
	input, writer, err := os.Pipe()
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer input.Close()
	defer writer.Close()
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	send := func(value any) { raw, _ := json.Marshal(value); raw = append(raw, '\n'); _, _ = writer.Write(raw) }
	args := []string{}
	switch provider {
	case "codex":
		args = []string{"app-server", "--listen", "stdio://"}
		send(map[string]any{"id": "initialize", "method": "initialize", "params": map[string]any{"clientInfo": map[string]any{"name": "relay-model-picker", "version": "0.1.0"}}})
	case "claude":
		args = []string{"--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`, "--setting-sources", "user"}
		send(map[string]any{"type": "control_request", "request_id": "models", "request": map[string]any{"subtype": "initialize"}})
	case "pi":
		args = []string{"--mode", "rpc", "--no-session"}
		send(map[string]any{"id": "models", "type": "get_available_models"})
	default:
		result.Error = "Unsupported provider"
		return result
	}
	var models []any
	seen := map[string]bool{}
	complete := false
	pages := 0
	_, err = process.Run(ctx, process.Options{WorkerExecutable: c.Worker, WorkerArgs: c.Args, Environment: c.Environment, Command: command, Args: args, Directory: directory, InputFile: input, Timeout: 18 * time.Second, MaxOutputBytes: 2 * 1024 * 1024, OnLine: func(_ context.Context, line, stream string) error {
		if stream != "stdout" {
			return nil
		}
		var event map[string]any
		if json.Unmarshal([]byte(line), &event) != nil {
			return nil
		}
		if provider == "codex" {
			if event["error"] != nil {
				cancel()
				return errors.New("provider could not list models")
			}
			if event["id"] == "initialize" {
				send(map[string]any{"method": "initialized"})
				send(map[string]any{"id": "models", "method": "model/list", "params": map[string]any{"limit": 100, "includeHidden": false}})
			}
			if event["id"] == "models" {
				body := obj(event["result"])
				items, ok := body["data"].([]any)
				if !ok {
					return errors.New("invalid model catalog")
				}
				models = append(models, items...)
				cursor := text(body["nextCursor"])
				pages++
				if cursor != "" && !seen[cursor] && pages < 20 {
					seen[cursor] = true
					send(map[string]any{"id": "models", "method": "model/list", "params": map[string]any{"limit": 100, "includeHidden": false, "cursor": cursor}})
				} else {
					complete = true
					cancel()
				}
			}
		} else if provider == "claude" && event["type"] == "control_response" {
			response := obj(event["response"])
			if response["request_id"] == "models" {
				models, _ = obj(response["response"])["models"].([]any)
				complete = response["subtype"] != "error"
				cancel()
			}
		}
		if provider == "pi" && event["type"] == "response" && event["id"] == "models" {
			models, _ = obj(event["data"])["models"].([]any)
			complete = event["success"] != false
			cancel()
		}
		return nil
	}})
	if parent.Err() != nil {
		result.Error = parent.Err().Error()
		return result
	}
	if !complete {
		result.Error = "Could not discover models; enter a custom model or retry."
		if err != nil {
			result.Error = err.Error()
		}
		return result
	}
	unique := map[string]bool{}
	for _, item := range models {
		row := obj(item)
		if row["hidden"] == true {
			continue
		}
		id := text(row["model"])
		if id == "" {
			id = text(row["value"])
		}
		if id == "" {
			id = text(row["id"])
		}
		if provider == "pi" && text(row["provider"]) != "" {
			id = text(row["provider"]) + "/" + id
		}
		if id == "" || len(id) > 200 || unique[id] {
			continue
		}
		name := ""
		for _, key := range []string{"displayName", "display_name", "name"} {
			if name == "" {
				name = text(row[key])
			}
		}
		if name == "" {
			name = id
		}
		efforts := []string{}
		if values, ok := row["supportedEffortLevels"].([]any); ok {
			for _, item := range values {
				if v := text(item); v != "" {
					efforts = append(efforts, v)
				}
			}
		}
		result.Models = append(result.Models, Model{ID: id, Name: name, Efforts: efforts})
		unique[id] = true
		if len(result.Models) >= 2000 {
			break
		}
	}
	result.Status = "ready"
	if len(result.Models) == 0 {
		result.Status = "empty"
	}
	return result
}
