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
	"relay.local/relay/internal/terminal"
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
	Debug                                         bool
	Auxiliary                                     bool
	Terminals                                     bool
	ExpectedBefore                                string
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
	value = handoff.Normalize(value, stage)
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

func HasFinalApproval(task map[string]any) bool {
	if task["status"] != "completed" || task["demo"] == true || task["preset"] == "investigate" || !HasApprovedApproach(task) {
		return false
	}
	reviewed, ok := task["reviewedFingerprint"].(string)
	if !ok || reviewed == "" || task["verifiedFingerprint"] != reviewed {
		return false
	}
	approvals, ok := task["approvals"].([]any)
	if !ok {
		return false
	}
	final, matching := false, false
	for _, value := range approvals {
		approval, _ := value.(map[string]any)
		if approval["type"] == "final" {
			final = true
		}
		if (approval["type"] == "final" || approval["type"] == "publication_revalidation") && approval["fingerprint"] == reviewed {
			matching = true
		}
	}
	return final && matching
}

// hasPullRequest is whether the repository has a pull request to watch: one Relay published or one
// a person linked by hand. Watching is read-only, so it does not depend on the task being accepted.
func hasPullRequest(task map[string]any, repositoryID string) bool {
	entries, _ := task["repositories"].([]any)
	if len(entries) <= 1 {
		entries = []any{task}
	}
	for _, item := range entries {
		entry, _ := item.(map[string]any)
		repo, _ := entry["repository"].(map[string]any)
		if repositoryID != "" && repo["id"] == repositoryID {
			for _, key := range []string{"publication", "pullRequestLink"} {
				record, _ := entry[key].(map[string]any)
				if url, _ := record["url"].(string); url != "" {
					return true
				}
			}
			return false
		}
	}
	return false
}

func auxiliaryRecord(task map[string]any, repositoryID, stage string) map[string]any {
	if stage == "followup" {
		runs, _ := task["deliveryRuns"].([]any)
		for _, item := range runs {
			run, _ := item.(map[string]any)
			if run["stage"] == stage && run["status"] == "running" {
				return run
			}
		}
		return nil
	}
	entries, _ := task["repositories"].([]any)
	if len(entries) <= 1 {
		entries = []any{task}
	}
	for _, value := range entries {
		entry, _ := value.(map[string]any)
		repository, _ := entry["repository"].(map[string]any)
		if repository["id"] != repositoryID {
			continue
		}
		key := "delivery"
		if stage == "monitor" {
			key = "publicationMonitor"
		} else if stage == "update" {
			key = "branchUpdate"
		}
		record, _ := entry[key].(map[string]any)
		return record
	}
	return nil
}

func matchesTaskWorkspaces(task map[string]any, workspaces []workspace.Workspace) error {
	entries, _ := task["repositories"].([]any)
	if len(entries) <= 1 {
		entries = []any{task}
	}
	if len(entries) == 0 || len(entries) != len(workspaces) {
		return errors.New("task workspace set changed")
	}
	seen := map[string]bool{}
	for _, value := range entries {
		entry, _ := value.(map[string]any)
		repository, _ := entry["repository"].(map[string]any)
		id, _ := repository["id"].(string)
		root, _ := entry["workspaceRoot"].(string)
		if id == "" || root == "" || seen[id] {
			return errors.New("task workspace set changed")
		}
		seen[id] = true
		var actual string
		for _, candidate := range workspaces {
			if candidate.RepositoryID == id {
				actual = candidate.Root
				break
			}
		}
		if actual == "" {
			return errors.New("task workspace set changed")
		}
		storedInfo, storedErr := os.Stat(root)
		actualInfo, actualErr := os.Stat(actual)
		if storedErr != nil || actualErr != nil || !storedInfo.IsDir() || !actualInfo.IsDir() || !os.SameFile(storedInfo, actualInfo) {
			return errors.New("task workspace set changed")
		}
	}
	return nil
}

// Execute runs one specialist or auxiliary turn under a workspace lease.
// Callers must authenticate approvals, hold the task action lock, supply
// trusted configuration and supervise persistence. Interactive tmux sessions
// share the same supervised process lifecycle. Continuations use fresh context.
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
	request.Prompt = NoSelfCredit + "\n" + request.Prompt
	switch request.Stage {
	case "triage", "investigate", "plan", "implement", "verify", "review", "publish", "monitor", "followup", "update":
	default:
		return RunResult{}, errors.New("unsupported workflow stage")
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
	if err := matchesTaskWorkspaces(task, request.Workspaces); err != nil {
		return RunResult{}, err
	}
	if request.Auxiliary {
		// Watching a pull request is read-only, so it is allowed on a task that is not (or no longer)
		// accepted, such as one paused after it was published; publishing and follow-ups still need acceptance.
		watching := request.Stage == "monitor" && hasPullRequest(task, request.ActiveRepositoryID)
		// Resolving an Update branch merge only touches the task's own branch, and a person
		// reviews the result before it is pushed, so it does not need an accepted task either.
		updating := request.Stage == "update"
		if request.Debug || (request.Stage != "publish" && request.Stage != "monitor" && request.Stage != "followup" && !updating) || (!HasFinalApproval(task) && !watching && !updating) {
			return RunResult{}, errors.New("publication requires an accepted, verified task")
		}
		record := auxiliaryRecord(task, request.ActiveRepositoryID, request.Stage)
		id, _ := record["id"].(string)
		if id == "" {
			id, _ = record["attemptId"].(string)
		}
		if id != request.AttemptID || record["status"] != "running" {
			return RunResult{}, errors.New("publication attempt is not running")
		}
	} else if request.Stage == "publish" || request.Stage == "monitor" || request.Stage == "update" || task["status"] != "running" || task["stage"] != request.Stage {
		return RunResult{}, errors.New("task is not running this stage")
	}
	routing, _ := task["routing"].(map[string]any)
	routeStage := request.Stage
	if routeStage == "verify" {
		routeStage = "implement"
	}
	if routeStage == "publish" || routeStage == "update" {
		routeStage = "implement"
	}
	if routeStage == "monitor" {
		routeStage = "investigate"
	}
	if request.Debug {
		recovery, _ := task["recovery"].(map[string]any)
		if recovery["active"] != true || recovery["phase"] != "debug" {
			return RunResult{}, errors.New("debugger has not been scheduled")
		}
	} else if request.Auxiliary {
		if auxiliaryRecord(task, request.ActiveRepositoryID, request.Stage)["harness"] != request.Provider {
			return RunResult{}, errors.New("selected harness does not match the scheduled agent")
		}
	} else if routing[routeStage] != request.Provider {
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
	if (request.Stage == "implement" && !request.Debug) || request.Stage == "publish" || request.Stage == "update" {
		mode = workspace.WriteOne
	}
	executionStage := request.Stage
	if request.Debug {
		executionStage = "investigate"
	}
	var result RunResult
	err = request.Store.WithOwnership(func(stateRoot string, verify func() error) error {
		guard, guardErr := workspace.GuardedRunExpected(ctx, request.Lease, request.TaskID, request.Workspaces, mode, request.ActiveRepositoryID, request.Admission, request.Inspector, request.ExpectedBefore, func(runCtx context.Context) error {
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
			if err = writeNew(schemaPath, []byte(schemaFor(executionStage))); err != nil {
				return storageError(err)
			}
			if err = writeNew(filepath.Join(attemptDir, "prompt.txt"), []byte(request.Prompt)); err != nil {
				return storageError(err)
			}
			invocation, err := Build(request.Provider, request.Config, schemaPath, executionStage, request.SessionID)
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
			if request.Terminals && terminal.Available() {
				spec, path, terminalErr := terminal.Prepare(request.WorkerExecutable, nil, invocation.Command, invocation.Args, cwd, request.Environment, []byte(request.Prompt), false)
				if terminalErr != nil {
					return terminalErr
				}
				defer os.RemoveAll(spec.Directory)
				record := map[string]any{"terminal": spec.Info, "attemptId": request.AttemptID, "active": true}
				encoded, _ := json.Marshal(record)
				if err = request.Store.SetMeta("terminal:"+request.TaskID, string(encoded)); err != nil {
					return err
				}
				defer func() {
					record["active"] = false
					encoded, _ := json.Marshal(record)
					_ = request.Store.SetMeta("terminal:"+request.TaskID, string(encoded))
					request.Store.NotifyChange()
				}()
				if err = request.OnEvent(runCtx, map[string]any{"type": "terminal", "terminal": spec.Info, "summary": "Agent terminal is available."}); err != nil {
					return err
				}
				invocation.Command, invocation.Args = request.WorkerExecutable, []string{"--internal-terminal-worker", path}
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
			result.Handoff, err = finalHandoff(final, executionStage)
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
