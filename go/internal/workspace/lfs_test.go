package workspace

import "testing"

// Reads skip large-file downloads; commands that write the working tree keep real contents.
func TestReadOnlyGitSkipsLargeFileDownloads(t *testing.T) {
	r := Runner{Environment: map[string]string{"HOME": "/home/fixture"}}
	for _, read := range []string{"diff", "status", "ls-files"} {
		if env := r.gitEnvironment(read); env["GIT_LFS_SKIP_SMUDGE"] != "1" || env["HOME"] != "/home/fixture" {
			t.Fatalf("%s: %#v", read, env)
		}
	}
	for _, write := range []string{"merge", "checkout", "worktree"} {
		if _, set := r.gitEnvironment(write)["GIT_LFS_SKIP_SMUDGE"]; set {
			t.Fatalf("%s skips smudge", write)
		}
	}
	if _, set := r.Environment["GIT_LFS_SKIP_SMUDGE"]; set {
		t.Fatal("runner environment was modified")
	}
}
