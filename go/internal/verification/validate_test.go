package verification

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

type testCase struct {
	Handoff      map[string]any `json:"handoff"`
	Entries      []any          `json:"entries"`
	ToolEvidence bool           `json:"toolEvidence"`
	Context      map[string]any `json:"context"`
}
type result struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func base() testCase {
	check := map[string]any{"repositoryId": "repo", "command": "test", "args": []any{"unit"}, "cwd": ".", "code": 0, "summary": "passed"}
	record := map[string]any{}
	for k, v := range check {
		record[k] = v
	}
	record["status"] = "complete"
	record["sourceFingerprint"] = "abc"
	record["purpose"] = "check"
	return testCase{Handoff: map[string]any{"verification": map[string]any{"checks": []any{check}, "requirements": []any{map[string]any{"repositoryId": "repo", "source": "instructions", "requirement": "run tests", "checkIndices": []any{0}}}, "reuse": []any{}}}, Entries: []any{map[string]any{"repository": map[string]any{"id": "repo", "verificationMode": "agent", "checks": []any{}}}}, ToolEvidence: true, Context: map[string]any{"journal": []any{record}, "sourceFingerprint": "abc"}}
}
func copyCase(c testCase) testCase {
	b, _ := json.Marshal(c)
	var out testCase
	_ = json.Unmarshal(b, &out)
	return out
}
func TestMatchesLegacyVerificationGate(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for legacy oracle")
	}
	cases := []testCase{base()}
	add := func(fn func(*testCase)) { c := copyCase(base()); fn(&c); cases = append(cases, c) }
	add(func(c *testCase) { c.ToolEvidence = false })
	add(func(c *testCase) { obj(c.Handoff["verification"])["checks"] = []any{} })
	add(func(c *testCase) { obj(obj(c.Handoff["verification"])["checks"].([]any)[0])["code"] = 1 })
	add(func(c *testCase) { obj(obj(c.Handoff["verification"])["checks"].([]any)[0])["repositoryId"] = "other" })
	add(func(c *testCase) { obj(obj(c.Handoff["verification"])["checks"].([]any)[0])["cwd"] = " " })
	add(func(c *testCase) { obj(c.Handoff["verification"])["requirements"] = []any{} })
	add(func(c *testCase) {
		obj(obj(c.Handoff["verification"])["requirements"].([]any)[0])["checkIndices"] = []any{9}
	})
	add(func(c *testCase) {
		c.Entries = append(c.Entries, map[string]any{"repository": map[string]any{"id": "another", "verificationMode": "agent", "checks": []any{}}})
	})
	add(func(c *testCase) { obj(c.Context["journal"].([]any)[0])["code"] = float64(1) })
	add(func(c *testCase) { c.Context["journal"] = []any{} })
	add(func(c *testCase) { obj(c.Context["journal"].([]any)[0])["sourceFingerprint"] = "old" })
	add(func(c *testCase) { delete(c.Context, "journal") })
	add(func(c *testCase) {
		repo := obj(obj(c.Entries[0])["repository"])
		repo["verificationMode"] = "commands"
		repo["checks"] = []any{map[string]any{"command": "other", "args": []any{}}}
	})
	add(func(c *testCase) {
		r := obj(c.Handoff["verification"])
		check := obj(r["checks"].([]any)[0])
		r["reuse"] = []any{map[string]any{"checkIndex": 0, "attemptId": "old", "reason": "unchanged", "freshCheckIndices": []any{}}}
		c.Context["journal"] = []any{}
		c.Context["priorEvidence"] = []any{map[string]any{"attemptId": "old", "reusable": true, "sourceFingerprint": "abc", "checks": []any{check}}}
	})
	add(func(c *testCase) {
		r := obj(c.Handoff["verification"])
		check := obj(r["checks"].([]any)[0])
		r["reuse"] = []any{map[string]any{"checkIndex": 0, "attemptId": "old", "reason": "unchanged", "freshCheckIndices": []any{}}}
		c.Context["journal"] = []any{}
		c.Context["priorEvidence"] = []any{map[string]any{"attemptId": "old", "reusable": true, "sourceFingerprint": "different", "checks": []any{check}}}
	})
	add(func(c *testCase) {
		good := obj(c.Context["journal"].([]any)[0])
		failed := map[string]any{}
		for k, v := range good {
			failed[k] = v
		}
		failed["code"] = float64(1)
		c.Context["journal"] = []any{failed, good}
	})
	add(func(c *testCase) {
		good := obj(c.Context["journal"].([]any)[0])
		failed := map[string]any{}
		for k, v := range good {
			failed[k] = v
		}
		failed["code"] = float64(1)
		failed["purpose"] = "diagnostic"
		c.Context["journal"] = []any{failed, good}
	})
	add(func(c *testCase) {
		report := obj(c.Handoff["verification"])
		old := obj(report["checks"].([]any)[0])
		fresh := map[string]any{}
		for k, v := range old {
			fresh[k] = v
		}
		fresh["command"] = "impact"
		report["checks"] = []any{old, fresh}
		report["reuse"] = []any{map[string]any{"checkIndex": 0, "attemptId": "old", "reason": "unchanged dependency", "freshCheckIndices": []any{1}}}
		c.Context["priorEvidence"] = []any{map[string]any{"attemptId": "old", "reusable": true, "sourceFingerprint": "old-source", "checks": []any{old}}}
		record := map[string]any{}
		for k, v := range fresh {
			record[k] = v
		}
		record["status"] = "complete"
		record["sourceFingerprint"] = "abc"
		record["purpose"] = "check"
		c.Context["journal"] = []any{record}
	})
	add(func(c *testCase) {
		report := obj(c.Handoff["verification"])
		old := obj(report["checks"].([]any)[0])
		report["reuse"] = []any{map[string]any{"checkIndex": 0, "attemptId": "old", "reason": "unchanged", "freshCheckIndices": []any{0}}}
		c.Context["priorEvidence"] = []any{map[string]any{"attemptId": "old", "reusable": true, "sourceFingerprint": "abc", "checks": []any{old}}}
		c.Context["journal"] = []any{}
	})
	add(func(c *testCase) {
		report := obj(c.Handoff["verification"])
		old := obj(report["checks"].([]any)[0])
		report["reuse"] = []any{map[string]any{"checkIndex": 0, "attemptId": "old", "reason": "unchanged", "freshCheckIndices": []any{}}}
		c.Context["priorEvidence"] = []any{map[string]any{"attemptId": "old", "reusable": true, "checks": []any{old}}}
		c.Context["sourceFingerprint"] = nil
		c.Context["journal"] = []any{}
	})
	add(func(c *testCase) {
		delete(obj(c.Context["journal"].([]any)[0]), "sourceFingerprint")
		c.Context["sourceFingerprint"] = nil
	})
	payload, _ := json.Marshal(cases)
	path, err := filepath.Abs("../../../server/verification.js")
	if err != nil {
		t.Fatal(err)
	}
	js := `import {pathToFileURL} from 'node:url';const {validateVerification}=await import(pathToFileURL(process.argv[1]));let input='';for await(const c of process.stdin)input+=c;console.log(JSON.stringify(JSON.parse(input).map(c=>{try{validateVerification(c.handoff,c.entries,c.toolEvidence,c.context);return {code:'',message:''}}catch(e){return {code:e.code,message:e.message}}})));`
	cmd := exec.Command(node, "--input-type=module", "-e", js, path)
	cmd.Stdin = bytes.NewReader(payload)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("oracle: %s %v", out, err)
	}
	var expected []result
	if err = json.Unmarshal(out, &expected); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		raw, _ := json.Marshal(c)
		var decoded testCase
		if err = json.Unmarshal(raw, &decoded); err != nil {
			t.Fatal(err)
		}
		err := Validate(decoded.Handoff, decoded.Entries, decoded.ToolEvidence, decoded.Context)
		got := result{}
		if err != nil {
			e, ok := err.(*ValidationError)
			if !ok {
				t.Fatalf("case %d unexpected error %v", i, err)
			}
			got = result{e.Code, e.Message}
		}
		if !reflect.DeepEqual(got, expected[i]) {
			t.Errorf("case %d got %#v want %#v", i, got, expected[i])
		}
	}
}

func TestRejectsInvalidRepositoryProfiles(t *testing.T) {
	c := copyCase(base())
	obj(obj(c.Entries[0])["repository"])["id"] = ""
	if err := Validate(c.Handoff, c.Entries, true, c.Context); err == nil {
		t.Fatal("empty repository identity accepted")
	}
	c = copyCase(base())
	repo := obj(obj(c.Entries[0])["repository"])
	repo["verificationMode"] = "commands"
	repo["checks"] = []any{}
	if err := Validate(c.Handoff, c.Entries, true, c.Context); err == nil {
		t.Fatal("empty command profile accepted")
	}
}

func FuzzValidateNeverPanics(f *testing.F) {
	f.Add([]byte(`{"handoff":{"verification":{"checks":[],"requirements":[]}},"entries":[],"toolEvidence":true,"context":{}}`))
	f.Add([]byte(`{"handoff":null,"entries":[null],"toolEvidence":true,"context":{"journal":[null]}}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		var c testCase
		if json.Unmarshal(raw, &c) != nil {
			return
		}
		_ = Validate(c.Handoff, c.Entries, c.ToolEvidence, c.Context)
	})
}
