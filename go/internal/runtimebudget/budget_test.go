package runtimebudget

import (
	"bytes"
	"encoding/json"
	"math"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

type action struct {
	Now      float64  `json:"now"`
	Progress *float64 `json:"progress"`
}
type scenario struct {
	Timeout float64  `json:"timeout"`
	Start   float64  `json:"start"`
	Max     *float64 `json:"max"`
	Window  *float64 `json:"window"`
	Actions []action `json:"actions"`
}
type result struct {
	Decision Decision `json:"decision"`
	Snapshot Snapshot `json:"snapshot"`
}

func ptr(v float64) *float64 { return &v }
func TestProgressAndHardDeadline(t *testing.T) {
	b := New(1000, 1000, nil, nil)
	if b.Evaluate(1999, ptr(1800)) != Wait {
		t.Fatal("early deadline")
	}
	if b.Evaluate(2000, ptr(1800)) != Extend {
		t.Fatal("recent progress did not extend")
	}
	if b.Evaluate(3000, ptr(2900)) != Stop {
		t.Fatal("hard deadline extended")
	}
}
func TestMatchesLegacyBudget(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for legacy oracle")
	}
	scenarios := []scenario{
		{1000, 1000000, nil, nil, []action{{1000999, nil}, {1001000, ptr(1000999)}, {1001249, ptr(1000999)}, {1001250, ptr(1001001)}, {1002000, ptr(1001999)}}},
		{1000, 1000000, nil, nil, []action{{1001000, nil}, {1001000, ptr(1000000)}, {1001000, ptr(1000499)}, {1001000, ptr(1000500)}}},
		{200, 1000000, ptr(100), ptr(10), []action{{1000200, ptr(1000199)}}},
		{101, 1000000, ptr(450), ptr(80), []action{{1000101, ptr(1000050)}, {1000151, ptr(1000140)}, {1000450, ptr(1000449)}}},
		{4000000, 1000000, nil, nil, []action{{5000000, ptr(4500000)}, {5900000, ptr(5800000)}, {9000000, ptr(8999999)}}},
	}
	payload, _ := json.Marshal(scenarios)
	path, err := filepath.Abs("../../../server/runtime-budget.js")
	if err != nil {
		t.Fatal(err)
	}
	js := `import {pathToFileURL} from 'node:url'; const {RuntimeBudget}=await import(pathToFileURL(process.argv[1]));let input='';for await(const c of process.stdin)input+=c;let cases=JSON.parse(input);console.log(JSON.stringify(cases.map(c=>{let opts={timeout:c.timeout,startedAt:c.start};if(c.max!==null)opts.maxTimeout=c.max;if(c.window!==null)opts.progressWindow=c.window;let b=new RuntimeBudget(opts);return c.actions.map(a=>({decision:b.evaluate(a.now,a.progress),snapshot:b.snapshot(a.progress)}))})));`
	cmd := exec.Command(node, "--input-type=module", "-e", js, path)
	cmd.Stdin = bytes.NewReader(payload)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("oracle: %s %v", out, err)
	}
	var expected [][]result
	if err = json.Unmarshal(out, &expected); err != nil {
		t.Fatal(err)
	}
	for i, c := range scenarios {
		b := New(c.Timeout, c.Start, c.Max, c.Window)
		for j, a := range c.Actions {
			decision := b.Evaluate(a.Now, a.Progress)
			snapshot, err := b.Snapshot(a.Progress)
			if err != nil {
				t.Fatal(err)
			}
			got := result{decision, snapshot}
			if !reflect.DeepEqual(got, expected[i][j]) {
				t.Errorf("case %d step %d: got %#v want %#v", i, j, got, expected[i][j])
			}
		}
	}
}

func TestInvalidAndExtendedSnapshotDates(t *testing.T) {
	b := New(1000, 1000000, nil, nil)
	nan := math.NaN()
	snap, err := b.Snapshot(&nan)
	if err != nil || snap.LastProgressAt != nil {
		t.Fatalf("NaN should be omitted: %#v %v", snap, err)
	}
	inf := math.Inf(1)
	if _, err = b.Snapshot(&inf); err == nil {
		t.Fatal("infinite progress must fail")
	}
	for _, tc := range []struct {
		value float64
		want  string
	}{{-0.9, "1970-01-01T00:00:00.000Z"}, {253402300800000, "+010000-01-01T00:00:00.000Z"}, {-62198755200000, "-000001-01-01T00:00:00.000Z"}} {
		got, err := iso(tc.value)
		if err != nil || got != tc.want {
			t.Errorf("%v got %s %v", tc.value, got, err)
		}
	}
}
