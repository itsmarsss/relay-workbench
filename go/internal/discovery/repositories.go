// Package discovery inspects local metadata without running repository scripts.
package discovery

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"relay.local/relay/internal/workspace"
	"strings"
)

type Repository struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

func Repositories(ctx context.Context, roots []string) ([]Repository, error) {
	if len(roots) == 0 || len(roots) > 20 {
		return nil, errors.New("select one to twenty search roots")
	}
	result := []Repository{}
	seen := map[string]bool{}
	visited := 0
	var scan func(string, int) error
	scan = func(path string, depth int) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		visited++
		if visited > 10000 {
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
				break
			}
			if err = scan(filepath.Join(path, entry.Name()), depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	for _, root := range roots {
		if !filepath.IsAbs(root) {
			return nil, errors.New("search roots must be absolute")
		}
		if err := scan(filepath.Clean(root), 0); err != nil {
			return nil, err
		}
	}
	return result, nil
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
	if data, err := read("package.json"); err == nil {
		var pkg map[string]any
		if json.Unmarshal(data, &pkg) == nil {
			if name, ok := pkg["name"].(string); ok && name != "" {
				add("name", "Package name", name, "package.json")
			}
			manager := "npm"
			if value, ok := pkg["packageManager"].(string); ok {
				candidate := strings.Split(value, "@")[0]
				if candidate == "pnpm" || candidate == "yarn" || candidate == "bun" {
					manager = candidate
				}
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
	return map[string]any{"root": info.Root, "cwd": info.RelativeCwd, "suggestions": values}, nil
}
