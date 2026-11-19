// Package selfupdate keeps a Relay that runs from a clone of its own repository up to date.
//
// Every so often it fetches the mainline, and when a newer commit there has passed CI it waits
// until Relay is idle, fast-forwards the checkout, rebuilds the web app and the service, and
// asks the process to restart into the new build. It never touches a checkout with local
// changes, local commits or another branch checked out, never merges or rebases, and never
// updates to a commit whose checks failed or are still running. A failed build is rolled back.
package selfupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Status is what the page shows: whether updates are on and what the last check found.
type Status struct {
	Enabled   bool   `json:"enabled"`
	Available bool   `json:"available"` // running from an updatable checkout at all
	State     string `json:"state"`     // idle, checking, current, waiting, updating, restarting, skipped, failed
	Summary   string `json:"summary"`
	Current   string `json:"current,omitempty"`
	Latest    string `json:"latest,omitempty"`
	CheckedAt string `json:"checkedAt,omitempty"`
}

// Settings persist whether updates are on; Store is any key/value metadata store.
type Store interface {
	GetMeta(key string) (string, bool, error)
	SetMeta(key, value string) error
}

type Updater struct {
	Root     string // the source checkout
	Binary   string // the running executable, replaced by a rebuilt one
	Remote   string
	Branch   string
	Interval time.Duration
	Store    Store
	Busy     func() bool // whether agents, chats or terminals are working
	Restart  func()      // stops the server so the process can start the new build
	// Checks reports the CI state of a commit: "success", "pending" or "failure". Defaults to
	// the GitHub API for a GitHub remote.
	Checks func(ctx context.Context, sha string) (string, error)
	Run    func(ctx context.Context, dir string, name string, args ...string) (string, error)

	mu     sync.Mutex
	status Status
	wake   chan struct{}
}

const settingsKey = "updates:settings"

// Locate finds the source checkout a binary was built into: Relay's build puts it at
// <checkout>/.relay/bin/relay-go. Anything else (an installed binary, a test) is not updatable.
func Locate(binary string) (string, bool) {
	resolved, err := filepath.EvalSymlinks(binary)
	if err != nil {
		return "", false
	}
	bin := filepath.Dir(resolved)
	if filepath.Base(bin) != "bin" || filepath.Base(filepath.Dir(bin)) != ".relay" {
		return "", false
	}
	root := filepath.Dir(filepath.Dir(bin))
	for _, need := range []string{".git", "go/go.mod", "web/package.json"} {
		if _, err := os.Stat(filepath.Join(root, need)); err != nil {
			return "", false
		}
	}
	return root, true
}

func (u *Updater) enabled() bool {
	raw, exists, err := u.Store.GetMeta(settingsKey)
	if err != nil || !exists {
		return true
	}
	var settings struct {
		Enabled bool `json:"enabled"`
	}
	return json.Unmarshal([]byte(raw), &settings) != nil || settings.Enabled
}

// Status returns the latest state for the page.
func (u *Updater) Status() Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	status := u.status
	status.Enabled = u.enabled()
	status.Available = u.Root != ""
	if status.State == "" {
		status.State = "idle"
	}
	return status
}

// SetEnabled turns automatic updates on or off.
func (u *Updater) SetEnabled(on bool) error {
	raw, _ := json.Marshal(map[string]bool{"enabled": on})
	if err := u.Store.SetMeta(settingsKey, string(raw)); err != nil {
		return err
	}
	if on {
		u.CheckSoon()
	}
	return nil
}

// CheckSoon runs a check now instead of at the next interval.
func (u *Updater) CheckSoon() {
	u.mu.Lock()
	wake := u.wake
	u.mu.Unlock()
	if wake != nil {
		select {
		case wake <- struct{}{}:
		default:
		}
	}
}

func (u *Updater) set(state, summary string, update func(*Status)) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.status.State, u.status.Summary = state, summary
	u.status.CheckedAt = time.Now().UTC().Format(time.RFC3339)
	if update != nil {
		update(&u.status)
	}
}

// Loop checks shortly after start, then every Interval, until ctx ends.
func (u *Updater) Loop(ctx context.Context) {
	if u.Root == "" {
		return
	}
	u.mu.Lock()
	u.wake = make(chan struct{}, 1)
	wake := u.wake
	u.mu.Unlock()
	if u.Interval <= 0 {
		u.Interval = 30 * time.Minute
	}
	timer := time.NewTimer(2 * time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-wake:
		}
		if u.enabled() {
			restart := u.Check(ctx)
			if restart {
				u.Restart()
				return
			}
		}
		timer.Reset(u.Interval)
	}
}

func (u *Updater) run(ctx context.Context, dir, name string, args ...string) (string, error) {
	if u.Run != nil {
		return u.Run(ctx, dir, name, args...)
	}
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(out))
		if len(detail) > 800 {
			detail = detail[len(detail)-800:]
		}
		return string(out), fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, detail)
	}
	return string(out), nil
}

func (u *Updater) git(ctx context.Context, args ...string) (string, error) {
	out, err := u.run(ctx, u.Root, "git", args...)
	return strings.TrimSpace(out), err
}

// Check does one round. It returns true when a new build is in place and Relay should restart.
func (u *Updater) Check(ctx context.Context) bool {
	remote, branch := u.Remote, u.Branch
	if remote == "" {
		remote = "origin"
	}
	if branch == "" {
		branch = "main"
	}
	u.set("checking", "Checking for updates.", nil)
	current, err := u.git(ctx, "symbolic-ref", "--short", "HEAD")
	if err != nil || current != branch {
		u.set("skipped", "Not updating: this checkout is on "+orDetached(current)+", not "+branch+".", nil)
		return false
	}
	if _, err = u.git(ctx, "fetch", "--quiet", "--no-tags", remote, "+refs/heads/"+branch+":refs/remotes/"+remote+"/"+branch); err != nil {
		u.set("failed", "Could not fetch updates: "+err.Error(), nil)
		return false
	}
	head, err := u.git(ctx, "rev-parse", "HEAD")
	if err != nil {
		u.set("failed", err.Error(), nil)
		return false
	}
	latest, err := u.git(ctx, "rev-parse", remote+"/"+branch)
	if err != nil {
		u.set("failed", err.Error(), nil)
		return false
	}
	short := func(sha string) string {
		if len(sha) > 7 {
			return sha[:7]
		}
		return sha
	}
	record := func(s *Status) { s.Current, s.Latest = short(head), short(latest) }
	if head == latest {
		u.set("current", "Up to date.", record)
		return false
	}
	if _, err = u.git(ctx, "merge-base", "--is-ancestor", head, latest); err != nil {
		u.set("skipped", "Not updating: this checkout has commits that are not on "+remote+"/"+branch+".", record)
		return false
	}
	checks := u.Checks
	if checks == nil {
		url, _ := u.git(ctx, "remote", "get-url", remote)
		owner, repo, ok := githubRepository(url)
		if !ok {
			u.set("skipped", "Not updating: CI results are only read from GitHub remotes.", record)
			return false
		}
		checks = func(ctx context.Context, sha string) (string, error) { return u.githubChecks(ctx, owner, repo, sha) }
	}
	state, err := checks(ctx, latest)
	if err != nil {
		u.set("failed", "Could not read CI results: "+err.Error(), record)
		return false
	}
	switch state {
	case "pending":
		u.set("waiting", "An update ("+short(latest)+") is waiting for CI to finish.", record)
		return false
	case "failure":
		u.set("skipped", "Not updating to "+short(latest)+": its CI did not pass.", record)
		return false
	}
	if dirty, err := u.git(ctx, "status", "--porcelain", "--untracked-files=normal"); err != nil || dirty != "" {
		u.set("skipped", "Not updating: this checkout has uncommitted changes.", record)
		return false
	}
	if u.Busy != nil && u.Busy() {
		u.set("waiting", "Update "+short(latest)+" passed CI; it installs when nothing is running.", record)
		return false
	}
	u.set("updating", "Installing "+short(latest)+".", record)
	if _, err = u.git(ctx, "merge", "--ff-only", "--quiet", latest); err != nil {
		u.set("failed", "Could not fast-forward: "+err.Error(), record)
		return false
	}
	if err = u.build(ctx); err != nil {
		// Back to exactly what was running; the tree was clean before the fast-forward.
		_, _ = u.git(ctx, "reset", "--hard", "--quiet", head)
		_, _ = u.run(ctx, u.Root, "pnpm", "--dir", "web", "run", "build")
		u.set("failed", "The update did not build, so Relay stayed on "+short(head)+": "+err.Error(), record)
		return false
	}
	if u.Busy != nil && u.Busy() {
		// Work started while building: the new build is in place and starts at the next restart.
		u.set("waiting", "Update "+short(latest)+" is built; Relay restarts into it when nothing is running.", func(s *Status) { s.Current, s.Latest = short(latest), short(latest) })
		return u.waitIdle(ctx)
	}
	u.set("restarting", "Restarting into "+short(latest)+".", func(s *Status) { s.Current, s.Latest = short(latest), short(latest) })
	return true
}

func (u *Updater) waitIdle(ctx context.Context) bool {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
			if !u.Busy() {
				u.set("restarting", "Restarting into the update.", nil)
				return true
			}
		}
	}
}

func (u *Updater) build(ctx context.Context) error {
	if _, err := u.run(ctx, u.Root, "pnpm", "install", "--frozen-lockfile"); err != nil {
		return err
	}
	if _, err := u.run(ctx, u.Root, "pnpm", "--dir", "web", "run", "build"); err != nil {
		return err
	}
	next := u.Binary + ".next"
	if _, err := u.run(ctx, filepath.Join(u.Root, "go"), "go", "build", "-o", next, "./cmd/relay-go"); err != nil {
		_ = os.Remove(next)
		return err
	}
	if err := os.Rename(u.Binary, u.Binary+".previous"); err != nil {
		return err
	}
	return os.Rename(next, u.Binary)
}

var githubURL = regexp.MustCompile(`github\.com[:/]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$`)

func githubRepository(url string) (owner, repo string, ok bool) {
	match := githubURL.FindStringSubmatch(strings.TrimSpace(url))
	if match == nil {
		return "", "", false
	}
	return match[1], match[2], true
}

// githubChecks reads a commit's check runs. A private repository needs credentials: the gh
// CLI's login when it is installed, otherwise GITHUB_TOKEN.
func (u *Updater) githubChecks(ctx context.Context, owner, repo, sha string) (string, error) {
	endpoint := fmt.Sprintf("repos/%s/%s/commits/%s/check-runs?per_page=100", owner, repo, sha)
	var body []byte
	if _, err := exec.LookPath("gh"); err == nil {
		out, err := u.run(ctx, u.Root, "gh", "api", endpoint)
		if err != nil {
			return "", err
		}
		body = []byte(out)
	} else {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/"+endpoint, nil)
		if err != nil {
			return "", err
		}
		request.Header.Set("Accept", "application/vnd.github+json")
		if token := os.Getenv("GITHUB_TOKEN"); token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return "", err
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return "", fmt.Errorf("GitHub answered %s", response.Status)
		}
		if body, err = io.ReadAll(io.LimitReader(response.Body, 4<<20)); err != nil {
			return "", err
		}
	}
	return checkState(body)
}

// checkState folds check runs into one answer. No runs yet counts as pending: CI has not
// reported, so the commit is not known to pass.
func checkState(body []byte) (string, error) {
	var result struct {
		Total int `json:"total_count"`
		Runs  []struct {
			Status     string `json:"status"`
			Conclusion string `json:"conclusion"`
		} `json:"check_runs"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", err
	}
	if result.Total == 0 || len(result.Runs) == 0 {
		return "pending", nil
	}
	state := "success"
	for _, run := range result.Runs {
		switch {
		case run.Status != "completed":
			if state == "success" {
				state = "pending"
			}
		case run.Conclusion == "success" || run.Conclusion == "neutral" || run.Conclusion == "skipped":
		default:
			return "failure", nil
		}
	}
	return state, nil
}

func orDetached(branch string) string {
	if branch == "" {
		return "a detached commit"
	}
	return branch
}
