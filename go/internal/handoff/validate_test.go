package handoff

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type testCase struct {
	Stage string `json:"stage"`
	Raw   any    `json:"raw"`
}

func valid() map[string]any {
	return map[string]any{"summary": "Done", "details": "Evidence", "files": []any{}, "risks": []any{}, "evidence": []any{}, "options": []any{map[string]any{"id": "one", "title": "First", "description": "Path", "tradeoffs": "Cost"}}, "findings": []any{}, "verdict": "complete", "routing": map[string]any{"investigate": "codex", "plan": "claude", "implement": "codex", "review": "claude"}, "recommendationReason": "Best fit", "recommendedOptionId": "one", "followUpAction": "complete"}
}
func TestVerdictGatesAndRecommendations(t *testing.T) {
	test := valid()
	test["verdict"] = "changes_requested"
	b, _ := json.Marshal(test)
	if Validate(b, "implement") == nil {
		t.Fatal("implementation cannot request changes")
	}
	if err := Validate(b, "review"); err != nil {
		t.Fatal(err)
	}
	test = valid()
	test["recommendedOptionId"] = "missing"
	b, _ = json.Marshal(test)
	if err := Validate(b, "plan"); err == nil || !strings.Contains(err.Error(), "proposed option") {
		t.Fatalf("invalid recommendation: %v", err)
	}
}
func TestApproachIdentifiersRemainActionable(t *testing.T) {
	task := valid()
	option := task["options"].([]any)[0].(map[string]any)
	id := strings.Repeat("界", 100)
	option["id"], task["recommendedOptionId"] = id, id
	raw, _ := json.Marshal(task)
	if err := Validate(raw, "plan"); err != nil {
		t.Fatalf("valid unicode ID rejected: %v", err)
	}
	option["id"], task["recommendedOptionId"] = strings.Repeat("x", 100001), nil
	raw, _ = json.Marshal(task)
	if err := Validate(raw, "plan"); err == nil {
		t.Fatal("unactionably large option ID accepted")
	}
}
func TestMatchesLegacyValidatorAcrossHandoffCorpus(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for legacy differential oracle")
	}
	cases := []testCase{}
	for _, stage := range []string{"triage", "investigate", "plan", "implement", "verify", "review", "followup", "publish", "monitor"} {
		for _, verdict := range []string{"complete", "blocked", "changes_requested", "repair_requested", "verification_requested", "other"} {
			h := valid()
			h["verdict"] = verdict
			cases = append(cases, testCase{stage, h})
		}
	}
	for _, value := range []any{nil, false, []any{}, "", 1, map[string]any{}, map[string]any{"summary": "ok"}} {
		cases = append(cases, testCase{"plan", value})
	}
	for _, value := range []any{"", " ", "\uFEFF", "\u0085", strings.Repeat("a", 100001), strings.Repeat("😀", 50001)} {
		h := valid()
		h["summary"] = value
		cases = append(cases, testCase{"plan", h})
	}
	for _, key := range []string{"files", "evidence", "risks", "options", "findings", "routing"} {
		h := valid()
		delete(h, key)
		cases = append(cases, testCase{"triage", h})
	}
	option := map[string]any{"id": "one", "title": "First", "description": "Path", "tradeoffs": "Cost"}
	for _, options := range []any{nil, []any{}, []any{option, option}, []any{option, option, map[string]any{}}, []any{map[string]any{"id": "  ", "title": "t", "description": "d", "tradeoffs": "x"}}} {
		h := valid()
		h["options"] = options
		cases = append(cases, testCase{"plan", h})
	}
	for _, recommend := range []any{nil, "one", "missing", 42} {
		h := valid()
		h["recommendedOptionId"] = recommend
		cases = append(cases, testCase{"plan", h})
	}
	for _, finding := range []any{map[string]any{"severity": "critical", "file": "", "description": ""}, map[string]any{"severity": "other", "file": "x", "description": "x"}, map[string]any{"severity": "minor", "file": nil, "description": "x"}} {
		h := valid()
		h["findings"] = []any{finding}
		cases = append(cases, testCase{"review", h})
	}
	payload, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	script, err := filepath.Abs("../../../server/domain.js")
	if err != nil {
		t.Fatal(err)
	}
	js := `import {pathToFileURL} from 'node:url'; const {validateHandoff}=await import(pathToFileURL(process.argv[1])); let input=''; for await(const chunk of process.stdin) input+=chunk; const cases=JSON.parse(input); console.log(JSON.stringify(cases.map(c=>{try{validateHandoff(c.raw,c.stage);return ''}catch(e){return e.message}})));`
	cmd := exec.Command(node, "--input-type=module", "-e", js, script)
	cmd.Stdin = bytes.NewReader(payload)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("legacy oracle: %s: %v", out, err)
	}
	var expected []string
	if err = json.Unmarshal(out, &expected); err != nil {
		t.Fatal(err)
	}
	if len(expected) != len(cases) {
		t.Fatal("oracle result count mismatch")
	}
	for i, c := range cases {
		raw, _ := json.Marshal(c.Raw)
		got := Validate(raw, c.Stage)
		message := ""
		if got != nil {
			message = got.Error()
		}
		if message != expected[i] {
			t.Errorf("case %d stage %s: got %q, want %q", i, c.Stage, message, expected[i])
		}
	}
}
