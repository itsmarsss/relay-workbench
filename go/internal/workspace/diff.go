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

// maxStatFiles bounds the changed files a diff may have and still get statistics.
const maxStatFiles = 2000

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
	// One pass yields both: the statistics come first, then the patch from its first header.
	text, err := r.git(ctx, info.Root, "diff", "--no-color", "--no-renames", "--stat", "--patch", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", baseCommit, "--")
	if err == nil {
		stat, patch := text, ""
		if strings.HasPrefix(text, "diff --git ") {
			stat, patch = "", text
		} else if at := strings.Index(text, "\ndiff --git "); at >= 0 {
			stat, patch = text[:at+1], text[at+1:]
		}
		result.Stat = strings.TrimRight(stat, "\n")
		if result.Stat != "" {
			result.Stat += "\n"
		}
		if len(patch) > 4*1024*1024 {
			result.Omitted = true
			result.Reason = "Diff exceeds the preview limit; inspect it locally."
		} else {
			result.Text = patch
		}
		return r.untracked(ctx, info.Root, result)
	}
	if !errors.Is(err, process.ErrOutputLimit) {
		return result, err
	}
	result.Omitted = true
	result.Reason = "Diff exceeds the preview limit; inspect it locally."
	// Statistics compare the content of every changed file. When the recorded base has fallen
	// far behind the branch that is most of the repository and takes minutes, so a patch past
	// the output limit first gets a cheap count of the files involved.
	changed, err := r.git(ctx, info.Root, "diff", "--name-only", "--no-renames", "-z", baseCommit, "--")
	if errors.Is(err, process.ErrOutputLimit) || strings.Count(changed, "\x00") > maxStatFiles {
		result.Reason = "Too many files differ from this task's base commit to preview; the base is probably out of date. Inspect the changes locally."
		return r.untracked(ctx, info.Root, result)
	} else if err != nil {
		return result, err
	}
	stat, err := r.git(ctx, info.Root, "diff", "--stat", "--no-renames", baseCommit, "--")
	if errors.Is(err, process.ErrOutputLimit) {
		result.Reason = "Diff statistics exceed the preview limit; inspect them locally."
	} else if err != nil {
		return result, err
	}
	result.Stat = stat
	return r.untracked(ctx, info.Root, result)
}

// untracked adds bounded previews of the checkout's untracked files.
func (r Runner) untracked(ctx context.Context, root string, result DiffPreview) (DiffPreview, error) {
	names, err := r.git(ctx, root, "ls-files", "--others", "--exclude-standard", "-z")
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
		if name == "" || filepath.IsAbs(name) || !within(root, filepath.Join(root, name)) {
			return result, errors.New("untracked path escapes workspace")
		}
		content := "[File cannot be previewed; inspect locally]"
		data, err := readPreviewFile(root, name, 200000)
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
