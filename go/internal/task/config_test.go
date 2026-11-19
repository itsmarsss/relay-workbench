package task

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"relay.local/relay/internal/legacytest"
	"testing"
	"time"
)

type configResult struct {
	Config map[string]any `json:"config"`
	Error  string         `json:"error"`
}

func TestConfigurationMatchesLegacyForRepresentativeProfiles(t *testing.T) {
	node, _ := exec.LookPath("node")
	repo := map[string]any{"id": "one", "name": "Example", "path": "/example/repository", "cwd": "src", "strategy": "worktree", "checks": []any{map[string]any{"command": "test", "args": []any{"literal $(not shell)"}}}, "setup": []any{}, "developmentAccess": map[string]any{"analysisCommands": true, "writableRoots": []any{"/example/repository/src"}}}
	cases := []map[string]any{{}, {"repositories": []any{repo}}, {"concurrency": float64(8), "routing": map[string]any{"plan": "pi"}, "workspaceAgent": map[string]any{"model": " model ", "effort": "high", "permissions": map[string]any{"proposeTasks": false}}}, {"concurrency": float64(0)}, {"workspaceAgent": map[string]any{"effort": "ultra"}}, {"workspaceAgent": map[string]any{"permissions": map[string]any{"readSettings": "yes"}}}, {"routing": map[string]any{"plan": "unknown"}}, {"repositories": []any{map[string]any{"id": "bad", "name": "X", "path": "/example", "strategy": "managed"}}}, {"repositories": []any{repo, repo}}, {"repositories": []any{map[string]any{"id": "bad", "name": "X", "path": "/example", "developmentAccess": map[string]any{"writableRoots": []any{"/"}}}}}, {"repositories": []any{map[string]any{"id": "bad", "name": "X", "path": "/example", "developmentAccess": map[string]any{"writableRoots": []any{"/tmp/../outside"}}}}}}
	payload, _ := json.Marshal(cases)
	path, err := filepath.Abs("../../../server/domain.js")
	if err != nil {
		t.Fatal(err)
	}
	js := `import {pathToFileURL} from 'node:url';const {validateConfig}=await import(pathToFileURL(process.argv[1]));let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(raw=>{try{return {config:validateConfig(raw),error:''}}catch(e){return {config:null,error:e.message}}})));`
	cmd := exec.Command(node, "--input-type=module", "-e", js, path)
	cmd.Stdin = bytes.NewReader(payload)
	out, err := legacytest.Output(t, "task-config-1", cmd, true)
	if err != nil {
		t.Fatalf("oracle: %s %v", out, err)
	}
	var expected []configResult
	if err = json.Unmarshal(out, &expected); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		raw, _ := json.Marshal(c)
		var input map[string]any
		_ = json.Unmarshal(raw, &input)
		config, err := ValidateConfig(input)
		actual := configResult{Config: config}
		if err != nil {
			actual.Error = err.Error()
		}
		raw, _ = json.Marshal(actual)
		var converted configResult
		_ = json.Unmarshal(raw, &converted)
		if !reflect.DeepEqual(converted, expected[i]) {
			t.Errorf("case %d got %#v want %#v", i, converted, expected[i])
		}
	}
}
func nowForTest() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
func TestConfigurationAndDraftDoNotExecuteCommandText(t *testing.T) {
	raw := map[string]any{"repositories": []any{map[string]any{"id": "one", "name": "Example", "path": "/example", "checks": []any{map[string]any{"command": "echo", "args": []any{"$(touch should-not-exist)"}}}}}}
	config, err := ValidateConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	task, err := NewTask(map[string]any{"title": "Test", "repositoryId": "one"}, config, nowForTest())
	if err != nil {
		t.Fatal(err)
	}
	entry := object(task["repository"])
	checks := entry["checks"].([]any)
	args := object(checks[0])["args"].([]any)
	if args[0] != "$(touch should-not-exist)" {
		t.Fatal("command argument changed")
	}
}
func FuzzConfigurationNeverPanics(f *testing.F) {
	f.Add([]byte(`{"repositories":[]}`))
	f.Add([]byte(`{"repositories":[{"id":{},"developmentAccess":[]}]}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		var value map[string]any
		if json.Unmarshal(raw, &value) != nil {
			return
		}
		_, _ = ValidateConfig(value)
	})
}
