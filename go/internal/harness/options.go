package harness

import (
	"errors"
	"strings"
	"unicode/utf16"
)

// Options validates user-selected model and effort before Build. The runner is
// not yet implemented; it must never execute unvalidated Build output.
func Options(provider, model, effort string) (string, string, error) {
	if len(utf16.Encode([]rune(model))) > 200 {
		return "", "", errors.New("Model must be a string of at most 200 characters")
	}
	trim := func(r rune) bool {
		return r >= 9 && r <= 13 || r == 0x20 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
	}
	model = strings.TrimFunc(model, trim)
	if strings.ContainsAny(model, "\r\n\x00") {
		return "", "", errors.New("Model must be a single line")
	}
	if effort != "" {
		supported := map[string][]string{"codex": {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}, "claude": {"low", "medium", "high", "xhigh", "max"}, "pi": {"off", "minimal", "low", "medium", "high", "xhigh", "max"}}
		valid := false
		for _, item := range supported[provider] {
			if item == effort {
				valid = true
				break
			}
		}
		if !valid {
			return "", "", errors.New("Invalid effort for this agent")
		}
	}
	return model, effort, nil
}
