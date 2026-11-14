// Package workspace provides repository-agnostic inspection and fingerprints.
// It also owns worktree preparation, leases and guarded cleanup.
package workspace

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"relay.local/relay/internal/process"
)

type Runner struct {
	WorkerExecutable string
	WorkerArgs       []string
	Environment      map[string]string
}
type Profile struct{ Path, Cwd string }
type Info struct{ Root, Cwd, RelativeCwd string }
type Workspace struct{ RepositoryID, Root string }

func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel)
}
func (r Runner) git(ctx context.Context, cwd string, args ...string) (string, error) {
	if len(args) == 0 {
		return "", errors.New("git operation required")
	}
	timeout := 2 * time.Minute
	if args[0] == "worktree" || args[0] == "status" || args[0] == "diff" || args[0] == "ls-files" || args[0] == "read-tree" {
		timeout = 10 * time.Minute
	}
	result, err := process.Run(ctx, process.Options{WorkerExecutable: r.WorkerExecutable, WorkerArgs: r.WorkerArgs, Command: "git", Args: append([]string{"-C", cwd}, args...), Directory: cwd, Environment: r.Environment, Timeout: timeout, MaxOutputBytes: 8 * 1024 * 1024})
	if err != nil {
		return "", fmt.Errorf("git %s in %s: %w", args[0], cwd, err)
	}
	if result.ExitCode != 0 {
		detail := strings.TrimSpace(result.Stderr)
		if detail == "" {
			detail = strings.TrimSpace(result.Stdout)
		}
		return "", fmt.Errorf("git %s failed: %s", args[0], detail)
	}
	if !utf8.ValidString(result.Stdout) {
		return "", errors.New("git output is not valid UTF-8")
	}
	return result.Stdout, nil
}

// gitInto runs git with its standard output streamed into sink rather than collected, for
// output that is only folded (hashed) and may be far larger than a preview limit.
func (r Runner) gitInto(ctx context.Context, cwd string, sink io.Writer, args ...string) error {
	if len(args) == 0 {
		return errors.New("git operation required")
	}
	result, err := process.Run(ctx, process.Options{WorkerExecutable: r.WorkerExecutable, WorkerArgs: r.WorkerArgs, Command: "git", Args: append([]string{"-C", cwd}, args...), Directory: cwd, Environment: r.Environment, Timeout: 10 * time.Minute, MaxOutputBytes: 1024 * 1024, StdoutSink: sink})
	if err != nil {
		return fmt.Errorf("git %s in %s: %w", args[0], cwd, err)
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("git %s failed: %s", args[0], strings.TrimSpace(result.Stderr))
	}
	return nil
}
func (r Runner) Inspect(ctx context.Context, profile Profile) (Info, error) {
	if !filepath.IsAbs(profile.Path) {
		return Info{}, errors.New("repository path must be absolute")
	}
	path, err := filepath.EvalSymlinks(profile.Path)
	if err != nil {
		return Info{}, err
	}
	output, err := r.git(ctx, path, "rev-parse", "--show-toplevel")
	if err != nil {
		return Info{}, err
	}
	root, err := filepath.EvalSymlinks(strings.TrimSpace(output))
	if err != nil {
		return Info{}, err
	}
	cwd := profile.Cwd
	if cwd == "" {
		cwd = "."
	}
	if !filepath.IsAbs(cwd) {
		cwd = filepath.Join(path, cwd)
	}
	cwd, err = filepath.EvalSymlinks(cwd)
	if err != nil {
		return Info{}, err
	}
	if !within(root, cwd) {
		return Info{}, errors.New("working directory must be inside the repository")
	}
	rel, err := filepath.Rel(root, cwd)
	if err != nil {
		return Info{}, err
	}
	if rel == "." {
		rel = ""
	}
	return Info{root, cwd, rel}, nil
}

// CommonDirectory resolves the shared Git directory for all linked worktrees,
// so separate paths belonging to one repository can share a writer reservation.
func (r Runner) CommonDirectory(ctx context.Context, profile Profile) (string, error) {
	info, err := r.Inspect(ctx, profile)
	if err != nil {
		return "", err
	}
	output, err := r.git(ctx, info.Root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return "", err
	}
	path, err := filepath.EvalSymlinks(strings.TrimSpace(output))
	if err != nil {
		return "", err
	}
	stat, err := os.Stat(path)
	if err != nil || !stat.IsDir() {
		return "", errors.New("Git common directory is unavailable")
	}
	return filepath.Abs(path)
}

// VerifyExisting checks a retained task checkout without resetting or cleaning
// it. It is safe to inspect dirty work when resuming a read-only stage.
func (r Runner) VerifyExisting(ctx context.Context, source Profile, root, cwd, branch, baseCommit string) error {
	return r.verifyExisting(ctx, source, root, cwd, branch, baseCommit, false)
}

// Head is the commit the checkout is on.
func (r Runner) Head(ctx context.Context, root string) (string, error) {
	if !filepath.IsAbs(root) {
		return "", errors.New("workspace root must be absolute")
	}
	head, err := r.git(ctx, root, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if head = strings.TrimSpace(head); !commitPattern.MatchString(head) {
		return "", errors.New("workspace head is not a commit")
	}
	return head, nil
}

// ForkPoint is where the checkout's branch left the mainline: of the usual mainline branches,
// local and remote-tracking, the merge base nearest to head. It is empty when the repository
// has none of them. A branch rebased onto a newer mainline has a newer fork point.
func (r Runner) ForkPoint(ctx context.Context, root, head string) (string, error) {
	if !filepath.IsAbs(root) || !commitPattern.MatchString(head) {
		return "", errors.New("workspace and head commit are required")
	}
	refs, err := r.git(ctx, root, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes")
	if err != nil {
		return "", err
	}
	best, distance, tried := "", -1, 0
	for _, ref := range strings.Split(strings.TrimSpace(refs), "\n") {
		name := ref[strings.LastIndex(ref, "/")+1:]
		if name != "main" && name != "master" && name != "trunk" && !(name == "HEAD" && strings.HasPrefix(ref, "refs/remotes/")) {
			continue
		}
		if tried++; tried > 16 {
			break
		}
		base, err := r.git(ctx, root, "merge-base", head, ref)
		if err != nil {
			continue
		}
		base = strings.TrimSpace(base)
		if !commitPattern.MatchString(base) || base == head {
			continue
		}
		count, err := r.git(ctx, root, "rev-list", "--count", base+".."+head)
		if err != nil {
			continue
		}
		ahead, err := strconv.Atoi(strings.TrimSpace(count))
		if err != nil {
			continue
		}
		if distance < 0 || ahead < distance {
			best, distance = base, ahead
		}
	}
	return best, nil
}

// VerifyCommitted is VerifyExisting for a person about to work in the checkout: commits on top
// of the recorded base are theirs to inspect, so the branch may be ahead of it.
func (r Runner) VerifyCommitted(ctx context.Context, source Profile, root, cwd, branch, baseCommit string) error {
	return r.verifyExisting(ctx, source, root, cwd, branch, baseCommit, true)
}
func (r Runner) verifyExisting(ctx context.Context, source Profile, root, cwd, branch, baseCommit string, ahead bool) error {
	if !filepath.IsAbs(root) || !filepath.IsAbs(cwd) || branch == "" || !commitPattern.MatchString(baseCommit) {
		return errors.New("retained workspace metadata is incomplete")
	}
	sourceInfo, err := r.Inspect(ctx, source)
	if err != nil {
		return err
	}
	targetInfo, err := r.Inspect(ctx, Profile{Path: root, Cwd: cwd})
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	resolvedInfo, resolvedErr := os.Stat(resolved)
	targetRootInfo, targetErr := os.Stat(targetInfo.Root)
	sourceRootInfo, sourceErr := os.Stat(sourceInfo.Root)
	if resolvedErr != nil || targetErr != nil || sourceErr != nil || !os.SameFile(resolvedInfo, targetRootInfo) || os.SameFile(targetRootInfo, sourceRootInfo) {
		return errors.New("retained workspace is not a separate checkout")
	}
	sourceCommon, err := r.CommonDirectory(ctx, source)
	if err != nil {
		return err
	}
	targetCommon, err := r.CommonDirectory(ctx, Profile{Path: root, Cwd: cwd})
	if err != nil {
		return err
	}
	sourceCommonInfo, sourceErr := os.Stat(sourceCommon)
	targetCommonInfo, targetErr := os.Stat(targetCommon)
	if sourceErr != nil || targetErr != nil || !os.SameFile(sourceCommonInfo, targetCommonInfo) {
		return errors.New("retained workspace belongs to a different repository")
	}
	actualBranch, err := r.git(ctx, targetInfo.Root, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return err
	}
	if strings.TrimSpace(actualBranch) != branch {
		return errors.New("retained workspace branch changed")
	}
	head, err := r.git(ctx, targetInfo.Root, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	if head = strings.TrimSpace(head); head != baseCommit {
		descends := false
		if ahead && commitPattern.MatchString(head) {
			if descends, err = r.IsAncestor(ctx, targetInfo.Root, baseCommit, head); err != nil {
				return err
			}
		}
		if !descends {
			return errors.New("retained workspace base changed; inspect it before resuming")
		}
	}
	return ctx.Err()
}
func jsLess(a, b string) bool {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}
func jsonString(value string) (string, error) {
	if !utf8.ValidString(value) {
		return "", errors.New("invalid UTF-8 repository ID")
	}
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String(), nil
}
func (r Runner) singleFingerprint(ctx context.Context, entry Workspace) (string, error) {
	if !filepath.IsAbs(entry.Root) {
		return "", errors.New("workspace root must be absolute")
	}
	root, err := filepath.EvalSymlinks(entry.Root)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	head, err := r.git(ctx, root, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	_, _ = hash.Write([]byte(strings.TrimRight(head, "\r\n")))
	// The diffs are hashed as they stream, so a large change (a merge of a busy mainline, say)
	// costs time, not a failure. The bytes hashed are the same as when they were collected.
	for _, args := range [][]string{{"diff", "--binary", "HEAD", "--"}, {"diff", "--cached", "--binary", "--"}} {
		if err := r.gitInto(ctx, root, hash, args...); err != nil {
			return "", err
		}
	}
	output, err := r.git(ctx, root, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return "", err
	}
	if output != "" && !strings.HasSuffix(output, "\x00") {
		return "", errors.New("incomplete untracked-file listing")
	}
	names := strings.Split(output, "\x00")
	names = names[:len(names)-1]
	sort.Slice(names, func(i, j int) bool { return jsLess(names[i], names[j]) })
	for _, name := range names {
		if name == "" {
			continue
		}
		if filepath.IsAbs(name) || !within(root, filepath.Join(root, name)) {
			return "", errors.New("untracked path escapes workspace")
		}
		path := filepath.Join(root, name)
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			return "", err
		}
		if !within(root, resolved) {
			return "", errors.New("untracked path escapes workspace")
		}
		content, err := readUntracked(path)
		if err != nil {
			return "", fmt.Errorf("untracked file %s: %w", name, err)
		}
		_, _ = hash.Write([]byte(name))
		_, _ = hash.Write(content)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

type FingerprintSnapshot struct {
	Combined     string
	Repositories map[string]string
}

// Snapshot hashes each workspace once and combines results in repository order.
func (r Runner) Snapshot(ctx context.Context, entries []Workspace) (FingerprintSnapshot, error) {
	if len(entries) == 0 {
		return FingerprintSnapshot{}, errors.New("at least one workspace is required")
	}
	snapshot := FingerprintSnapshot{Repositories: map[string]string{}}
	var joined bytes.Buffer
	joined.WriteByte('[')
	for i, entry := range entries {
		if entry.RepositoryID == "" {
			return FingerprintSnapshot{}, errors.New("repository ID required")
		}
		if _, exists := snapshot.Repositories[entry.RepositoryID]; exists {
			return FingerprintSnapshot{}, errors.New("duplicate repository ID")
		}
		fingerprint, err := r.singleFingerprint(ctx, entry)
		if err != nil {
			return FingerprintSnapshot{}, err
		}
		snapshot.Repositories[entry.RepositoryID] = fingerprint
		id, err := jsonString(entry.RepositoryID)
		if err != nil {
			return FingerprintSnapshot{}, err
		}
		if i > 0 {
			joined.WriteByte(',')
		}
		fmt.Fprintf(&joined, "[%s,\"%s\"]", id, fingerprint)
	}
	joined.WriteByte(']')
	if len(entries) == 1 {
		snapshot.Combined = snapshot.Repositories[entries[0].RepositoryID]
	} else {
		sum := sha256.Sum256(joined.Bytes())
		snapshot.Combined = hex.EncodeToString(sum[:])
	}
	return snapshot, nil
}
func (r Runner) Fingerprint(ctx context.Context, entries []Workspace) (string, error) {
	if len(entries) == 1 && entries[0].RepositoryID == "" {
		return r.singleFingerprint(ctx, entries[0])
	}
	snapshot, err := r.Snapshot(ctx, entries)
	return snapshot.Combined, err
}
