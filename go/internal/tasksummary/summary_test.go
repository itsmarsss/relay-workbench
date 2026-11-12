package tasksummary

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSummaryMatchesLegacyRunSelection(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for differential oracle")
	}
	base := func() map[string]any {
		return map[string]any{"id": "550e8400-e29b-41d4-a716-446655440000", "title": "task", "status": "running", "stage": "implement", "repository": map[string]any{"id": "r", "name": "repo", "path": "private"}, "attempts": []any{}, "deliveryRuns": []any{}}
	}
	cases := []map[string]any{base()}
	a := base()
	a["attempts"] = []any{map[string]any{"id": "a", "stage": "implement", "status": "running", "harness": "codex", "startedAt": "2025-01-01T00:00:00Z", "handoff": map[string]any{"summary": "one"}}, map[string]any{"id": "b", "stage": "review", "status": "complete", "harness": "claude", "startedAt": "2025-01-01T00:01:00Z", "handoff": map[string]any{"summary": "two"}}}
	cases = append(cases, a)
	b := base()
	b["status"] = "completed"
	b["attempts"] = a["attempts"]
	b["deliveryRuns"] = []any{map[string]any{"id": "f", "stage": "followup", "status": "running", "auxiliary": true, "harness": "codex", "startedAt": "2025-01-01T00:02:00Z", "summary": "follow up"}, map[string]any{"id": "m", "stage": "monitor", "status": "running", "auxiliary": true, "startedAt": "2025-01-01T00:03:00Z"}}
	cases = append(cases, b)
	c := base()
	c["status"] = "completed"
	c["delivery"] = map[string]any{"id": "p", "status": "blocked", "startedAt": "2025-01-01T00:04:00Z", "error": "blocked"}
	cases = append(cases, c)
	d := base()
	d["attempts"] = []any{map[string]any{"id": "a", "stage": "investigate", "status": "running", "startedAt": "2025-01-01T00:00:00Z"}}
	d["currentRun"] = map[string]any{"id": "a", "stage": "implement", "status": "running", "harness": "pi", "startedAt": "2025-01-01T00:01:00Z"}
	cases = append(cases, d)
	e := base()
	e["status"] = "paused"
	e["repositories"] = []any{map[string]any{"repository": map[string]any{"id": "one", "name": "one"}, "delivery": map[string]any{"id": "p1", "status": "idle", "startedAt": "2025-01-01T00:00:00Z", "summary": "first"}}, map[string]any{"repository": map[string]any{"id": "two", "name": "two"}, "delivery": map[string]any{"id": "p2", "status": "paused", "startedAt": "2025-01-01T00:01:00Z", "summary": "second"}}}
	cases = append(cases, e)
	script, err := filepath.Abs("../../../server/app.js")
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(cases)
	js := `import {pathToFileURL} from 'node:url'; const {taskListSummary}=await import(pathToFileURL(process.argv[1])); let data='';for await (const c of process.stdin) data+=c;const keys=['id','title','status','stage','updatedAt','error','repository','currentRun','latestSummary'];console.log(JSON.stringify(JSON.parse(data).map(t=>{let s=taskListSummary(t);return Object.fromEntries(keys.filter(k=>s[k]!==undefined).map(k=>[k,s[k]]))})));`
	cmd := exec.Command(node, "--input-type=module", "-e", js, script)
	cmd.Stdin = bytes.NewReader(payload)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("oracle: %s: %v", out, err)
	}
	var expected []map[string]any
	if err = json.Unmarshal(out, &expected); err != nil {
		t.Fatal(err)
	}
	for i, fixture := range cases {
		raw, _ := json.Marshal(fixture)
		got, err := Summarize(raw)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, expected[i]) {
			t.Errorf("case %d got %#v want %#v", i, got, expected[i])
		}
	}
}

func TestSummaryListsObservedAndHandLinkedPullRequests(t *testing.T) {
	summarize := func(task map[string]any) []any {
		t.Helper()
		task["id"], task["title"], task["status"] = "550e8400-e29b-41d4-a716-446655440000", "task", "completed"
		raw, err := json.Marshal(task)
		if err != nil {
			t.Fatal(err)
		}
		summary, err := Summarize(raw)
		if err != nil {
			t.Fatal(err)
		}
		links, _ := summary["pullRequests"].([]any)
		return links
	}
	repository := map[string]any{"id": "r", "name": "repo", "path": "private"}
	if links := summarize(map[string]any{"repository": repository}); links != nil {
		t.Fatalf("links without a pull request: %v", links)
	}
	observed := map[string]any{"url": "https://example.test/org/repo/pull/12", "number": float64(12), "title": "private title", "state": "open", "draft": false, "checks": "pending", "review": "required", "checkedAt": "2026-01-02T03:04:05Z"}
	linked := map[string]any{"url": "https://example.test/org/repo/pull/7", "number": "7", "state": "open", "draft": true, "checkedAt": "2026-01-01T00:00:00Z"}
	// What Relay observed wins over a hand-entered link.
	got := summarize(map[string]any{"repository": repository, "publication": observed, "pullRequestLink": linked})
	want := []any{map[string]any{"url": "https://example.test/org/repo/pull/12", "number": "12", "manual": false, "repositoryId": "r", "state": "open", "draft": false, "checks": "pending", "review": "required", "checkedAt": "2026-01-02T03:04:05Z"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("observed %v", got)
	}
	got = summarize(map[string]any{"repository": repository, "publication": map[string]any{"state": "not_created"}, "pullRequestLink": linked})
	want = []any{map[string]any{"url": "https://example.test/org/repo/pull/7", "number": "7", "manual": true, "repositoryId": "r", "state": "open", "draft": true, "checks": "unknown", "review": "unknown", "checkedAt": "2026-01-01T00:00:00Z"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("linked %v", got)
	}
	// Stored links that are not plain web addresses never reach the page.
	for _, address := range []string{"javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.test/pull/1", "https:///pull/1", "example.test/pull/1", ""} {
		if links := summarize(map[string]any{"repository": repository, "pullRequestLink": map[string]any{"url": address, "state": "open"}}); links != nil {
			t.Fatalf("%q listed: %v", address, links)
		}
	}
	// Each repository of a multi-repository task reports its own pull request.
	got = summarize(map[string]any{"repository": repository, "pullRequestLink": linked, "repositories": []any{
		map[string]any{"repository": map[string]any{"id": "one"}, "publication": observed},
		map[string]any{"repository": map[string]any{"id": "two"}},
		map[string]any{"repository": map[string]any{"id": "three"}, "pullRequestLink": linked},
	}})
	if len(got) != 2 || got[0].(map[string]any)["repositoryId"] != "one" || got[1].(map[string]any)["repositoryId"] != "three" || got[1].(map[string]any)["manual"] != true {
		t.Fatalf("repositories %v", got)
	}
}
