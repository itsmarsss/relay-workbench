// Package workspace provides repository-agnostic inspection and fingerprints.
// Worktree creation and workspace leases are not yet implemented.
package workspace

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
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
	result, err := process.Run(ctx, process.Options{WorkerExecutable: r.WorkerExecutable, WorkerArgs: r.WorkerArgs, Command: "git", Args: append([]string{"-C", cwd}, args...), Directory: cwd, Environment: r.Environment, Timeout: 2 * time.Minute, MaxOutputBytes: 8 * 1024 * 1024})
	if err != nil {
		return "", err
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
	for _, args := range [][]string{{"diff", "--binary", "HEAD", "--"}, {"diff", "--cached", "--binary", "--"}} {
		output, err := r.git(ctx, root, args...)
		if err != nil {
			return "", err
		}
		_, _ = hash.Write([]byte(output))
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
