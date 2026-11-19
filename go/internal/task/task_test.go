package task

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"relay.local/relay/internal/legacytest"
	"strings"
	"testing"
	"time"
)

type outcome struct {
	Task  map[string]any `json:"task"`
	Error string         `json:"error"`
}

func configFixture() map[string]any {
	c := Defaults()
	c["repositories"] = []any{map[string]any{"id": "one", "name": "One", "path": "/example/one", "cwd": ".", "strategy": "worktree", "checks": []any{}, "setup": []any{}, "instructions": "", "verificationMode": "agent"}, map[string]any{"id": "two", "name": "Two", "path": "/example/two", "cwd": ".", "strategy": "worktree", "checks": []any{}, "setup": []any{}, "instructions": "", "verificationMode": "agent"}}
	return c
}
func TestPerStageEffortValidation(t *testing.T) {
	config := configFixture()
	created, err := NewTask(map[string]any{"title": "Effort", "repositoryId": "one", "routing": map[string]any{"implement": "codex"}, "efforts": map[string]any{"implement": "ultra", "plan": "high"}}, config, time.Now())
	if err != nil || object(created["efforts"])["implement"] != "ultra" {
		t.Fatalf("efforts: %#v %v", created, err)
	}
	for _, bad := range []any{[]any{}, map[string]any{"unknown": "high"}, map[string]any{"plan": "ultra"}, map[string]any{"implement": true}} {
		if _, err = NewTask(map[string]any{"title": "Bad effort", "repositoryId": "one", "efforts": bad}, config, time.Now()); err == nil {
			t.Fatalf("invalid efforts accepted: %#v", bad)
		}
	}
}
func TestDraftConstructionMatchesLegacyForValidAndInvalidInputs(t *testing.T) {
	node, _ := exec.LookPath("node")
	config := configFixture()
	cases := []map[string]any{
		{"title": "Demo", "demo": true},
		{"title": "  Fix issue  ", "description": " details ", "ticket": " issue ", "repositoryId": "one", "preset": "bugfix"},
		{"title": "Cross repo", "repositoryId": "two", "repositoryIds": []any{"one", "two"}, "dependencies": []any{map[string]any{"repositoryId": "one", "dependsOn": "two"}}, "preset": "cross-repo", "smartRouting": true},
		{"title": "Overrides", "repositoryId": "one", "repositorySettings": []any{map[string]any{"id": "one", "cwd": "src", "instructions": " notes ", "verificationMode": "commands", "checks": []any{map[string]any{"command": "echo", "args": []any{"$(literal)"}}}}}, "routing": map[string]any{"plan": "pi"}, "models": map[string]any{"plan": " custom "}, "execution": map[string]any{"timeoutMinutes": float64(12)}},
		{"title": "", "demo": true}, {"title": "x"}, {"title": "x", "demo": true, "preset": ""}, {"title": "x", "demo": true, "smartRouting": nil},
		{"title": "x", "repositoryIds": []any{"one", "one"}}, {"title": "x", "repositoryIds": []any{"missing"}},
		{"title": "x", "repositoryIds": []any{"one", "two"}, "dependencies": []any{map[string]any{"repositoryId": "one", "dependsOn": "two"}, map[string]any{"repositoryId": "two", "dependsOn": "one"}}},
		{"title": "x", "repositoryId": "one", "repositorySettings": nil}, {"title": "x", "repositoryId": "one", "routing": map[string]any{"unknown": "codex"}},
		{"title": "x", "demo": true, "execution": map[string]any{"timeoutMinutes": float64(0)}}, {"title": "x", "demo": true, "models": map[string]any{"plan": strings.Repeat("x", 201)}},
	}
	payload, _ := json.Marshal(map[string]any{"config": config, "cases": cases})
	path, err := filepath.Abs("../../../server/domain.js")
	if err != nil {
		t.Fatal(err)
	}
	js := `import {pathToFileURL} from 'node:url';const {newTask}=await import(pathToFileURL(process.argv[1]));let s='';for await(const c of process.stdin)s+=c;const input=JSON.parse(s);console.log(JSON.stringify(input.cases.map(raw=>{try{const task=newTask(raw,input.config);delete task.id;delete task.createdAt;delete task.updatedAt;return {task,error:''}}catch(e){return {task:null,error:e.message}}})));`
	cmd := exec.Command(node, "--input-type=module", "-e", js, path)
	cmd.Stdin = bytes.NewReader(payload)
	out, err := legacytest.Output(t, "task-task-1", cmd, true)
	if err != nil {
		t.Fatalf("oracle: %s %v", out, err)
	}
	var expected []outcome
	if err = json.Unmarshal(out, &expected); err != nil {
		t.Fatal(err)
	}
	for i, input := range cases {
		raw, _ := json.Marshal(input)
		var normalized map[string]any
		_ = json.Unmarshal(raw, &normalized)
		result, err := NewTask(normalized, config, time.Now())
		actual := outcome{Task: result}
		if err != nil {
			actual.Error = err.Error()
		} else {
			delete(actual.Task, "id")
			delete(actual.Task, "createdAt")
			delete(actual.Task, "updatedAt")
		}
		raw, _ = json.Marshal(actual)
		var converted outcome
		_ = json.Unmarshal(raw, &converted)
		if !reflect.DeepEqual(converted, expected[i]) {
			t.Errorf("case %d got %#v want %#v", i, converted, expected[i])
		}
	}
}
func TestCrossRepositoryDependenciesAndInputIsolation(t *testing.T) {
	raw := map[string]any{"title": "Cross", "repositoryId": "two", "repositoryIds": []any{"one", "two"}, "dependencies": []any{map[string]any{"repositoryId": "one", "dependsOn": "two"}}}
	config := configFixture()
	before, _ := json.Marshal(config)
	task, err := NewTask(raw, config, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	entries := task["repositories"].([]any)
	if textValue(object(object(entries[0])["repository"])["id"]) != "two" {
		t.Fatal("dependency order not honored")
	}
	object(object(entries[0])["repository"])["name"] = "changed"
	after, _ := json.Marshal(config)
	if !bytes.Equal(before, after) {
		t.Fatal("task aliases repository config")
	}
}
func FuzzDraftConstructionNeverPanics(f *testing.F) {
	f.Add([]byte(`{"title":"test","demo":true}`))
	f.Add([]byte(`{"title":[],"demo":{}}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		var input map[string]any
		if json.Unmarshal(raw, &input) != nil {
			return
		}
		_, _ = NewTask(input, configFixture(), time.Now())
	})
}
