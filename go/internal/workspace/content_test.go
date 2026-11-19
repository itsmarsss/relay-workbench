//go:build darwin || linux

package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"relay.local/relay/internal/legacytest"
	"strings"
	"testing"
)

func legacyAcceptedContent(t *testing.T, root, base string) string {
	t.Helper()
	node, _ := exec.LookPath("node")
	path, err := filepath.Abs("../../../server/publication-workflow.js")
	if err != nil {
		t.Fatal(err)
	}
	js := `import {pathToFileURL} from 'node:url'; const {acceptedContent}=await import(pathToFileURL(process.argv[1])); console.log(await acceptedContent({workspaceRoot:process.argv[2],baseCommit:process.argv[3]}));`
	command := exec.Command(node, "--input-type=module", "-e", js, path, root, base)
	command.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	output, err := legacytest.Output(t, "workspace-content-1", command, true, root)
	if err != nil {
		t.Fatalf("legacy content oracle: %s %v", output, err)
	}
	return strings.TrimSpace(string(output))
}

func TestAcceptedContentSurvivesCommitAndMatchesLegacy(t *testing.T) {
	root := fixture(t)
	runner := runner(t)
	base, err := runner.git(context.Background(), root, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	base = strings.TrimSpace(base)
	if err = os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("changed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "new-é.txt"), []byte("new content\n"), 0700); err != nil {
		t.Fatal(err)
	}
	before, err := runner.AcceptedContent(context.Background(), root, base)
	if err != nil {
		t.Fatal(err)
	}
	if want := legacyAcceptedContent(t, root, base); before != want {
		t.Fatalf("content mismatch: %s != %s", before, want)
	}
	gitFixture(t, root, "add", "tracked.txt", "new-é.txt")
	gitFixture(t, root, "commit", "-q", "-m", "accepted fixture")
	after, err := runner.AcceptedContent(context.Background(), root, base)
	if err != nil || after != before {
		t.Fatalf("commit changed accepted content: %s %s %v", before, after, err)
	}
	if err = os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("unexpected\n"), 0600); err != nil {
		t.Fatal(err)
	}
	changed, err := runner.AcceptedContent(context.Background(), root, base)
	if err != nil || changed == before {
		t.Fatal("changed content was not detected")
	}
}

func TestAcceptedContentPreservesDeletionAndRejectsLinks(t *testing.T) {
	root := fixture(t)
	runner := runner(t)
	base, err := runner.git(context.Background(), root, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	base = strings.TrimSpace(base)
	if err = os.Remove(filepath.Join(root, "tracked.txt")); err != nil {
		t.Fatal(err)
	}
	deleted, err := runner.AcceptedContent(context.Background(), root, base)
	if err != nil || deleted != legacyAcceptedContent(t, root, base) {
		t.Fatalf("deletion mismatch: %s %v", deleted, err)
	}
	outside := filepath.Join(t.TempDir(), "secret")
	if err = os.WriteFile(outside, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err = runner.AcceptedContent(context.Background(), root, base); err == nil {
		t.Fatal("changed symlink was accepted")
	}
}
