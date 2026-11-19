// Package discovery inspects local metadata without running repository scripts.
package discovery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"relay.local/relay/internal/workspace"
	"strings"
)

type Repository struct {
	Path         string `json:"path"`
	Name         string `json:"name"`
	ConfiguredID string `json:"configuredId,omitempty"`
}

type Report struct {
	Repositories []Repository `json:"repositories"`
	Roots        []string     `json:"roots"`
	Warnings     []string     `json:"warnings"`
	Truncated    bool         `json:"truncated"`
}

func Repositories(ctx context.Context, roots []string) ([]Repository, error) {
	report, err := ScanRepositories(ctx, roots)
	return report.Repositories, err
}
func ScanRepositories(ctx context.Context, roots []string) (Report, error) {
	report := Report{Repositories: []Repository{}, Roots: []string{}, Warnings: []string{}}

	if len(roots) == 0 || len(roots) > 20 {
		return report, errors.New("select one to twenty search roots")
	}
	result := []Repository{}
	seen := map[string]bool{}
	visited := 0
	var scan func(string, int) error
	scan = func(path string, depth int) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if len(result) >= 200 || visited >= 10000 {
			report.Truncated = true
			return nil
		}
		visited++
		if visited > 10000 {
			report.Truncated = true
			return nil
		}
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if _, err = os.Lstat(filepath.Join(path, ".git")); err == nil {
			canonical, err := filepath.EvalSymlinks(path)
			if err == nil && !seen[canonical] {
				result = append(result, Repository{Path: canonical, Name: filepath.Base(path)})
				seen[canonical] = true
			}
			return nil
		}
		if depth >= 4 {
			return nil
		}
		entries, err := os.ReadDir(path)
		if err != nil {
			if len(report.Warnings) < 20 {
				report.Warnings = append(report.Warnings, "Could not read folder: "+path)
			}
			return nil
		}
		for _, entry := range entries {
			if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			switch entry.Name() {
			case "node_modules", "vendor", "target", "dist", "build", "Library", "Volumes":
				continue
			}
			if len(result) >= 200 || visited >= 10000 {
				report.Truncated = true
				break
			}
			if err = scan(filepath.Join(path, entry.Name()), depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	for _, root := range roots {
		if ctx.Err() != nil {
			return report, ctx.Err()
		}
		if !filepath.IsAbs(root) {
			return report, errors.New("search roots must be absolute")
		}
		root = filepath.Clean(root)
		report.Roots = append(report.Roots, root)
		info, err := os.Lstat(root)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			report.Warnings = append(report.Warnings, "Skipped unavailable folder or link: "+root)
			continue
		}
		if err := scan(root, 0); err != nil {
			return report, err
		}
	}
	report.Repositories = result
	return report, nil
}
func Suggestions(ctx context.Context, runner workspace.Runner, path, cwd string) (map[string]any, error) {
	info, err := runner.Inspect(ctx, workspace.Profile{Path: path, Cwd: cwd})
	if err != nil {
		return nil, err
	}
	values := []map[string]any{}
	add := func(field, label string, value any, evidence string) {
		values = append(values, map[string]any{"field": field, "label": label, "value": value, "evidence": evidence})
	}
	add("name", "Repository name", filepath.Base(info.Root), "Git checkout folder")
	add("path", "Repository root", info.Root, "Git repository root")
	add("cwd", "Working directory", info.RelativeCwd, "Git working directory")
	read := func(name string) ([]byte, error) {
		relative, err := filepath.Rel(info.Root, filepath.Join(info.Cwd, name))
		if err != nil {
			return nil, err
		}
		return workspace.ReadFile(info.Root, relative, 256*1024)
	}
	metadataExists := func(folder, name string) bool {
		relative, err := filepath.Rel(info.Root, filepath.Join(folder, name))
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return false
		}
		// Presence detection never reads or executes metadata contents. Reject
		// links in every component, including large dependency lockfiles.
		parts := strings.Split(relative, string(filepath.Separator))
		path := info.Root
		for index, part := range parts {
			path = filepath.Join(path, part)
			file, err := os.Lstat(path)
			if err != nil || file.Mode()&os.ModeSymlink != 0 {
				return false
			}
			if index == len(parts)-1 {
				return file.Mode().IsRegular()
			}
			if !file.IsDir() {
				return false
			}
		}
		return false
	}
	if data, err := read("package.json"); err == nil {
		var pkg map[string]any
		if json.Unmarshal(data, &pkg) == nil {
			if name, ok := pkg["name"].(string); ok && name != "" {
				add("name", "Package name", name, "package.json")
			}
			manager := "npm"
			declared := false
			if value, ok := pkg["packageManager"].(string); ok {
				candidate := strings.Split(value, "@")[0]
				if candidate == "npm" || candidate == "pnpm" || candidate == "yarn" || candidate == "bun" {
					manager = candidate
					declared = true
				}
			}
			lock := ""
			for _, folder := range []string{info.Cwd, info.Root} {
				for _, candidate := range []struct{ file, tool string }{{"pnpm-lock.yaml", "pnpm"}, {"package-lock.json", "npm"}, {"yarn.lock", "yarn"}, {"bun.lock", "bun"}, {"bun.lockb", "bun"}} {
					if metadataExists(folder, candidate.file) && (!declared || manager == candidate.tool) {
						if !declared {
							manager = candidate.tool
						}
						// An inherited lock chooses the check runner. Installation is
						// suggested only when the selected working directory owns it.
						if folder == info.Cwd {
							lock = candidate.file
						}
						declared = true
						break
					}
				}
			}
			if lock != "" {
				args := []string{"install", "--frozen-lockfile"}
				if manager == "npm" {
					args = []string{"ci"}
				}
				if manager == "yarn" && strings.HasPrefix(fmt.Sprint(pkg["packageManager"]), "yarn@") && !strings.HasPrefix(fmt.Sprint(pkg["packageManager"]), "yarn@1.") {
					args = []string{"install", "--immutable"}
				}
				add("setup", "Install dependencies", map[string]any{"command": manager, "args": args}, lock)
			}
			if scripts, ok := pkg["scripts"].(map[string]any); ok {
				for _, script := range []string{"test", "lint", "typecheck", "check"} {
					if _, ok := scripts[script].(string); ok {
						add("checks", "Run "+script, map[string]any{"command": manager, "args": []string{"run", script}}, "package.json scripts."+script)
					}
				}
			}
		}
	}
	for _, entry := range []struct {
		file, command string
		args          []string
	}{{"go.mod", "go", []string{"test", "./..."}}, {"Cargo.toml", "cargo", []string{"test"}}, {"pyproject.toml", "python", []string{"-m", "pytest"}}} {
		if _, err := read(entry.file); err == nil {
			add("checks", "Suggested test command", map[string]any{"command": entry.command, "args": entry.args}, entry.file)
		}
	}
	// Dependencies other ecosystems fetch up front, so a new worktree is ready before an agent
	// starts rather than downloading on its first build. Only lockfiles in the working folder
	// count, and each tool's own non-interactive form is used.
	for _, entry := range []struct {
		file, label, command string
		args                 []string
	}{
		{"go.sum", "Download Go modules", "go", []string{"mod", "download"}},
		{"Cargo.lock", "Fetch Rust crates", "cargo", []string{"fetch", "--locked"}},
		{"uv.lock", "Install Python dependencies", "uv", []string{"sync", "--frozen"}},
		{"poetry.lock", "Install Python dependencies", "poetry", []string{"install", "--no-interaction"}},
	} {
		if metadataExists(info.Cwd, entry.file) {
			add("setup", entry.label, map[string]any{"command": entry.command, "args": entry.args}, entry.file)
		}
	}
	guidance := []string{}
	seenGuidance := map[string]bool{}
	for _, folder := range []string{info.Root, info.Cwd} {
		for _, file := range []string{"AGENTS.md", "CLAUDE.md", "README.md"} {
			relative, _ := filepath.Rel(info.Root, filepath.Join(folder, file))
			if _, err := workspace.ReadFile(info.Root, relative, 256*1024); err == nil && !seenGuidance[relative] {
				guidance = append(guidance, relative)
				seenGuidance[relative] = true
			}
		}
	}
	checked := 0
	for _, parent := range []string{info.Cwd, filepath.Join(info.Cwd, "packages"), filepath.Join(info.Cwd, "apps"), filepath.Join(info.Cwd, "services")} {
		canonical, err := filepath.EvalSymlinks(parent)
		if err != nil {
			continue
		}
		relative, err := filepath.Rel(info.Root, canonical)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			continue
		}
		entries, err := os.ReadDir(canonical)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if checked >= 150 {
				break
			}
			checked++
			if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			switch entry.Name() {
			case "node_modules", "vendor", "target", "dist", "build":
				continue
			}
			for _, file := range []string{"package.json", "go.mod", "Cargo.toml", "pyproject.toml"} {
				metadata := filepath.Join(relative, entry.Name(), file)
				if _, err := workspace.ReadFile(info.Root, metadata, 256*1024); err == nil {
					add("cwd", "Use package "+entry.Name(), filepath.Join(relative, entry.Name()), metadata)
					break
				}
			}
		}
	}
	return map[string]any{"root": info.Root, "cwd": info.RelativeCwd, "guidance": guidance, "suggestions": values}, nil
}
