package workflow

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"relay.local/relay/internal/catalog"
	"relay.local/relay/internal/discovery"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/workspace"
	"sync"
)

func (c *Coordinator) Discover(ctx context.Context, operation string, body map[string]any) (any, error) {
	allowed := map[string]map[string]bool{"models": {"force": true}, "repositories": {"roots": true}, "suggestions": {"path": true, "cwd": true}}
	valid, ok := allowed[operation]
	if !ok {
		return nil, errors.New("unknown discovery operation")
	}
	for key := range body {
		if !valid[key] {
			return nil, errors.New("unexpected discovery field: " + key)
		}
	}
	if value, exists := body["force"]; exists {
		if _, ok := value.(bool); !ok {
			return nil, errors.New("force must be a boolean")
		}
	}
	for _, key := range []string{"path", "cwd"} {
		if value, exists := body[key]; exists {
			if text(value) == "" || len(text(value)) > 4096 {
				return nil, errors.New("invalid discovery path")
			}
		}
	}
	switch operation {
	case "models":
		config, err := (task.ConfigurationService{Store: c.store}).Read()
		if err != nil {
			return nil, err
		}
		result := map[string]catalog.Result{}
		var wg sync.WaitGroup
		var mu sync.Mutex
		for _, id := range []string{"codex", "claude", "pi"} {
			id := id
			command := text(object(object(config.Value["harnesses"])[id])["command"])
			wg.Add(1)
			go func() {
				defer wg.Done()
				value := c.catalog.Provider(ctx, id, command, body["force"] == true)
				mu.Lock()
				result[id] = value
				mu.Unlock()
			}()
		}
		wg.Wait()
		return result, nil
	case "repositories":
		roots := []string{}
		if value, exists := body["roots"]; exists {
			items, ok := value.([]any)
			if !ok || len(items) == 0 || len(items) > 20 {
				return nil, errors.New("select one to twenty search roots")
			}
			for _, item := range items {
				if text(item) == "" || len(text(item)) > 4096 {
					return nil, errors.New("invalid search root")
				}
				roots = append(roots, text(item))
			}
		}
		if len(roots) == 0 {
			home, err := os.UserHomeDir()
			if err != nil {
				return nil, err
			}
			for _, name := range []string{"Documents", "Projects", "Code", "Developer"} {
				path := filepath.Join(home, name)
				if info, err := os.Stat(path); err == nil && info.IsDir() {
					roots = append(roots, path)
				}
			}
		}
		return discovery.Repositories(ctx, roots)
	default:
		return discovery.Suggestions(ctx, workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}, text(body["path"]), text(body["cwd"]))
	}
}
