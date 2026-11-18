package assistant

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"relay.local/relay/internal/harness"
	"relay.local/relay/internal/process"
)

func (s *Service) respondClaude(ctx context.Context, config harness.Config, directory, socket, capability, prompt string, stream *stream) error {
	mcp, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"relay": map[string]any{"command": s.Worker, "args": []string{"--internal-assistant-mcp", socket, capability}}}})
	args := []string{"--print", "--verbose", "--output-format", "stream-json", "--include-partial-messages", "--tools", "", "--disable-slash-commands", "--settings", `{"disableAllHooks":true,"sandbox":{"enabled":false}}`, "--strict-mcp-config", "--mcp-config", string(mcp), "--allowedTools", "mcp__relay__*", "--permission-prompts", "none"}
	if config.Model != "" {
		args = append(args, "--model", config.Model)
	}
	if config.Effort != "" {
		args = append(args, "--effort", config.Effort)
	}
	return s.runChat(ctx, config.Command, args, directory, prompt, stream.consume, stream.finish)
}

func (s *Service) runChat(ctx context.Context, command string, args []string, directory, prompt string, consume func(string) error, finish func() error) error {
	result, err := process.Run(ctx, process.Options{WorkerExecutable: s.Worker, WorkerArgs: s.WorkerArgs, Environment: s.Environment, Command: command, Args: args, Directory: directory, Input: []byte(prompt), Timeout: 10 * time.Minute, MaxOutputBytes: 16 * 1024 * 1024, OnLine: func(_ context.Context, line, channel string) error {
		if channel == "stdout" {
			return consume(line)
		}
		return nil
	}})
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("assistant exited %d: %s", result.ExitCode, trim(result.Stderr, 3000))
	}
	return finish()
}

func (s *Service) chatTools(chat Chat) []tool {
	result := []tool{}
	for _, t := range tools() {
		if t.Name == "run_task_action" && chat.Mode != operatorMode {
			continue
		}
		if chat.TaskID != "" && (strings.HasPrefix(t.Name, "propose_") || t.Name == "create_draft" && chat.Mode != operatorMode) {
			continue
		}
		result = append(result, t)
	}
	return result
}

// Codex uses client-owned tools with environment access disabled. Native shell,
// MCP servers, apps, plugins, skills and hooks cannot expand Relay's permissions.
func codexChatArgs() []string {
	args := []string{"app-server", "--stdio", "-c", "mcp_servers={}", "-c", "web_search=\"disabled\"", "-c", "project_doc_max_bytes=0", "-c", "hooks={}"}
	for _, feature := range []string{"shell_tool", "unified_exec", "view_image", "apps", "plugins", "multi_agent", "code_mode", "apply_patch_freeform", "js_repl", "skills", "hooks", "remote_models", "remote_compaction"} {
		args = append(args, "-c", "features."+feature+"=false")
	}
	return args
}

func (s *Service) respondCodex(ctx context.Context, chat Chat, config harness.Config, directory, prompt string, output *stream) error {
	reader, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	defer reader.Close()
	defer writer.Close()
	send := func(value any) error {
		raw, err := json.Marshal(value)
		if err != nil {
			return err
		}
		_, err = writer.Write(append(raw, '\n'))
		return err
	}
	protocol := codexChat{service: s, chat: chat, config: config, directory: directory, prompt: prompt, output: output, send: send, closeInput: writer.Close}
	if err = send(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"clientInfo": map[string]any{"name": "relay", "version": "1.0.0"}, "capabilities": map[string]any{"experimentalApi": true}}}); err != nil {
		return err
	}
	result, err := process.Run(ctx, process.Options{WorkerExecutable: s.Worker, WorkerArgs: s.WorkerArgs, Environment: s.Environment, Command: config.Command, Args: codexChatArgs(), Directory: directory, InputFile: reader, Timeout: 10 * time.Minute, MaxOutputBytes: 16 * 1024 * 1024, OnLine: func(callCtx context.Context, line, channel string) error {
		if channel == "stdout" {
			return protocol.consume(callCtx, line)
		}
		return nil
	}})
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("assistant exited %d: %s", result.ExitCode, trim(result.Stderr, 3000))
	}
	if !protocol.completed {
		return errors.New("assistant returned no completed turn")
	}
	return output.finish()
}

type codexChat struct {
	service                   *Service
	chat                      Chat
	config                    harness.Config
	directory, prompt, thread string
	output                    *stream
	send                      func(any) error
	closeInput                func() error
	completed                 bool
}

func (c *codexChat) consume(ctx context.Context, line string) error {
	var e map[string]any
	if json.Unmarshal([]byte(line), &e) != nil {
		return nil
	}
	if e["error"] != nil {
		return fmt.Errorf("Codex protocol: %s", trim(fmt.Sprint(e["error"]), 2000))
	}
	method := text(e["method"])
	p := obj(e["params"])
	if method == "" {
		switch e["id"] {
		case float64(1):
			if err := c.send(map[string]any{"method": "initialized"}); err != nil {
				return err
			}
			definitions := []any{}
			for _, t := range c.service.chatTools(c.chat) {
				definitions = append(definitions, map[string]any{"type": "function", "name": t.Name, "description": t.Description, "inputSchema": t.InputSchema})
			}
			params := map[string]any{"cwd": c.directory, "ephemeral": true, "environments": []any{}, "approvalPolicy": "never", "sandbox": "read-only", "dynamicTools": definitions}
			if c.config.Model != "" {
				params["model"] = c.config.Model
			}
			return c.send(map[string]any{"id": 2, "method": "thread/start", "params": params})
		case float64(2):
			c.thread = text(obj(obj(e["result"])["thread"])["id"])
			if c.thread == "" {
				return errors.New("Codex returned no thread")
			}
			params := map[string]any{"threadId": c.thread, "environments": []any{}, "input": []any{map[string]any{"type": "text", "text": c.prompt, "text_elements": []any{}}}}
			if c.config.Effort != "" {
				params["effort"] = c.config.Effort
			}
			return c.send(map[string]any{"id": 3, "method": "turn/start", "params": params})
		}
		return nil
	}
	if e["id"] != nil {
		if method != "item/tool/call" {
			return c.send(map[string]any{"id": e["id"], "error": map[string]any{"code": -32601, "message": "Only Relay tools are allowed"}})
		}
		if text(p["threadId"]) != c.thread || text(p["namespace"]) != "" {
			return errors.New("unexpected Codex tool scope")
		}
		name, id := text(p["tool"]), text(p["callId"])
		c.output.calls = append(c.output.calls, ToolCall{ID: id, Name: name, Input: p["arguments"], Status: "running"})
		if err := c.output.flush(true); err != nil {
			return err
		}
		result, err := c.service.rpc(ctx, c.chat, rpcRequest{Method: "tools/call", Params: map[string]any{"name": name, "arguments": p["arguments"]}})
		if err != nil {
			return err
		}
		r := obj(result)
		items := []any{}
		for _, raw := range array(r["content"]) {
			b := obj(raw)
			if b["type"] == "image" {
				items = append(items, map[string]any{"type": "inputImage", "imageUrl": "data:" + text(b["mimeType"]) + ";base64," + text(b["data"])})
			} else {
				items = append(items, map[string]any{"type": "inputText", "text": text(b["text"])})
			}
		}
		i := len(c.output.calls) - 1
		c.output.calls[i].Status = "complete"
		if r["isError"] == true {
			c.output.calls[i].Status = "failed"
		}
		if err := c.output.flush(true); err != nil {
			return err
		}
		return c.send(map[string]any{"id": e["id"], "result": map[string]any{"contentItems": items, "success": r["isError"] != true}})
	}
	if p["threadId"] != nil && p["threadId"] != c.thread {
		return errors.New("unexpected Codex thread event")
	}
	switch method {
	case "item/agentMessage/delta":
		c.output.answer += text(p["delta"])
	case "item/started":
		kind := text(obj(p["item"])["type"])
		if kind == "commandExecution" || kind == "fileChange" || kind == "mcpToolCall" || kind == "collabAgentToolCall" {
			return errors.New("Codex attempted a disabled native tool")
		}
	case "item/completed":
		item := obj(p["item"])
		if item["type"] == "agentMessage" && (item["phase"] == "final_answer" || item["phase"] == nil) {
			c.output.final = text(item["text"])
		}
	case "turn/completed":
		turn := obj(p["turn"])
		if turn["status"] != "completed" {
			return fmt.Errorf("Codex turn %s: %v", text(turn["status"]), turn["error"])
		}
		c.completed = true
		if c.output.final == "" {
			c.output.final = c.output.answer
		}
		return c.closeInput()
	case "error":
		if p["willRetry"] != true {
			return fmt.Errorf("Codex: %v", p["error"])
		}
	}
	return c.output.flush(false)
}

//go:embed pi-tools.ts
var piTools string

func (s *Service) respondPi(ctx context.Context, chat Chat, config harness.Config, directory, socket, capability, prompt string, output *stream) error {
	definitions := s.chatTools(chat)
	raw, _ := json.Marshal(map[string]any{"socket": socket, "capability": capability, "tools": definitions})
	if err := os.WriteFile(filepath.Join(directory, "tools.json"), raw, 0600); err != nil {
		return err
	}
	extension := filepath.Join(directory, "relay-tools.ts")
	if err := os.WriteFile(extension, []byte(piTools), 0600); err != nil {
		return err
	}
	names := []string{}
	for _, t := range definitions {
		names = append(names, t.Name)
	}
	args := []string{"--print", "--mode", "json", "--no-session", "--no-builtin-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-approve", "--extension", extension, "--tools", strings.Join(names, ",")}
	if config.Model != "" {
		args = append(args, "--model", config.Model)
	}
	if config.Effort != "" {
		args = append(args, "--thinking", config.Effort)
	}
	return s.runChat(ctx, config.Command, args, directory, prompt, output.consumePi, output.finishPi)
}
