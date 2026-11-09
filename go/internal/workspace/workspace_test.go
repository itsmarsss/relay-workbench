//go:build darwin || linux

package workspace

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"relay.local/relay/internal/process"
)

func TestGitWorker(t *testing.T) {
	if os.Getenv("RELAY_WORKSPACE_WORKER") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Exit(process.Worker(os.Args[i+1:]))
		}
	}
	os.Exit(127)
}
func runner(t *testing.T) Runner {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return Runner{WorkerExecutable: executable, WorkerArgs: []string{"-test.run=^TestGitWorker$", "--"}, Environment: map[string]string{"RELAY_WORKSPACE_WORKER": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}}
}
func gitFixture(t *testing.T, root string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", root, "-c", "core.fsmonitor=false"}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.invalid", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.invalid")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git fixture: %s: %v", out, err)
	}
}
func fixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	gitFixture(t, root, "init", "-q")
	if err := os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("original\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitFixture(t, root, "add", "tracked.txt")
	gitFixture(t, root, "commit", "-q", "-m", "fixture")
	return root
}
func legacyFingerprint(t *testing.T, entries []Workspace) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for legacy oracle")
	}
	path, err := filepath.Abs("../../../server/workspace.js")
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(entries)
	js := `import {pathToFileURL} from 'node:url';const {fingerprint}=await import(pathToFileURL(process.argv[1]));let s='';for await(const c of process.stdin)s+=c;const entries=JSON.parse(s);const task=entries.length===1?{workspaceRoot:entries[0].Root,repository:{id:entries[0].RepositoryID}}:{repositories:entries.map(e=>({workspaceRoot:e.Root,repository:{id:e.RepositoryID}}))};console.log(await fingerprint(task));`
	cmd := exec.Command(node, "--input-type=module", "-e", js, path)
	cmd.Stdin = strings.NewReader(string(payload))
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("legacy oracle: %v", err)
	}
	return strings.TrimSpace(string(out))
}
func TestFingerprintMatchesLegacyForChangedAndCrossRepoWorkspaces(t *testing.T) {
	r := runner(t)
	first := fixture(t)
	second := fixture(t)
	if err := os.WriteFile(filepath.Join(first, "tracked.txt"), []byte("changed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(first, "untracked.txt"), []byte("new file\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(second, "tracked.txt"), []byte("staged\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitFixture(t, second, "add", "tracked.txt")
	for _, entries := range [][]Workspace{{{RepositoryID: "one", Root: first}}, {{RepositoryID: "one<\u2028", Root: first}, {RepositoryID: "two", Root: second}}} {
		got, err := r.Fingerprint(context.Background(), entries)
		if err != nil {
			t.Fatal(err)
		}
		want := legacyFingerprint(t, entries)
		if got != want {
			t.Fatalf("fingerprint %s want %s", got, want)
		}
	}
}
func TestInspectRejectsWorkingDirectoryOutsideRepository(t *testing.T) {
	r := runner(t)
	root := fixture(t)
	outside := t.TempDir()
	if _, err := r.Inspect(context.Background(), Profile{Path: root, Cwd: outside}); err == nil {
		t.Fatal("outside directory accepted")
	}
	info, err := r.Inspect(context.Background(), Profile{Path: root, Cwd: "."})
	if err != nil {
		t.Fatal(err)
	}
	if info.RelativeCwd != "" || info.Root == "" {
		t.Fatalf("info %#v", info)
	}
}
func TestFingerprintRejectsUntrackedSymlinkAndOversizedFile(t *testing.T) {
	r := runner(t)
	root := fixture(t)
	link := filepath.Join(root, "link")
	if err := os.Symlink(filepath.Join(t.TempDir(), "missing"), link); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Fingerprint(context.Background(), []Workspace{{Root: root}}); err == nil {
		t.Fatal("symlink accepted")
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(filepath.Join(root, "large.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err = file.Truncate(16*1024*1024 + 1); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	if _, err = r.Fingerprint(context.Background(), []Workspace{{Root: root}}); err == nil {
		t.Fatal("oversized file accepted")
	}
}

func TestUntrackedInspectionRejectsSymlinksAndPipesWithoutBlocking(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("content"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readUntracked(link); err == nil {
		t.Fatal("symlink was followed")
	}
	pipe := filepath.Join(dir, "pipe")
	if err := syscall.Mkfifo(pipe, 0600); err != nil {
		t.Skipf("FIFO unavailable: %v", err)
	}
	done := make(chan error, 1)
	go func() { _, err := readUntracked(pipe); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("FIFO accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("FIFO blocked inspection")
	}
}
