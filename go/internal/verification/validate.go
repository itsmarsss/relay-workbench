// Package verification ports the report-validation gate. It does not execute
// commands, approve work, or substitute for supervised verification.
package verification

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
)

type ValidationError struct{ Code, Message string }

func (e *ValidationError) Error() string { return e.Message }
func invalid(message string) error {
	return &ValidationError{Code: "VERIFICATION_REPORT_INVALID", Message: message}
}
func failed(message string) error {
	return &ValidationError{Code: "VERIFICATION_CHECK_FAILED", Message: message}
}
func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func list(v any) ([]any, bool) { a, ok := v.([]any); return a, ok }
func text(v any) string        { s, _ := v.(string); return s }
func nonempty(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	return strings.TrimFunc(s, func(r rune) bool {
		return r >= 9 && r <= 13 || r == 0x20 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
	}) != ""
}
func integer(v any) (int, bool) {
	n, ok := v.(float64)
	if !ok || math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n > float64(math.MaxInt32) || n < float64(math.MinInt32) {
		return 0, false
	}
	return int(n), true
}
func stringArgs(v any) bool {
	a, ok := list(v)
	if !ok {
		return false
	}
	for _, x := range a {
		if _, ok := x.(string); !ok {
			return false
		}
	}
	return true
}
func sameProperty(a, b map[string]any, key string) bool {
	left, leftExists := a[key]
	right, rightExists := b[key]
	return leftExists == rightExists && reflect.DeepEqual(left, right)
}
func sameCommand(a, b map[string]any) bool {
	return reflect.DeepEqual(a["repositoryId"], b["repositoryId"]) && reflect.DeepEqual(a["cwd"], b["cwd"]) && reflect.DeepEqual(a["command"], b["command"]) && reflect.DeepEqual(a["args"], b["args"]) && reflect.DeepEqual(a["code"], b["code"])
}
func indexAt(v any, checks []any) (int, map[string]any, bool) {
	i, ok := integer(v)
	if !ok || i < 0 || i >= len(checks) {
		return 0, nil, false
	}
	check := obj(checks[i])
	return i, check, check != nil
}
func tuple(r map[string]any) string {
	b, _ := json.Marshal([]any{r["repositoryId"], r["cwd"], r["command"], r["args"]})
	return string(b)
}

// Validate receives JSON-decoded values, matching the legacy wire contract.
// Its caller must establish toolEvidence and journal integrity independently;
// accepting model-supplied evidence as trusted would bypass the gate.
func Validate(handoff map[string]any, entries []any, toolEvidence bool, context map[string]any) error {
	if !toolEvidence {
		return invalid("Verification needs recorded tool execution, not a summary alone")
	}
	report := obj(handoff["verification"])
	checks, ok := list(report["checks"])
	if !ok || len(checks) == 0 || len(checks) > 200 {
		return invalid("Verification needs executed checks")
	}
	ids := map[string]bool{}
	for _, entry := range entries {
		r := obj(obj(entry)["repository"])
		if !nonempty(r["id"]) {
			return invalid("Invalid repository verification profile")
		}
		id := text(r["id"])
		ids[id] = true
	}
	for _, value := range checks {
		check := obj(value)
		code, ok := integer(check["code"])
		if check == nil || !ids[text(check["repositoryId"])] || !nonempty(check["command"]) || !stringArgs(check["args"]) || !nonempty(check["cwd"]) || !ok || !nonempty(check["summary"]) {
			return invalid("Invalid verification command evidence")
		}
		if code != 0 {
			return failed(fmt.Sprintf("A failed verification check cannot pass the gate: %s exited %d", text(check["command"]), code))
		}
	}
	requirements, ok := list(report["requirements"])
	if !ok || len(requirements) == 0 || len(requirements) > 200 {
		return invalid("Verification needs requirements from repository guidance")
	}
	covered := map[string]bool{}
	for _, value := range requirements {
		r := obj(value)
		rid := text(r["repositoryId"])
		indices, ok := list(r["checkIndices"])
		if r == nil || !ids[rid] || !nonempty(r["source"]) || !nonempty(r["requirement"]) || !ok || len(indices) == 0 {
			return invalid("Every verification requirement needs a source and matching check evidence")
		}
		for _, v := range indices {
			_, check, valid := indexAt(v, checks)
			if !valid || text(check["repositoryId"]) != rid {
				return invalid("Every verification requirement needs a source and matching check evidence")
			}
		}
		covered[rid] = true
	}
	for id := range ids {
		if !covered[id] {
			return invalid("Verification must cover every selected repository")
		}
	}
	journalRaw, journalPresent := context["journal"]
	journal, journalValid := list(journalRaw)
	if journalPresent && journalRaw != nil && !journalValid {
		return invalid("Invalid verification journal")
	}
	if journalPresent && journalRaw != nil {
		latest := map[string]map[string]any{}
		order := []string{}
		for _, value := range journal {
			record := obj(value)
			if record == nil {
				return invalid("Invalid verification journal")
			}
			if text(record["purpose"]) == "diagnostic" {
				continue
			}
			key := tuple(record)
			if _, exists := latest[key]; !exists {
				order = append(order, key)
			}
			latest[key] = record
		}
		for _, key := range order {
			r := latest[key]
			code, ok := integer(r["code"])
			if text(r["status"]) == "complete" && (!ok || code != 0) {
				if !ok {
					return failed(fmt.Sprintf("A supervised check failed: %s exited undefined", text(r["command"])))
				}
				return failed(fmt.Sprintf("A supervised check failed: %s exited %d", text(r["command"]), code))
			}
		}
	}
	reuse := []any{}
	if value := report["reuse"]; value != nil {
		reuse, ok = list(value)
		if !ok || len(reuse) > len(checks) {
			return invalid("Invalid reused check evidence")
		}
	}
	reused := map[int]bool{}
	prior, _ := list(context["priorEvidence"])
	for _, value := range reuse {
		item := obj(value)
		if item == nil {
			return invalid("Reused evidence needs an eligible source and impact explanation")
		}
		index, check, valid := indexAt(item["checkIndex"], checks)
		var source map[string]any
		for _, p := range prior {
			candidate := obj(p)
			if candidate != nil && sameProperty(candidate, item, "attemptId") && candidate["reusable"] == true {
				source = candidate
				break
			}
		}
		if !valid || source == nil || reused[index] || !nonempty(item["reason"]) {
			return invalid("Reused evidence needs an eligible source and impact explanation")
		}
		first, _ := list(source["checks"])
		second, _ := list(obj(source["report"])["checks"])
		found := false
		for _, p := range append(first, second...) {
			record := obj(p)
			code, ok := integer(record["code"])
			if ok && code == 0 && text(record["purpose"]) != "diagnostic" && sameCommand(check, record) {
				found = true
				break
			}
		}
		if !found {
			return invalid("Reused check must match a recorded passing command")
		}
		fresh, ok := list(item["freshCheckIndices"])
		if !ok {
			return invalid("Reused evidence needs fresh check references")
		}
		if !sameProperty(source, context, "sourceFingerprint") && len(fresh) == 0 {
			return invalid("Changed source needs fresh impact checks before reusing evidence")
		}
		for _, v := range fresh {
			other, otherCheck, valid := indexAt(v, checks)
			if !valid || other == index || text(otherCheck["repositoryId"]) != text(check["repositoryId"]) {
				return invalid("Impact checks must be fresh and cover the same repository")
			}
			for _, candidate := range reuse {
				r := obj(candidate)
				i, ok := integer(r["checkIndex"])
				if ok && i == other {
					return invalid("Impact checks must be fresh and cover the same repository")
				}
			}
		}
		reused[index] = true
	}
	if journalPresent && journalRaw != nil {
		for index, value := range checks {
			if reused[index] {
				continue
			}
			check := obj(value)
			found := false
			for _, item := range journal {
				record := obj(item)
				if record != nil && text(record["status"]) == "complete" && text(record["purpose"]) != "diagnostic" && sameProperty(record, context, "sourceFingerprint") && sameCommand(record, check) {
					found = true
					break
				}
			}
			if !found {
				return invalid("Fresh check evidence must match a completed supervised check")
			}
		}
	}
	for _, entry := range entries {
		repo := obj(obj(entry)["repository"])
		if text(repo["verificationMode"]) != "commands" {
			continue
		}
		commands, valid := list(repo["checks"])
		if !valid || len(commands) == 0 {
			return invalid("Configured commands remain mandatory in mixed verification workspaces")
		}
		for _, value := range commands {
			command := obj(value)
			found := false
			for _, item := range checks {
				check := obj(item)
				if reflect.DeepEqual(check["repositoryId"], repo["id"]) && reflect.DeepEqual(check["command"], command["command"]) && reflect.DeepEqual(check["args"], command["args"]) {
					found = true
					break
				}
			}
			if !found {
				return invalid("Configured commands remain mandatory in mixed verification workspaces")
			}
		}
	}
	return nil
}
