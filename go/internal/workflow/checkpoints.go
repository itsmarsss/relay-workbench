package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"relay.local/relay/internal/workspace"
	"strings"
	"time"
)

type checkpointRepository struct {
	ID          string `json:"repositoryId"`
	Root        string `json:"root"`
	Head        string `json:"head"`
	IndexTree   string `json:"indexTree"`
	WorkingTree string `json:"workingTree"`
}
type Checkpoint struct {
	ID           string                 `json:"id"`
	AttemptID    string                 `json:"attemptId"`
	Stage        string                 `json:"stage"`
	NextStage    string                 `json:"nextStage"`
	Role         string                 `json:"role,omitempty"`
	At           string                 `json:"at"`
	Summary      string                 `json:"summary"`
	Fingerprint  string                 `json:"fingerprint"`
	Repositories []checkpointRepository `json:"repositories"`
	Snapshot     map[string]any         `json:"snapshot"`
}

var objectID = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)

func (c *Coordinator) checkpointRecords(id string) ([]Checkpoint, error) {
	raw, exists, err := c.store.GetMeta("checkpoints:" + id)
	if err != nil {
		return nil, err
	}
	rows := []Checkpoint{}
	if exists && json.Unmarshal([]byte(raw), &rows) != nil {
		return nil, errors.New("invalid checkpoint records")
	}
	return rows, nil
}
func (c *Coordinator) History(id string) (map[string]any, error) {
	if _, err := c.store.Get(id); err != nil {
		return nil, err
	}
	rows, err := c.checkpointRecords(id)
	if err != nil {
		return nil, err
	}
	records := []map[string]any{}
	for _, row := range rows {
		records = append(records, map[string]any{"id": row.ID, "attemptId": row.AttemptID, "stage": row.Stage, "nextStage": row.NextStage, "role": row.Role, "at": row.At, "summary": row.Summary, "approaches": CompletedPlan(row.Snapshot)["options"], "canChooseDebug": row.Role == "debug" || object(row.Snapshot["blockerDecision"]) != nil, "hasApproach": row.Snapshot["chosenApproach"] != nil})
	}
	all, err := c.store.All()
	if err != nil {
		return nil, err
	}
	forks := []any{}
	for _, raw := range all {
		var value map[string]any
		if json.Unmarshal(raw, &value) != nil {
			continue
		}
		fork := object(value["fork"])
		if fork["sourceTaskId"] == id {
			forks = append(forks, map[string]any{"taskId": value["id"], "title": value["title"], "status": value["status"], "restore": value["checkpointRestore"], "checkpointId": fork["checkpointId"], "attemptId": fork["sourceAttemptId"], "at": fork["at"]})
		}
	}
	return map[string]any{"checkpoints": records, "forks": forks}, nil
}
func (c *Coordinator) captureCheckpoint(ctx context.Context, id string, revalidate func() error) error {
	raw, err := c.store.Get(id)
	if err != nil {
		return err
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil {
		return errors.New("invalid checkpoint task")
	}
	attempts := array(value["attempts"])
	if len(attempts) == 0 || value["demo"] == true {
		return nil
	}
	attempt := object(attempts[len(attempts)-1])
	if attempt["status"] != "complete" {
		return nil
	}
	rows, err := c.checkpointRecords(id)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.AttemptID == attempt["id"] {
			return nil
		}
	}
	// Tree refs are incremental Git objects, never directory copies.
	entries, err := stageWorkspaces(value)
	if err != nil {
		return err
	}
	roots := []string{}
	workspaces := []workspace.Workspace{}
	for _, entry := range entries {
		roots = append(roots, entry.root)
		workspaces = append(workspaces, workspace.Workspace{RepositoryID: entry.id, Root: entry.root})
	}
	lease, err := c.registry.Acquire(id, roots)
	if err != nil {
		return err
	}
	defer lease.Release()
	runner := workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}
	before, err := runner.Snapshot(ctx, workspaces)
	if err != nil {
		return err
	}
	expected := text(attempt["afterFingerprint"])
	if expected != "" && before.Combined != expected {
		return errors.New("workspace changed before checkpoint; inspect retained work")
	}
	checkpointID, err := stageUUID()
	if err != nil {
		return err
	}
	directory, err := os.MkdirTemp("", "relay-checkpoint-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	record := Checkpoint{ID: checkpointID, AttemptID: text(attempt["id"]), Stage: text(attempt["stage"]), NextStage: text(value["stage"]), Role: text(attempt["role"]), At: nowCheckpoint(), Summary: text(object(attempt["handoff"])["summary"]), Fingerprint: before.Combined, Snapshot: value, Repositories: []checkpointRepository{}}
	refs := [][2]string{}
	committed := false
	defer func() {
		if !committed {
			for _, ref := range refs {
				_, _ = runner.RunGit(context.Background(), ref[0], []string{"update-ref", "-d", ref[1]}, nil, nil)
			}
		}
	}()
	for index, entry := range entries {
		git := func(args ...string) (string, error) {
			out, err := runner.RunGit(ctx, entry.root, args, nil, nil)
			return strings.TrimSpace(out), err
		}
		head, err := git("rev-parse", "HEAD")
		if err != nil {
			return err
		}
		if !objectID.MatchString(head) {
			return errors.New("invalid checkpoint HEAD")
		}
		indexFile := filepath.Join(directory, fmt.Sprintf("index-%d", index))
		sourceIndex, err := git("rev-parse", "--path-format=absolute", "--git-path", "index")
		if err != nil {
			return err
		}
		alternate := map[string]string{"GIT_INDEX_FILE": indexFile}
		input, err := os.Open(sourceIndex)
		if errors.Is(err, os.ErrNotExist) {
			if _, err = runner.RunGit(ctx, entry.root, []string{"read-tree", head}, nil, alternate); err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else {
			info, statErr := input.Stat()
			if statErr != nil || !info.Mode().IsRegular() || info.Size() > 64*1024*1024 {
				input.Close()
				return errors.New("checkpoint index cannot be safely copied")
			}
			target, createErr := os.OpenFile(indexFile, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if createErr != nil {
				input.Close()
				return createErr
			}
			_, copyErr := io.Copy(target, io.LimitReader(input, 64*1024*1024+1))
			closeErr := target.Close()
			input.Close()
			if err = errors.Join(copyErr, closeErr); err != nil {
				return err
			}
		}
		indexTree, err := runner.RunGit(ctx, entry.root, []string{"write-tree"}, nil, alternate)
		if err != nil {
			return err
		}
		indexTree = strings.TrimSpace(indexTree)
		if _, err = runner.RunGit(ctx, entry.root, []string{"add", "-A", "--", "."}, nil, alternate); err != nil {
			return err
		}
		workingTree, err := runner.RunGit(ctx, entry.root, []string{"write-tree"}, nil, alternate)
		if err != nil {
			return err
		}
		workingTree = strings.TrimSpace(workingTree)
		if !objectID.MatchString(indexTree) || !objectID.MatchString(workingTree) {
			return errors.New("invalid checkpoint trees")
		}
		updates := "start\n"
		for _, item := range [][2]string{{"head", head}, {"index", indexTree}, {"work", workingTree}} {
			ref := fmt.Sprintf("refs/relay/checkpoints/%s/%s/%d/%s", id, checkpointID, index, item[0])
			updates += "create " + ref + " " + item[1] + "\n"
			refs = append(refs, [2]string{entry.root, ref})
		}
		updates += "prepare\ncommit\n"
		if _, err = runner.RunGit(ctx, entry.root, []string{"update-ref", "--stdin"}, []byte(updates), nil); err != nil {
			return err
		}
		record.Repositories = append(record.Repositories, checkpointRepository{entry.id, entry.root, head, indexTree, workingTree})
	}
	after, err := runner.Snapshot(ctx, workspaces)
	if err != nil {
		return err
	}
	if after.Combined != before.Combined {
		return errors.New("workspace changed while capturing checkpoint")
	}
	if err = revalidate(); err != nil {
		return err
	}
	// Do not lose checkpoints if a concurrent metadata reader saved another record.
	err = c.store.UpdateMeta("checkpoints:"+id, func(raw string, exists bool) (string, error) {
		current := []Checkpoint{}
		if exists && json.Unmarshal([]byte(raw), &current) != nil {
			return "", errors.New("invalid checkpoint records")
		}
		for _, row := range current {
			if row.AttemptID == record.AttemptID {
				return "", errors.New("checkpoint already captured")
			}
		}
		encoded, err := json.Marshal(append(current, record))
		return string(encoded), err
	})
	if err != nil {
		return err
	}
	committed = true
	if pruneErr := c.pruneCheckpoints(ctx, id, runner); pruneErr != nil {
		_, _ = c.store.Event(id, mustJSON(map[string]any{"type": "warning", "source": "relay", "summary": "Checkpoint saved; retention cleanup deferred: " + pruneErr.Error()}))
	}
	_, err = c.store.Event(id, mustJSON(map[string]any{"type": "checkpoint", "source": "relay", "checkpointId": record.ID, "attemptId": record.AttemptID, "summary": "Saved a checkpoint after " + record.Stage + "."}))
	return err
}
func nowCheckpoint() string { return timestamp(time.Now()) }

// Keep the latest hundred snapshots plus checkpoints referenced by continuations.
// Retention is maintenance: a failure must not invalidate a saved stage result.
func (c *Coordinator) pruneCheckpoints(ctx context.Context, id string, runner workspace.Runner) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	rows, err := c.checkpointRecords(id)
	if err != nil || len(rows) <= 100 {
		return err
	}
	all, err := c.store.All()
	if err != nil {
		return err
	}
	pinned := map[string]bool{}
	for _, raw := range all {
		var task map[string]any
		if err := json.Unmarshal(raw, &task); err != nil {
			return err
		}
		fork := object(task["fork"])
		if fork["sourceTaskId"] == id {
			pinned[text(fork["checkpointId"])] = true
		}
	}
	keep, remove := []Checkpoint{}, []Checkpoint{}
	for i, row := range rows {
		if i >= len(rows)-100 || pinned[row.ID] {
			keep = append(keep, row)
		} else {
			remove = append(remove, row)
		}
	}
	if len(remove) == 0 {
		return nil
	}
	// Commit retention metadata first. An interrupted cleanup can only leave extra
	// refs, never dangling metadata referring to removed snapshots.
	if err = c.store.UpdateMeta("checkpoints:"+id, func(raw string, exists bool) (string, error) {
		original, _ := json.Marshal(rows)
		var current []Checkpoint
		if !exists || json.Unmarshal([]byte(raw), &current) != nil {
			return "", errors.New("checkpoint history changed")
		}
		actual, _ := json.Marshal(current)
		if string(actual) != string(original) {
			return "", errors.New("checkpoint history changed")
		}
		encoded, err := json.Marshal(keep)
		return string(encoded), err
	}); err != nil {
		return err
	}
	for _, row := range remove {
		for i, repo := range row.Repositories {
			for _, suffix := range []string{"head", "index", "work"} {
				ref := fmt.Sprintf("refs/relay/checkpoints/%s/%s/%d/%s", id, row.ID, i, suffix)
				if _, err = runner.RunGit(ctx, repo.Root, []string{"update-ref", "-d", ref}, nil, nil); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
