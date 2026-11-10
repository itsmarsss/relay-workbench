package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// AcceptedContent hashes the changed file paths, executable bits and contents
// relative to a verified base. Committing the same content does not change it.
// Callers must hold a workspace lease and separately check source fingerprints.
func (r Runner) AcceptedContent(ctx context.Context, root, baseCommit string) (string, error) {
	if ctx == nil || !filepath.IsAbs(root) || !commitPattern.MatchString(baseCommit) {
		return "", errors.New("workspace and base commit are required")
	}
	info, err := r.Inspect(ctx, Profile{Path: root})
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	actual, err := os.Stat(info.Root)
	if err != nil {
		return "", err
	}
	requested, err := os.Stat(resolved)
	if err != nil || !os.SameFile(actual, requested) {
		return "", errors.New("workspace root changed")
	}
	env := map[string]string{}
	for key, value := range r.Environment {
		env[key] = value
	}
	env["GIT_OPTIONAL_LOCKS"] = "0"
	r.Environment = env
	paths := map[string]bool{}
	for _, args := range [][]string{{"diff", "--name-only", "-z", baseCommit, "--"}, {"ls-files", "--others", "--exclude-standard", "-z"}} {
		output, err := r.git(ctx, info.Root, args...)
		if err != nil {
			return "", err
		}
		if output != "" && !strings.HasSuffix(output, "\x00") {
			return "", errors.New("incomplete changed-file listing")
		}
		for _, name := range strings.Split(output, "\x00") {
			if name == "" {
				continue
			}
			if filepath.IsAbs(name) || !within(info.Root, filepath.Join(info.Root, name)) {
				return "", errors.New("changed path escapes workspace")
			}
			paths[name] = true
			if len(paths) > 10000 {
				return "", errors.New("too many changed files to inspect")
			}
		}
	}
	names := make([]string, 0, len(paths))
	for name := range paths {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool { return jsLess(names[i], names[j]) })
	hash := sha256.New()
	for _, name := range names {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		encoded, err := jsonString(name)
		if err != nil {
			return "", err
		}
		content, mode, err := readBoundedFile(info.Root, name, 16*1024*1024)
		if errors.Is(err, os.ErrNotExist) {
			_, _ = fmt.Fprintf(hash, "[%s,\"deleted\"]", encoded)
			continue
		}
		if err != nil {
			return "", fmt.Errorf("inspect changed file %s: %w", name, err)
		}
		_, _ = fmt.Fprintf(hash, "[%s,%d,%d]", encoded, mode.Perm()&0111, len(content))
		_, _ = hash.Write(content)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
