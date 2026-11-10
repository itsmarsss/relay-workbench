package discovery

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"relay.local/relay/internal/process"
	"relay.local/relay/internal/workspace"
	"strings"
	"testing"
)

func TestDiscoverySkipsLinksDependenciesAndBoundsRoots(t *testing.T) {
	root := t.TempDir()
	for _, p := range []string{"project/.git", "node_modules/dependency/.git", "deep/a/b/c/d/repo/.git"} {
		if err := os.MkdirAll(filepath.Join(root, p), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(root, "project"), filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	rows, err := Repositories(context.Background(), []string{root, root})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Name != "project" {
		t.Fatalf("unexpected scan: %#v", rows)
	}
	if _, err = Repositories(context.Background(), []string{"relative"}); err == nil {
		t.Fatal("relative root accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = Repositories(ctx, []string{root}); err == nil {
		t.Fatal("cancelled scan succeeded")
	}
}

func TestRepositoryReportIncludesScopeWarningsAndLimits(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 201; i++ {
		if err := os.MkdirAll(filepath.Join(root, fmt.Sprintf("repo-%03d", i), ".git"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	missing := filepath.Join(root, "missing")
	report, err := ScanRepositories(context.Background(), []string{root, missing})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Repositories) != 200 || !report.Truncated || !reflect.DeepEqual(report.Roots, []string{root, missing}) || len(report.Warnings) != 1 {
		t.Fatalf("incorrect report: repos=%d truncated=%t roots=%v warnings=%v", len(report.Repositories), report.Truncated, report.Roots, report.Warnings)
	}
}
func TestDiscoveryWorker(t *testing.T) {
	if os.Getenv("RELAY_DISCOVERY_WORKER") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Exit(process.Worker(os.Args[i+1:]))
		}
	}
	os.Exit(127)
}
func suggestionsFixture(t *testing.T) (string, workspace.Runner) {
	t.Helper()
	root := t.TempDir()
	if out, err := exec.Command("git", "init", "-q", root).CombinedOutput(); err != nil {
		t.Fatalf("git fixture: %s %v", out, err)
	}
	root, _ = filepath.EvalSymlinks(root)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return root, workspace.Runner{WorkerExecutable: executable, WorkerArgs: []string{"-test.run=^TestDiscoveryWorker$", "--"}, Environment: map[string]string{"RELAY_DISCOVERY_WORKER": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}}
}
func TestSuggestionsDetectMetadataWithoutExecutingIt(t *testing.T) {
	root, runner := suggestionsFixture(t)
	put := func(name, content string) {
		t.Helper()
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	put("package.json", `{"name":"fixture","packageManager":"unknown@1","scripts":{"test":"touch should-not-exist","lint":"exit 42"}}`)
	put("pnpm-lock.yaml", "lockfileVersion: 9\n"+strings.Repeat("# lock metadata\n", 20000))
	put("AGENTS.md", "Local guidance")
	put("packages/backend/go.mod", "module example.invalid/backend")
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "package.json"), []byte(`{"name":"outside"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "apps")); err != nil {
		t.Fatal(err)
	}
	result, err := Suggestions(context.Background(), runner, root, ".")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result["guidance"], []string{"AGENTS.md"}) {
		t.Fatalf("guidance: %#v", result["guidance"])
	}
	setup, checks, packages := 0, 0, 0
	for _, row := range result["suggestions"].([]map[string]any) {
		switch row["field"] {
		case "setup":
			setup++
			if !reflect.DeepEqual(row["value"], map[string]any{"command": "pnpm", "args": []string{"install", "--frozen-lockfile"}}) {
				t.Fatalf("setup: %#v", row)
			}
		case "checks":
			checks++
			if row["value"].(map[string]any)["command"] != "pnpm" {
				t.Fatalf("runner: %#v", row)
			}
		case "cwd":
			if row["value"] == "packages/backend" {
				packages++
			}
			if row["value"] == "apps" {
				t.Fatal("external link detected as package")
			}
		}
	}
	if setup != 1 || checks != 2 || packages != 1 {
		t.Fatalf("suggestions: %#v", result)
	}
	if _, err := os.Stat(filepath.Join(root, "should-not-exist")); !os.IsNotExist(err) {
		t.Fatal("metadata script was executed")
	}
}
func TestSuggestionsInheritRunnerWithoutRootInstall(t *testing.T) {
	root, runner := suggestionsFixture(t)
	if err := os.MkdirAll(filepath.Join(root, "packages/api"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"yarn.lock": "# lock", "packages/api/package.json": `{"scripts":{"test":"echo fixture"}}`} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	result, err := Suggestions(context.Background(), runner, root, "packages/api")
	if err != nil {
		t.Fatal(err)
	}
	checks := 0
	for _, row := range result["suggestions"].([]map[string]any) {
		if row["field"] == "setup" {
			t.Fatal("install suggested in package without local lock")
		}
		if row["field"] == "checks" {
			checks++
			if row["value"].(map[string]any)["command"] != "yarn" {
				t.Fatalf("root lock ignored: %#v", row)
			}
		}
	}
	if checks != 1 {
		t.Fatalf("checks: %#v", result)
	}
}
