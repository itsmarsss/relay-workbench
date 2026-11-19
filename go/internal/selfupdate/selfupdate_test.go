package selfupdate

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type memory map[string]string

func (m memory) GetMeta(key string) (string, bool, error) { v, ok := m[key]; return v, ok, nil }
func (m memory) SetMeta(key, value string) error          { m[key] = value; return nil }

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=T", "GIT_AUTHOR_EMAIL=t@example.invalid", "GIT_COMMITTER_NAME=T", "GIT_COMMITTER_EMAIL=t@example.invalid")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %s", args, out)
	}
	return strings.TrimSpace(string(out))
}

// A clone of a remote whose main has one more commit, laid out the way Relay builds itself.
func fixture(t *testing.T) (*Updater, string, string, *[]string) {
	t.Helper()
	remote := filepath.Join(t.TempDir(), "remote.git")
	seed := t.TempDir()
	git(t, seed, "init", "-q", "-b", "main")
	for _, path := range []string{"go/go.mod", "web/package.json", "README.md"} {
		_ = os.MkdirAll(filepath.Join(seed, filepath.Dir(path)), 0o755)
		_ = os.WriteFile(filepath.Join(seed, path), []byte("v1\n"), 0o644)
	}
	_ = os.WriteFile(filepath.Join(seed, ".gitignore"), []byte(".relay/\n"), 0o644)
	git(t, seed, "add", "-A")
	git(t, seed, "commit", "-q", "-m", "v1")
	git(t, seed, "init", "-q", "-b", "main", "--bare", remote)
	git(t, seed, "push", "-q", remote, "main")
	root := filepath.Join(t.TempDir(), "relay")
	git(t, seed, "clone", "-q", remote, root)
	_ = os.WriteFile(filepath.Join(seed, "README.md"), []byte("v2\n"), 0o644)
	git(t, seed, "commit", "-q", "-am", "v2")
	git(t, seed, "push", "-q", remote, "main")
	binary := filepath.Join(root, ".relay", "bin", "relay-go")
	_ = os.MkdirAll(filepath.Dir(binary), 0o755)
	_ = os.WriteFile(binary, []byte("old"), 0o755)
	commands := []string{}
	u := &Updater{Root: root, Binary: binary, Store: memory{}, Checks: func(context.Context, string) (string, error) { return "success", nil }}
	u.Run = func(ctx context.Context, dir, name string, args ...string) (string, error) {
		if name == "git" {
			cmd := exec.CommandContext(ctx, name, args...)
			cmd.Dir = dir
			cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
			out, err := cmd.CombinedOutput()
			if err != nil {
				return string(out), errors.New(string(out))
			}
			return string(out), nil
		}
		commands = append(commands, name+" "+strings.Join(args, " "))
		if name == "go" {
			return "", os.WriteFile(args[len(args)-2], []byte("new"), 0o755)
		}
		return "", nil
	}
	return u, root, git(t, root, "rev-parse", "HEAD"), &commands
}

func TestUpdatesToACommitThatPassedCIAndRestarts(t *testing.T) {
	u, root, before, commands := fixture(t)
	if !u.Check(context.Background()) {
		t.Fatalf("no restart: %+v", u.Status())
	}
	if git(t, root, "rev-parse", "HEAD") == before {
		t.Fatal("checkout was not fast-forwarded")
	}
	if data, _ := os.ReadFile(u.Binary); string(data) != "new" {
		t.Fatal("binary was not replaced")
	}
	if len(*commands) != 3 || !strings.HasPrefix((*commands)[0], "pnpm install") {
		t.Fatalf("unexpected build: %v", *commands)
	}
	if u.Check(context.Background()) || u.Status().State != "current" {
		t.Fatalf("second check was not a no-op: %+v", u.Status())
	}
}

func TestDoesNotUpdateWithoutPassingCIOrOnALocalCheckoutThatChanged(t *testing.T) {
	for name, prepare := range map[string]func(u *Updater, root string){
		"pending": func(u *Updater, _ string) {
			u.Checks = func(context.Context, string) (string, error) { return "pending", nil }
		},
		"failure": func(u *Updater, _ string) {
			u.Checks = func(context.Context, string) (string, error) { return "failure", nil }
		},
		"busy": func(u *Updater, _ string) { u.Busy = func() bool { return true } },
		"dirty": func(_ *Updater, root string) {
			_ = os.WriteFile(filepath.Join(root, "README.md"), []byte("mine\n"), 0o644)
		},
		"branch": func(_ *Updater, root string) { git(t, root, "switch", "-q", "-c", "feature") },
		"diverged": func(_ *Updater, root string) {
			_ = os.WriteFile(filepath.Join(root, "local.txt"), []byte("x"), 0o644)
			git(t, root, "add", "local.txt")
			git(t, root, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "local")
		},
	} {
		t.Run(name, func(t *testing.T) {
			u, root, _, commands := fixture(t)
			prepare(u, root)
			head := git(t, root, "rev-parse", "HEAD")
			if u.Check(context.Background()) {
				t.Fatal("restarted")
			}
			if git(t, root, "rev-parse", "HEAD") != head || len(*commands) != 0 {
				t.Fatalf("checkout changed or built: %v", *commands)
			}
			if state := u.Status().State; state != "waiting" && state != "skipped" {
				t.Fatalf("state %s: %s", state, u.Status().Summary)
			}
		})
	}
}

func TestAFailedBuildRollsBack(t *testing.T) {
	u, root, before, _ := fixture(t)
	run := u.Run
	u.Run = func(ctx context.Context, dir, name string, args ...string) (string, error) {
		if name == "go" {
			return "", errors.New("compile error")
		}
		return run(ctx, dir, name, args...)
	}
	if u.Check(context.Background()) {
		t.Fatal("restarted after a failed build")
	}
	if git(t, root, "rev-parse", "HEAD") != before {
		t.Fatal("checkout was not rolled back")
	}
	if data, _ := os.ReadFile(u.Binary); string(data) != "old" {
		t.Fatal("running binary was replaced")
	}
	if u.Status().State != "failed" {
		t.Fatalf("state %+v", u.Status())
	}
}

func TestSettingsAndCheckResults(t *testing.T) {
	u, _, _, _ := fixture(t)
	if !u.Status().Enabled {
		t.Fatal("updates should be on by default")
	}
	if err := u.SetEnabled(false); err != nil || u.Status().Enabled {
		t.Fatal("could not turn updates off")
	}
	for body, want := range map[string]string{
		`{"total_count":0,"check_runs":[]}`: "pending",
		`{"total_count":2,"check_runs":[{"status":"completed","conclusion":"success"},{"status":"in_progress"}]}`:                      "pending",
		`{"total_count":2,"check_runs":[{"status":"completed","conclusion":"success"},{"status":"completed","conclusion":"skipped"}]}`: "success",
		`{"total_count":2,"check_runs":[{"status":"in_progress"},{"status":"completed","conclusion":"failure"}]}`:                      "failure",
	} {
		if got, err := checkState([]byte(body)); err != nil || got != want {
			t.Fatalf("%s: got %s %v", body, got, err)
		}
	}
	for url, want := range map[string]string{"https://github.com/o/r.git": "o/r", "git@github.com:o/r.git": "o/r", "https://github.com/o/r": "o/r", "https://example.com/o/r.git": ""} {
		owner, repo, ok := githubRepository(url)
		if got := owner + "/" + repo; ok && got != want || !ok && want != "" {
			t.Fatalf("%s: %s", url, got)
		}
	}
	if _, ok := Locate(os.Args[0]); ok {
		t.Fatal("a test binary was treated as an updatable checkout")
	}
}
