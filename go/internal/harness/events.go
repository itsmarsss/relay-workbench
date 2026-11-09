package harness

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf16"
)

type rawObject map[string]json.RawMessage

func rawObjectOf(raw json.RawMessage) rawObject {
	var value rawObject
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}
func rawString(raw json.RawMessage) string {
	var value string
	_ = json.Unmarshal(raw, &value)
	return value
}
func rawBool(raw json.RawMessage) bool { var value bool; _ = json.Unmarshal(raw, &value); return value }
func rawArray(raw json.RawMessage) []json.RawMessage {
	var values []json.RawMessage
	_ = json.Unmarshal(raw, &values)
	return values
}
func jsonValue(raw json.RawMessage) any {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}
func displayJSON(raw json.RawMessage, pretty bool) string {
	if len(raw) == 0 {
		return ""
	}
	result, err := jsJSON(raw, pretty)
	if err != nil {
		return strings.TrimSpace(string(raw))
	}
	return result
}
func stringForTemplate(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "undefined"
	}
	if string(raw) == "null" {
		return "null"
	}
	if len(raw) > 0 && raw[0] == '"' {
		return rawString(raw)
	}
	if value := jsonValue(raw); value != nil {
		return fmt.Sprint(value)
	}
	return "undefined"
}
func limited(value string, max int) string {
	units := utf16.Encode([]rune(value))
	if len(units) > max {
		units = units[:max]
	}
	return string(utf16.Decode(units))
}
func activity(value json.RawMessage) map[string]any {
	content := rawString(value)
	if len(value) == 0 || string(value) == "null" {
		content = `""`
	} else if len(value) > 0 && value[0] != '"' {
		content = displayJSON(value, false)
	}
	var parsed rawObject
	if json.Unmarshal([]byte(content), &parsed) == nil {
		if summary, ok := parsed["summary"]; ok {
			var s string
			if json.Unmarshal(summary, &s) == nil {
				details := jsonValue(parsed["details"])
				if details == nil {
					details = ""
				}
				return map[string]any{"activity": s, "details": details, "kind": "handoff"}
			}
		}
	}
	return map[string]any{"activity": limited(content, 1200), "details": content, "kind": "message"}
}
func final(value json.RawMessage) map[string]any {
	result := activity(value)
	if len(value) > 0 {
		result["final"] = value
	}
	return result
}
func withActivities(items []map[string]any) map[string]any {
	if len(items) == 0 {
		return map[string]any{}
	}
	result := map[string]any{}
	for k, v := range items[0] {
		result[k] = v
	}
	result["activities"] = items
	return result
}

// Decode extracts readable progress and structured results without executing
// model output. Unrecognized events produce an empty object.
func Decode(provider, line string) map[string]any {
	var parsed json.RawMessage
	if json.Unmarshal([]byte(line), &parsed) != nil {
		return map[string]any{"activity": limited(line, 1200), "details": line, "kind": "output"}
	}
	event := rawObjectOf(parsed)
	if event == nil {
		return map[string]any{}
	}
	kind := rawString(event["type"])
	if kind == "relay.activity" {
		result := map[string]any{"details": "", "kind": "tool"}
		if v, ok := event["summary"]; ok {
			result["activity"] = jsonValue(v)
		}
		if v := jsonValue(event["details"]); v != nil {
			result["details"] = v
		}
		return result
	}
	if kind == "relay.error" {
		result := map[string]any{}
		if v, ok := event["error"]; ok {
			result["error"] = jsonValue(v)
		}
		return result
	}
	if provider == "codex" {
		item := rawObjectOf(event["item"])
		itemType := rawString(item["type"])
		if kind == "item.completed" && itemType == "agent_message" {
			return final(item["text"])
		}
		if kind == "item.started" && itemType == "command_execution" {
			result := map[string]any{"activity": "Running: " + stringForTemplate(item["command"]), "kind": "tool"}
			if v, ok := item["command"]; ok {
				result["details"] = jsonValue(v)
			}
			return result
		}
		if kind == "item.completed" && itemType == "command_execution" {
			code := "?"
			if v := jsonValue(item["exit_code"]); v != nil {
				code = fmt.Sprint(v)
			}
			return map[string]any{"activity": "Command finished (" + code + ")", "details": rawString(item["command"]) + "\n" + rawString(item["aggregated_output"]), "kind": "tool"}
		}
		if kind == "item.completed" && itemType == "file_change" {
			details := displayJSON(item["changes"], true)
			if details == "" {
				details = "[]"
			}
			return map[string]any{"activity": "Updated files", "details": details, "kind": "tool"}
		}
		if kind == "error" || kind == "turn.failed" {
			message := rawString(event["message"])
			if message == "" {
				message = rawString(rawObjectOf(event["error"])["message"])
			}
			if message == "" {
				message = "Codex turn failed"
			}
			return map[string]any{"error": message}
		}
	}
	if provider == "claude" {
		if kind == "result" {
			if rawBool(event["is_error"]) {
				message := rawString(event["result"])
				if message == "" {
					parts := []string{}
					for _, v := range rawArray(event["errors"]) {
						parts = append(parts, rawString(v))
					}
					message = strings.Join(parts, "\n")
				}
				if message == "" {
					message = "Claude turn failed"
				}
				return map[string]any{"error": message}
			}
			value := event["structured_output"]
			if len(value) == 0 || string(value) == "null" {
				value = event["result"]
			}
			return final(value)
		}
		if kind == "user" || kind == "assistant" {
			content := rawArray(rawObjectOf(event["message"])["content"])
			items := []map[string]any{}
			for _, raw := range content {
				item := rawObjectOf(raw)
				itemType := rawString(item["type"])
				if kind == "user" && itemType == "tool_result" {
					label := "Tool result"
					if rawBool(item["is_error"]) {
						label = "Tool failed or access denied"
					}
					content := item["content"]
					details := rawString(content)
					if len(content) == 0 || string(content) == "null" {
						details = `""`
					} else if content[0] != '"' {
						details = displayJSON(content, false)
					}
					items = append(items, map[string]any{"activity": label, "details": details, "kind": "tool"})
				} else if kind == "assistant" && itemType == "text" && rawString(item["text"]) != "" {
					items = append(items, activity(item["text"]))
				} else if kind == "assistant" && itemType == "tool_use" {
					itemResult := map[string]any{"kind": "tool"}
					if input, ok := item["input"]; ok {
						itemResult["details"] = displayJSON(input, true)
					}
					if name, ok := item["name"]; ok {
						itemResult["activity"] = jsonValue(name)
					}
					items = append(items, itemResult)
				}
			}
			return withActivities(items)
		}
	}
	if provider == "pi" {
		message := rawObjectOf(event["message"])
		if kind == "message_end" && rawString(message["role"]) == "assistant" {
			reason := rawString(message["stopReason"])
			if reason == "error" || reason == "aborted" {
				msg := rawString(message["errorMessage"])
				if msg == "" {
					msg = "Pi turn failed"
				}
				return map[string]any{"error": msg}
			}
			parts := []string{}
			for _, raw := range rawArray(message["content"]) {
				v := rawObjectOf(raw)
				if rawString(v["type"]) == "text" {
					parts = append(parts, rawString(v["text"]))
				}
			}
			value := strings.Join(parts, "\n")
			if value != "" {
				encoded, _ := json.Marshal(value)
				return final(encoded)
			}
		}
		if kind == "tool_execution_start" {
			details := displayJSON(event["args"], true)
			if details == "" || string(event["args"]) == "null" {
				details = "{}"
			}
			result := map[string]any{"details": details, "kind": "tool"}
			if name, ok := event["toolName"]; ok {
				result["activity"] = jsonValue(name)
			}
			return result
		}
		if kind == "tool_execution_end" {
			name := rawString(event["toolName"])
			if len(event["toolName"]) == 0 || string(event["toolName"]) == "null" {
				name = "Tool"
			}
			status := "finished"
			if rawBool(event["isError"]) {
				status = "failed"
			}
			details := displayJSON(event["result"], true)
			if details == "" || string(event["result"]) == "null" {
				details = "{}"
			}
			return map[string]any{"activity": name + " " + status, "details": details, "kind": "tool"}
		}
	}
	return map[string]any{}
}
