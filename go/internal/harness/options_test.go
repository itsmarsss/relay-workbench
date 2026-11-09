package harness

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type optionCase struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Effort   string `json:"effort"`
}
type optionResult struct {
	Model  string `json:"model"`
	Effort string `json:"effort"`
	Error  string `json:"error"`
}

func TestOptionsMatchLegacyAndRejectInjection(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for legacy oracle")
	}
	cases := []optionCase{}
	for _, p := range []string{"codex", "claude", "pi", "unknown"} {
		for _, e := range []string{"", "none", "minimal", "off", "low", "medium", "high", "xhigh", "max", "ultra", "high\";evil"} {
			cases = append(cases, optionCase{p, " model ", e})
		}
	}
	for _, m := range []string{"", "  ", "a\nb", "a\x00b", "\ntrimmed\n", strings.Repeat("😀", 101), strings.Repeat("a", 200)} {
		cases = append(cases, optionCase{"codex", m, "high"})
	}
	payload, _ := json.Marshal(cases)
	path, err := filepath.Abs("../../../server/domain.js")
	if err != nil {
		t.Fatal(err)
	}
	js := `import {pathToFileURL} from 'node:url';const {agentOptions}=await import(pathToFileURL(process.argv[1]));let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(c=>{try{return {...agentOptions(c.provider,c),error:''}}catch(e){return {model:'',effort:'',error:e.message}}})));`
	cmd := exec.Command(node, "--input-type=module", "-e", js, path)
	cmd.Stdin = bytes.NewReader(payload)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("oracle: %s %v", out, err)
	}
	var expected []optionResult
	if err = json.Unmarshal(out, &expected); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		model, effort, err := Options(c.Provider, c.Model, c.Effort)
		message := ""
		if err != nil {
			message = err.Error()
		}
		got := optionResult{model, effort, message}
		if !reflect.DeepEqual(got, expected[i]) {
			t.Errorf("case %d got %#v want %#v", i, got, expected[i])
		}
	}
}
