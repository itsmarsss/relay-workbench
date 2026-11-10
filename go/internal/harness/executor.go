package harness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"relay.local/relay/internal/handoff"
	"relay.local/relay/internal/process"
	"relay.local/relay/internal/storage"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/workspace"
)

var executionID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var sessionID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$`)
var fenceStart = regexp.MustCompile("^```(json)?\\s*")
var fenceEnd = regexp.MustCompile("\\s*```$")

type EventSink func(context.Context, map[string]any) error
type RunRequest struct {
	Store                                         *store.Store
	TaskID, AttemptID, Stage, Provider, SessionID string
	Config                                        Config
	Prompt                                        string
	Cwd, ActiveRepositoryID                       string
	Workspaces                                    []workspace.Workspace
	Lease                                         *workspace.Lease
	Admission                                     workspace.Admission
	Inspector                                     workspace.Inspector
	WorkerExecutable                              string
	WorkerArgs                                    []string
	Environment                                   map[string]string
	Timeout                                       time.Duration
	OnEvent                                       EventSink
}
type RunResult struct {
	Handoff           json.RawMessage
	Process           process.Result
	Guard             workspace.GuardResult
	ArtifactDirectory string
}

func createDir(parent, name string) (string, os.FileInfo, error) {
	path := filepath.Join(parent, name)
	err := os.Mkdir(path, 0700)
	if err != nil && !errors.Is(err, os.ErrExist) {
		return "", nil, err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", nil, errors.New("unsafe artifact directory")
	}
	return path, info, nil
}
func verifyDir(path string, identity os.FileInfo) error {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !os.SameFile(info, identity) {
		return errors.New("artifact directory changed")
	}
	return nil
}
func writeNew(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	return errors.Join(err, closeErr)
}
func storageError(err error) error {
	if errors.Is(err, syscall.ENOSPC) {
		return errors.Join(storage.ErrLowSpace, err)
	}
	return err
}
func finalHandoff(raw json.RawMessage, stage string) (json.RawMessage, error) {
	if len(raw) == 0 {
		return nil, errors.New("harness returned no structured handoff")
	}
	value := raw
	if raw[0] == '"' {
		var content string
		if json.Unmarshal(raw, &content) != nil {
			return nil, errors.New("invalid handoff")
		}
		content = strings.TrimSpace(content)
		content = fenceStart.ReplaceAllString(content, "")
		content = fenceEnd.ReplaceAllString(content, "")
		value = json.RawMessage(content)
	}
	if !json.Valid(value) {
		return nil, errors.New("harness returned an invalid structured handoff")
	}
	if err := handoff.Validate(value, stage); err != nil {
		return nil, err
	}
	return append(json.RawMessage(nil), value...), nil
}

func HasApprovedApproach(task map[string]any) bool {
	choice, ok := task["chosenApproach"].(map[string]any)
	if !ok {
		return false
	}
	id, ok := choice["id"].(string)
	if !ok || strings.TrimSpace(id) == "" {
		return false
	}
	approvals, ok := task["approvals"].([]any)
	if !ok {
		return false
	}
	for _, value := range approvals {
		approval, _ := value.(map[string]any)
		option, _ := approval["option"].(map[string]any)
		if approval["type"] == "approach" && option["id"] == id {
			return true
		}
	}
	return false
}

// Execute runs one normal specialist turn under a workspace lease. It is not
// wired to HTTP or a scheduler. Callers must authenticate approvals, hold the
// task action lock, supply trusted configuration and supervise persistence.
// Native sessions, interactive tmux and verification evidence are not ported.
func Execute(ctx context.Context, request RunRequest) (RunResult, error) {
	if ctx == nil || request.Store == nil || request.OnEvent == nil || request.WorkerExecutable == "" || request.Timeout <= 0 {
		return RunResult{}, errors.New("incomplete harness execution request")
	}
	if !executionID.MatchString(request.TaskID) || !executionID.MatchString(request.AttemptID) || request.SessionID != "" && !sessionID.MatchString(request.SessionID) {
		return RunResult{}, errors.New("invalid task, attempt or session identity")
	}
	if request.Prompt == "" || len(request.Prompt) > 8*1024*1024 {
		return RunResult{}, errors.New("invalid harness prompt")
	}
	switch request.Stage {
	case "triage", "investigate", "plan", "implement", "verify", "review":
	default:
		return RunResult{}, errors.New("stage execution is not yet supported")
	}
	raw, err := request.Store.Get(request.TaskID)
	if err != nil {
		return RunResult{}, err
	}
	var task map[string]any
	if json.Unmarshal(raw, &task) != nil || task == nil {
		return RunResult{}, errors.New("invalid task state")
	}
	if task["demo"] == true {
		return RunResult{}, errors.New("simulated tasks cannot run real harnesses")
	}
	if task["status"] != "running" || task["stage"] != request.Stage {
		return RunResult{}, errors.New("task is not running this stage")
	}
	routing, _ := task["routing"].(map[string]any)
	routeStage := request.Stage
	if routeStage == "verify" {
		routeStage = "implement"
	}
	if routing[routeStage] != request.Provider {
		return RunResult{}, errors.New("selected harness does not match task routing")
	}
	if (request.Stage == "implement" || request.Stage == "verify" || request.Stage == "review") && !HasApprovedApproach(task) {
		return RunResult{}, errors.New("implementation requires an approved approach")
	}
	var active workspace.Workspace
	for _, entry := range request.Workspaces {
		if entry.RepositoryID == request.ActiveRepositoryID {
			active = entry
			break
		}
	}
	if active.RepositoryID == "" || !filepath.IsAbs(request.Cwd) {
		return RunResult{}, errors.New("active workspace is required")
	}
	root, err := filepath.EvalSymlinks(active.Root)
	if err != nil {
		return RunResult{}, err
	}
	cwd, err := filepath.EvalSymlinks(request.Cwd)
	if err != nil {
		return RunResult{}, err
	}
	relative, err := filepath.Rel(root, cwd)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) || filepath.IsAbs(relative) {
		return RunResult{}, errors.New("working directory must be inside the active workspace")
	}
	mode := workspace.ReadOnly
	if request.Stage == "implement" {
		mode = workspace.WriteOne
	}
	var result RunResult
	err = request.Store.WithOwnership(func(stateRoot string, verify func() error) error {
		guard, guardErr := workspace.GuardedRun(ctx, request.Lease, request.TaskID, request.Workspaces, mode, request.ActiveRepositoryID, request.Admission, request.Inspector, func(runCtx context.Context) error {
			if err := verify(); err != nil {
				return err
			}
			artifacts, artifactsInfo, err := createDir(stateRoot, "artifacts")
			if err != nil {
				return storageError(err)
			}
			taskDir, taskInfo, err := createDir(artifacts, request.TaskID)
			if err != nil {
				return storageError(err)
			}
			attemptDir := filepath.Join(taskDir, request.AttemptID)
			if err = os.Mkdir(attemptDir, 0700); err != nil {
				return storageError(err)
			}
			attemptInfo, err := os.Lstat(attemptDir)
			if err != nil || !attemptInfo.IsDir() || attemptInfo.Mode()&os.ModeSymlink != 0 {
				return errors.New("unsafe attempt directory")
			}
			result.ArtifactDirectory = attemptDir
			verifyArtifacts := func() error {
				if err := verify(); err != nil {
					return err
				}
				if err := verifyDir(artifacts, artifactsInfo); err != nil {
					return err
				}
				if err := verifyDir(taskDir, taskInfo); err != nil {
					return err
				}
				return verifyDir(attemptDir, attemptInfo)
			}
			if err = verifyArtifacts(); err != nil {
				return err
			}
			schemaPath := filepath.Join(attemptDir, "handoff.schema.json")
			if err = writeNew(schemaPath, []byte(schemaFor(request.Stage))); err != nil {
				return storageError(err)
			}
			if err = writeNew(filepath.Join(attemptDir, "prompt.txt"), []byte(request.Prompt)); err != nil {
				return storageError(err)
			}
			invocation, err := Build(request.Provider, request.Config, schemaPath, request.Stage, request.SessionID)
			if err != nil {
				return err
			}
			var final json.RawMessage
			var harnessError string
			var progress atomic.Int64
			lastDigest := ""
			onLine := func(eventCtx context.Context, line, stream string) error {
				if err := request.OnEvent(eventCtx, map[string]any{"type": "transcript", "stream": stream, "text": limited(line, 40000)}); err != nil {
					return err
				}
				if stream != "stdout" {
					return nil
				}
				decoded := Decode(request.Provider, line)
				if value, ok := decoded["final"].(json.RawMessage); ok {
					final = append(final[:0], value...)
				}
				if value, exists := decoded["error"]; exists && value != nil {
					harnessError = fmt.Sprint(value)
				}
				activities, ok := decoded["activities"].([]map[string]any)
				if !ok {
					if _, exists := decoded["activity"]; exists {
						activities = []map[string]any{decoded}
					}
				}
				for _, activity := range activities {
					summary, ok := activity["activity"].(string)
					if !ok {
						return errors.New("invalid activity summary")
					}
					details := ""
					if value, exists := activity["details"]; exists && value != nil {
						var valid bool
						details, valid = value.(string)
						if !valid {
							return errors.New("invalid activity details")
						}
					}
					kind, _ := activity["kind"].(string)
					if kind == "" {
						kind = "tool"
					}
					if err := request.OnEvent(eventCtx, map[string]any{"type": "activity", "kind": kind, "summary": limited(summary, 1200), "details": limited(details, 40000)}); err != nil {
						return err
					}
					if kind == "tool" && details != "" && details != lastDigest {
						lastDigest = details
						progress.Store(time.Now().UnixMilli())
					}
				}
				return nil
			}
			if err = verifyArtifacts(); err != nil {
				return err
			}
			result.Process, err = process.Run(runCtx, process.Options{WorkerExecutable: request.WorkerExecutable, WorkerArgs: request.WorkerArgs, Command: invocation.Command, Args: invocation.Args, Directory: cwd, Input: []byte(request.Prompt), Environment: request.Environment, Timeout: request.Timeout, Progress: &process.ProgressPolicy{LastProgressUnixMillis: &progress}, MaxOutputBytes: 8 * 1024 * 1024, OnLine: onLine})
			if ownershipErr := verifyArtifacts(); ownershipErr != nil {
				return errors.Join(err, ownershipErr)
			}
			if logErr := writeNew(filepath.Join(attemptDir, "stdout.jsonl"), []byte(result.Process.Stdout)); logErr != nil {
				return errors.Join(err, storageError(logErr))
			}
			if logErr := writeNew(filepath.Join(attemptDir, "stderr.txt"), []byte(result.Process.Stderr)); logErr != nil {
				return errors.Join(err, storageError(logErr))
			}
			if err != nil {
				return err
			}
			if result.Process.ExitCode != 0 || harnessError != "" {
				if harnessError == "" {
					harnessError = fmt.Sprintf("%s exited %d: %s", request.Provider, result.Process.ExitCode, limited(result.Process.Stderr, 2000))
				}
				return errors.New(harnessError)
			}
			result.Handoff, err = finalHandoff(final, request.Stage)
			if err != nil {
				return err
			}
			if err = writeNew(filepath.Join(attemptDir, "handoff.json"), result.Handoff); err != nil {
				return storageError(err)
			}
			return nil
		})
		result.Guard = guard
		return guardErr
	})
	if err != nil {
		result.Handoff = nil
	}
	return result, err
}
