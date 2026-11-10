// Package handoff ports the legacy handoff validator. It is not yet wired to a
// workflow runner; schema, verification evidence and gate parity are separate.
package handoff

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"
)

func jsSpace(r rune) bool {
	return r >= 0x9 && r <= 0xd || r == 0x20 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
}
func validText(v any, max int) bool {
	s, ok := v.(string)
	return ok && len(utf16.Encode([]rune(s))) <= max && strings.TrimFunc(s, jsSpace) != ""
}
func list(v any) ([]any, bool) { x, ok := v.([]any); return x, ok }
func member(v any, values ...string) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, item := range values {
		if s == item {
			return true
		}
	}
	return false
}
func Validate(raw json.RawMessage, stage string) error {
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed == nil {
		return errors.New("Harness did not return a handoff")
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		if _, isArray := parsed.([]any); !isArray {
			return errors.New("Harness did not return a handoff")
		}
		obj = map[string]any{}
	}
	for _, key := range []string{"summary", "details"} {
		if !validText(obj[key], 100000) {
			return fmt.Errorf("%s must be a nonempty string of at most 100000 characters", key)
		}
	}
	for _, key := range []string{"files", "evidence", "risks"} {
		items, ok := list(obj[key])
		if !ok {
			return fmt.Errorf("Invalid handoff %s", key)
		}
		for _, item := range items {
			if _, ok = item.(string); !ok {
				return fmt.Errorf("Invalid handoff %s", key)
			}
		}
	}
	verdict := obj["verdict"]
	if !member(verdict, "complete", "changes_requested", "blocked", "repair_requested", "verification_requested") {
		return errors.New("Invalid handoff verdict")
	}
	if member(verdict, "repair_requested", "verification_requested") && stage != "investigate" && !(stage == "publish" && verdict == "verification_requested") && !(stage == "implement" && verdict == "verification_requested") {
		return errors.New("Only implementation, publication preparation or debugger investigation can request verification; repair delegation is debugger-only")
	}
	if verdict == "changes_requested" && stage != "review" && stage != "verify" {
		return errors.New("Only review or verification stages may request changes; other incomplete stages must return blocked")
	}
	options, ok := list(obj["options"])
	if !ok {
		return errors.New("Invalid approach options")
	}
	for _, item := range options {
		option, ok := item.(map[string]any)
		if !ok || option == nil {
			return errors.New("Invalid approach options")
		}
		for _, key := range []string{"id", "title", "description", "tradeoffs"} {
			s, ok := option[key].(string)
			if !ok || strings.TrimFunc(s, jsSpace) == "" {
				return errors.New("Invalid approach options")
			}
		}
		if len(option["id"].(string)) > 100000 {
			return errors.New("Approach ID is too long")
		}
	}
	ids := map[string]struct{}{}
	for _, item := range options {
		id := item.(map[string]any)["id"].(string)
		if _, exists := ids[id]; exists {
			return errors.New("Approach IDs must be unique")
		}
		ids[id] = struct{}{}
	}
	if stage == "plan" && obj["recommendedOptionId"] != nil {
		recommendation, ok := obj["recommendedOptionId"].(string)
		if !ok {
			return errors.New("Recommended approach must name a proposed option")
		}
		if _, exists := ids[recommendation]; !exists {
			return errors.New("Recommended approach must name a proposed option")
		}
		if !validText(obj["recommendationReason"], 10000) {
			return errors.New("Recommendation rationale must be a nonempty string of at most 10000 characters")
		}
	}
	findings, ok := list(obj["findings"])
	if !ok {
		return errors.New("Invalid review findings")
	}
	for _, item := range findings {
		finding, ok := item.(map[string]any)
		if !ok || finding == nil || !member(finding["severity"], "critical", "major", "minor") {
			return errors.New("Invalid review findings")
		}
		if _, ok := finding["file"].(string); !ok {
			return errors.New("Invalid review findings")
		}
		if _, ok := finding["description"].(string); !ok {
			return errors.New("Invalid review findings")
		}
	}
	if stage == "followup" && !member(obj["followUpAction"], "complete", "changes") {
		return errors.New("Invalid follow-up action")
	}
	if stage == "plan" && verdict == "complete" && len(options) == 0 {
		return errors.New("Plan must include at least one approach")
	}
	if stage == "triage" {
		routing, ok := obj["routing"].(map[string]any)
		if !ok || routing == nil {
			return errors.New("Triage must include valid routing")
		}
		for _, key := range []string{"investigate", "plan", "implement", "review"} {
			if !member(routing[key], "codex", "claude", "pi") {
				return errors.New("Triage must include valid routing")
			}
		}
	}
	return nil
}
