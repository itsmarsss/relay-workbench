package workspace

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"relay.local/relay/internal/process"
)

type UntrackedPreview struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

type DiffPreview struct {
	Text             string             `json:"text"`
	Stat             string             `json:"stat"`
	Untracked        []UntrackedPreview `json:"untracked"`
	Omitted          bool               `json:"omitted,omitempty"`
	Reason           string             `json:"reason,omitempty"`
	UntrackedOmitted int                `json:"untrackedOmitted,omitempty"`
}

// Diff inspects a task checkout without modifying it. A bounded preview is
// presentation only and is never accepted as verification evidence.
func (r Runner) Diff(ctx context.Context, root, baseCommit string) (DiffPreview, error) {
	result := DiffPreview{Untracked: []UntrackedPreview{}}
	if ctx == nil || !filepath.IsAbs(root) || !commitPattern.MatchString(baseCommit) {
		return result, errors.New("workspace and base commit are required")
	}
	info, err := r.Inspect(ctx, Profile{Path: root})
	if err != nil {
		return result, err
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return result, err
	}
	actual, err := os.Stat(info.Root)
	if err != nil {
		return result, err
	}
	requested, err := os.Stat(resolved)
	if err != nil || !os.SameFile(actual, requested) {
		return result, errors.New("workspace root changed")
	}
	// Avoid Git's optional index refresh while agents may be editing.
	env := map[string]string{}
	for key, value := range r.Environment {
		env[key] = value
	}
	env["GIT_OPTIONAL_LOCKS"] = "0"
	r.Environment = env
	text, err := r.git(ctx, info.Root, "diff", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", baseCommit, "--")
	if errors.Is(err, process.ErrOutputLimit) || len(text) > 4*1024*1024 {
		result.Omitted = true
		result.Reason = "Diff exceeds the preview limit; inspect it locally."
	} else if err != nil {
		return result, err
	} else {
		result.Text = text
	}
	stat, err := r.git(ctx, info.Root, "diff", "--stat", baseCommit, "--")
	if errors.Is(err, process.ErrOutputLimit) {
		result.Omitted = true
		result.Reason = "Diff statistics exceed the preview limit; inspect them locally."
	} else if err != nil {
		return result, err
	}
	result.Stat = stat
	names, err := r.git(ctx, info.Root, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return result, err
	}
	if names != "" && !strings.HasSuffix(names, "\x00") {
		return result, errors.New("incomplete untracked-file listing")
	}
	items := strings.Split(names, "\x00")
	items = items[:len(items)-1]
	if len(items) > 200 {
		result.UntrackedOmitted = len(items) - 200
		items = items[:200]
	}
	remaining := 2 * 1024 * 1024
	for _, name := range items {
		if name == "" || filepath.IsAbs(name) || !within(info.Root, filepath.Join(info.Root, name)) {
			return result, errors.New("untracked path escapes workspace")
		}
		content := "[File cannot be previewed; inspect locally]"
		data, err := readPreviewFile(info.Root, name, 200000)
		if err == nil {
			if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
				content = "[Binary file; inspect locally]"
			} else if len(data) > remaining {
				content = "[Preview budget reached; inspect locally]"
				result.UntrackedOmitted++
			} else {
				content = string(data)
				remaining -= len(data)
			}
		}
		result.Untracked = append(result.Untracked, UntrackedPreview{Name: name, Content: content})
	}
	return result, nil
}
