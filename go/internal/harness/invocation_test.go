package harness

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"relay.local/relay/internal/legacytest"
	"strings"
	"testing"
)

type buildCase struct {
	Provider   string `json:"provider"`
	Config     Config `json:"config"`
	SchemaPath string `json:"schemaPath"`
	Stage      string `json:"stage"`
	Session    string `json:"session"`
}

func TestBuildKeepsMetacharactersAsLiteralArguments(t *testing.T) {
	in, err := Build("codex", Config{Command: "codex", Model: "name $(touch nope)", Effort: "high"}, "path;danger", "implement", "")
	if err != nil {
		t.Fatal(err)
	}
	if !contains(in.Args, "name $(touch nope)") || !contains(in.Args, "path;danger") {
		t.Fatalf("arguments changed: %#v", in.Args)
	}
}
func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func TestInvocationAndEmbeddedSchemasMatchLegacy(t *testing.T) {
	node, _ := exec.LookPath("node")
	cases := []buildCase{}
	for _, provider := range []string{"codex", "claude", "pi"} {
		for _, stage := range []string{"triage", "investigate", "plan", "implement", "verify", "review", "followup", "publish", "monitor", "unknown"} {
			for _, config := range []Config{{Command: "agent"}, {Command: "agent", Model: "model-name", Effort: "high"}, {Command: "agent", Model: "with $(shell)", Effort: "high"}} {
				cases = append(cases, buildCase{provider, config, "path with spaces/schema.json", stage, "session-123"})
			}
		}
	}
	cases = append(cases, buildCase{"pi", Config{Command: "pi"}, "schema", "plan", ""}, buildCase{"claude", Config{Command: "claude"}, "schema", "plan", ""})
	raw, _ := json.Marshal(cases)
	path, err := filepath.Abs("../../../server/harness.js")
	if err != nil {
		t.Fatal(err)
	}
	js := `import {pathToFileURL} from 'node:url';const {buildInvocation}=await import(pathToFileURL(process.argv[1]));let input='';for await(const c of process.stdin)input+=c;console.log(JSON.stringify(JSON.parse(input).map(c=>buildInvocation(c.provider,c.config,c.schemaPath,c.stage,c.session))));`
	cmd := exec.Command(node, "--input-type=module", "-e", js, path)
	cmd.Stdin = bytes.NewReader(raw)
	out, err := legacytest.Output(t, "harness-invocation-1", cmd, true)
	if err != nil {
		t.Fatalf("oracle: %s: %v", out, err)
	}
	var expected []Invocation
	if err = json.Unmarshal(out, &expected); err != nil {
		t.Fatal(err)
	}
	if len(expected) != len(cases) {
		t.Fatal("oracle length")
	}
	for i, c := range cases {
		actual, err := Build(c.Provider, c.Config, c.SchemaPath, c.Stage, c.Session)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(actual, expected[i]) {
			t.Errorf("case %d %s %s differs", i, c.Provider, c.Stage)
		}
	}
	if _, err = Build("other", Config{}, "", "", ""); err == nil || !strings.Contains(err.Error(), "Unsupported") {
		t.Fatal("unknown provider accepted")
	}
}

func TestBuildRejectsUnvalidatedOptions(t *testing.T) {
	for _, config := range []Config{{Command: "codex", Effort: `high";evil`}, {Command: "codex", Model: "line\nbreak"}, {Command: "codex", Model: strings.Repeat("x", 201)}} {
		if _, err := Build("codex", config, "schema", "implement", ""); err == nil {
			t.Fatalf("invalid options accepted: %#v", config)
		}
	}
}
