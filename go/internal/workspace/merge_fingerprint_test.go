package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Mid-merge the fingerprint reads object ids instead of patching the whole staged mainline, and it
// still changes whenever the resolution, the index or another staged file changes.
func TestMergeFingerprintTracksResolutionWithoutPatchingTheMerge(t *testing.T) {
	root := fixture(t)
	gitFixture(t, root, "checkout", "-q", "-b", "side")
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("tracked.txt", "side\n")
	gitFixture(t, root, "commit", "-qam", "side")
	gitFixture(t, root, "checkout", "-q", "-")
	write("tracked.txt", "main\n")
	write("other.txt", "mainline only\n")
	gitFixture(t, root, "add", "-A")
	gitFixture(t, root, "commit", "-qm", "main")
	// The merge stops on the conflict; other.txt is staged from the mainline side.
	cmd := exec.Command("git", "-C", root, "-c", "core.fsmonitor=false", "merge", "side")
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=F", "GIT_AUTHOR_EMAIL=f@example.invalid", "GIT_COMMITTER_NAME=F", "GIT_COMMITTER_EMAIL=f@example.invalid")
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("merge did not conflict: %s", out)
	}
	r := runner(t)
	if merging, err := r.merging(context.Background(), root); err != nil || !merging {
		t.Fatalf("merge not detected: %v %v", merging, err)
	}
	print := func() string {
		t.Helper()
		value, err := r.Fingerprint(context.Background(), []Workspace{{RepositoryID: "repo", Root: root}})
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	conflicted := print()
	if again := print(); again != conflicted {
		t.Fatal("merge fingerprint is not stable")
	}
	write("tracked.txt", "resolved\n")
	resolved := print()
	if resolved == conflicted {
		t.Fatal("resolving the conflict did not change the fingerprint")
	}
	gitFixture(t, root, "add", "tracked.txt")
	if staged := print(); staged == resolved {
		t.Fatal("staging the resolution did not change the fingerprint")
	}
	write("other.txt", "edited during the merge\n")
	gitFixture(t, root, "add", "other.txt")
	if edited := print(); edited == resolved {
		t.Fatal("a staged edit elsewhere did not change the fingerprint")
	}
}
