package assistant

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"relay.local/relay/internal/attachments"
	"relay.local/relay/internal/memory"
	"relay.local/relay/internal/process"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/tasksummary"
	"relay.local/relay/internal/workspace"
	"strconv"
	"strings"
	"time"
)

type tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func tools() []tool {
	str := map[string]any{"type": "string"}
	number := map[string]any{"type": "integer", "minimum": 1, "maximum": 300}
	makeTool := func(name, description string, props map[string]any, required ...string) tool {
		if required == nil {
			required = []string{}
		}
		return tool{name, description, map[string]any{"type": "object", "properties": props, "required": required, "additionalProperties": false}}
	}
	return []tool{
		makeTool("list_tasks", "Read current workspace tasks.", map[string]any{}),
		makeTool("get_task", "Read a task's full current context and workflow state.", map[string]any{"taskId": str}, "taskId"),
		makeTool("read_task_activity", "Read recent task activity, handoffs and failures.", map[string]any{"taskId": str}, "taskId"),
		makeTool("read_configuration", "Read current provider, repository and execution settings; credentials are excluded.", map[string]any{}),
		makeTool("read_memory", "Read approved global and task/project memory.", map[string]any{"taskId": str}),
		makeTool("read_model_catalog", "Discover actual provider models.", map[string]any{}),
		makeTool("read_attachment", "View a local image referenced in this conversation or a selected task. Supply its /api/attachments URL.", map[string]any{"url": str, "taskId": str}, "url"),
		makeTool("search_conversation", "Find older conversation exchanges.", map[string]any{"query": str}, "query"),
		makeTool("read_file", "Read prepared worktree source with line and revision evidence. Relative paths only.", map[string]any{"taskId": str, "repositoryId": str, "path": str, "startLine": map[string]any{"type": "integer", "minimum": 1}, "lines": number}, "repositoryId", "path"),
		makeTool("list_files", "List tracked/nonignored prepared worktree files under a relative directory.", map[string]any{"taskId": str, "repositoryId": str, "path": str}, "repositoryId"),
		makeTool("search", "Search a literal string in a narrow prepared source directory.", map[string]any{"taskId": str, "repositoryId": str, "path": str, "text": str}, "repositoryId", "text"),
		makeTool("git_inspect", "Read worktree status, diff or recent history; no arbitrary arguments.", map[string]any{"taskId": str, "repositoryId": str, "operation": map[string]any{"enum": []string{"status", "diff", "log"}}, "path": str}, "repositoryId", "operation"),
		makeTool("github_read", "Read GitHub issue, PR, checks, diff, search or relative REST GET with host authentication. Never writes.", map[string]any{"operation": map[string]any{"enum": []string{"issue", "pull_request", "checks", "diff", "search_issues", "search_prs", "api_get"}}, "repository": str, "number": map[string]any{"type": "integer", "minimum": 1}, "query": str, "endpoint": str}, "operation"),
		makeTool("create_draft", "Create an unstarted task draft if permitted. Read issue context and reuse existing tickets.", map[string]any{"task": map[string]any{"type": "object", "additionalProperties": true}}, "task"),
		makeTool("propose_task_change", "Persist an exact task action for separate human approval. Never applies it. Settings, direction, workflow, publication and PR feedback controls are supported.", map[string]any{"taskId": str, "operation": str, "body": map[string]any{"type": "object", "additionalProperties": true}, "reason": str}, "taskId", "operation", "body", "reason"),
		makeTool("propose_config_change", "Propose a complete validated configuration replacement; read_configuration first. Human approval and matching revision are required.", map[string]any{"config": map[string]any{"type": "object", "additionalProperties": true}, "reason": str}, "config", "reason"),
	}
}
func (s *Service) configuration() (map[string]any, error) {
	config, err := (task.ConfigurationService{Store: s.Store}).Read()
	if err != nil {
		return nil, err
	}
	return config.Value, nil
}
func (s *Service) context(chat Chat, message Message) ([]byte, error) {
	config, err := s.configuration()
	if err != nil {
		return nil, err
	}
	settings := obj(config["workspaceAgent"])
	permissions := obj(settings["permissions"])
	result := map[string]any{"capturedAt": now(), "taskId": chat.TaskID, "permissions": permissions, "readOnly": chat.TaskID != "", "memoryRules": memory.Rules, "capabilities": []string{"read_task", "read_source", "github_read", "create_draft", "propose_task_change", "propose_config_change"}}
	if permissions["readSettings"] == true {
		result["configuration"] = config
	}
	history := []map[string]any{}
	for _, m := range chat.Messages {
		if m.Status == "complete" {
			history = append(history, map[string]any{"question": m.Question, "answer": trim(m.Answer, 12000), "mentions": m.Mentions})
		}
	}
	if len(history) > 8 {
		history = history[len(history)-8:]
	}
	result["conversation"] = history
	mentioned := []any{}
	ids := append([]string{}, message.Mentions...)
	if chat.TaskID != "" {
		ids = append(ids, chat.TaskID)
	}
	for _, id := range ids {
		if raw, err := s.Store.Get(id); err == nil {
			var value any
			if json.Unmarshal(raw, &value) == nil {
				mentioned = append(mentioned, value)
			}
		}
	}
	result["mentionedTasks"] = mentioned
	images, err := attachments.Context(s.Store, map[string]any{"description": message.Question, "messages": history})
	if err != nil {
		return nil, err
	}
	result["images"] = images
	if permissions["readMemory"] == true {
		rows, err := memory.Select(s.Store, chat.TaskID, nil)
		if err != nil {
			return nil, err
		}
		result["memories"] = rows
	}
	raw, err := json.Marshal(result)
	if len(raw) > 2*1024*1024 {
		return nil, errors.New("conversation context exceeds limit; narrow task references")
	}
	return raw, err
}
func (s *Service) call(ctx context.Context, chat Chat, name string, input map[string]any) (any, error) {
	var definition *tool
	for _, t := range tools() {
		if t.Name == name {
			copy := t
			definition = &copy
			break
		}
	}
	if definition == nil {
		return nil, errors.New("unknown tool")
	}
	properties := obj(definition.InputSchema["properties"])
	for key, value := range input {
		if properties[key] == nil {
			return nil, fmt.Errorf("unexpected tool field: %s", key)
		}
		property := obj(properties[key])
		switch property["type"] {
		case "string":
			if _, ok := value.(string); !ok {
				return nil, fmt.Errorf("%s must be a string", key)
			}
		case "integer":
			n, ok := value.(float64)
			if !ok || n != float64(int64(n)) {
				return nil, fmt.Errorf("%s must be an integer", key)
			}
		case "object":
			if obj(value) == nil {
				return nil, fmt.Errorf("%s must be an object", key)
			}
		}
		if allowed, ok := property["enum"].([]string); ok {
			valid := false
			for _, candidate := range allowed {
				if value == candidate {
					valid = true
				}
			}
			if !valid {
				return nil, errors.New("unsupported tool option")
			}
		}
		if text(value) != "" && len(text(value)) > 20000 {
			return nil, errors.New("tool field exceeds limit")
		}
	}
	for _, key := range definition.InputSchema["required"].([]string) {
		if input[key] == nil {
			return nil, fmt.Errorf("missing tool field: %s", key)
		}
	}
	config, err := s.configuration()
	if err != nil {
		return nil, err
	}
	permissions := obj(obj(config["workspaceAgent"])["permissions"])
	taskID := text(input["taskId"])
	if chat.TaskID != "" {
		if taskID != "" && taskID != chat.TaskID {
			return nil, errors.New("side chat is limited to its task")
		}
		taskID = chat.TaskID
	}
	readTask := func() (map[string]any, error) {
		raw, err := s.Store.Get(taskID)
		if err != nil {
			return nil, err
		}
		var value map[string]any
		if json.Unmarshal(raw, &value) != nil {
			return nil, errors.New("invalid task")
		}
		return value, nil
	}
	switch name {
	case "read_attachment":
		url := text(input["url"])
		name := strings.TrimPrefix(url, "/api/attachments/")
		if url == name || !attachments.Filename.MatchString(name) {
			return nil, errors.New("select a local image attachment")
		}
		current, err := s.Get(chat.ID)
		if err != nil {
			return nil, err
		}
		context, _ := json.Marshal(current.Messages)
		allowed := strings.Contains(string(context), url)
		if !allowed && taskID != "" {
			value, err := readTask()
			if err != nil {
				return nil, err
			}
			raw, _ := json.Marshal(value)
			allowed = strings.Contains(string(raw), url)
		}
		if !allowed {
			return nil, errors.New("image is not referenced by this conversation or selected task")
		}
		data, image, err := attachments.Read(s.Store, name)
		if err != nil {
			return nil, err
		}
		return imageContent{map[string]any{"type": "image", "mimeType": image.Type, "data": base64.StdEncoding.EncodeToString(data)}}, nil
	case "list_tasks":
		rows, err := s.Store.All()
		if err != nil {
			return nil, err
		}
		result := []any{}
		for _, raw := range rows {
			summary, err := tasksummary.Summarize(raw)
			if err != nil {
				return nil, err
			}
			if chat.TaskID == "" || summary["id"] == chat.TaskID {
				result = append(result, summary)
			}
		}
		return result, nil
	case "get_task":
		return readTask()
	case "read_task_activity":
		if taskID == "" {
			return nil, errors.New("select a task")
		}
		return s.Store.Events(taskID, 0, 200)
	case "read_configuration":
		if permissions["readSettings"] != true {
			return nil, errors.New("readSettings permission is disabled")
		}
		return config, nil
	case "read_model_catalog":
		if permissions["readSettings"] != true {
			return nil, errors.New("readSettings permission is disabled")
		}
		return s.Actions.Discover(ctx, "models", map[string]any{})
	case "read_memory":
		if permissions["readMemory"] != true {
			return nil, errors.New("readMemory permission is disabled")
		}
		ids := []string{}
		if taskID != "" {
			value, err := readTask()
			if err != nil {
				return nil, err
			}
			for _, r := range taskRepositories(value) {
				ids = append(ids, text(obj(r["repository"])["id"]))
			}
		}
		return memory.Select(s.Store, taskID, ids)
	case "search_conversation":
		current, err := s.Get(chat.ID)
		if err != nil {
			return nil, err
		}
		q := strings.ToLower(text(input["query"]))
		if q == "" {
			return nil, errors.New("enter a search query")
		}
		rows := []Message{}
		for i := len(current.Messages) - 1; i >= 0; i-- {
			m := current.Messages[i]
			if strings.Contains(strings.ToLower(m.Question+" "+m.Answer), q) {
				m.Answer = trim(m.Answer, 8000)
				rows = append(rows, m)
				if len(rows) >= 10 {
					break
				}
			}
		}
		return rows, nil
	case "create_draft":
		if chat.TaskID != "" || permissions["createDrafts"] != true {
			return nil, errors.New("draft creation is not permitted in this conversation")
		}
		draft := obj(input["task"])
		allowed := []string{"title", "description", "ticket", "preset", "repositoryId", "repositoryIds", "repositorySettings", "dependencies", "smartRouting", "routing", "models", "execution"}
		if draft == nil {
			return nil, errors.New("task must be an object")
		}
		if err := checkFields(draft, allowed...); err != nil {
			return nil, err
		}
		if ticket := text(draft["ticket"]); ticket != "" {
			rows, err := s.Store.All()
			if err != nil {
				return nil, err
			}
			for _, raw := range rows {
				var value map[string]any
				if json.Unmarshal(raw, &value) == nil && value["ticket"] == ticket {
					return map[string]any{"existingTask": value["id"], "title": value["title"]}, nil
				}
			}
		}
		return (task.ConfigurationService{Store: s.Store}).CreateTask(draft)
	case "propose_task_change", "propose_config_change":
		if chat.TaskID != "" {
			return nil, errors.New("side chats cannot propose changes")
		}
		permission := "proposeTasks"
		if name == "propose_config_change" {
			permission = "proposeSettings"
		}
		if permissions[permission] != true {
			return nil, errors.New("proposal permission is disabled")
		}
		return s.propose(chat, name, input)
	case "github_read":
		return s.github(ctx, input)
	default:
		value, err := readTask()
		if err != nil {
			return nil, err
		}
		return s.source(ctx, value, name, input)
	}
}
func taskRepositories(value map[string]any) []map[string]any {
	rows := array(value["repositories"])
	if len(rows) <= 1 {
		return []map[string]any{value}
	}
	result := []map[string]any{}
	for _, row := range rows {
		result = append(result, obj(row))
	}
	return result
}
func relative(value any) (string, error) {
	name := text(value)
	if name == "" {
		name = "."
	}
	if filepath.IsAbs(name) || len(name) > 2000 || strings.ContainsRune(name, '\x00') {
		return "", errors.New("use a relative source path")
	}
	for _, p := range strings.FieldsFunc(name, func(r rune) bool { return r == '/' || r == '\\' }) {
		if p == ".." || p == ".git" {
			return "", errors.New("source path escapes workspace")
		}
	}
	return filepath.ToSlash(filepath.Clean(name)), nil
}
func (s *Service) source(ctx context.Context, value map[string]any, name string, input map[string]any) (any, error) {
	var root string
	for _, row := range taskRepositories(value) {
		if text(obj(row["repository"])["id"]) == text(input["repositoryId"]) {
			root = text(row["workspaceRoot"])
		}
	}
	if root == "" {
		return nil, errors.New("no prepared worktree for this repository")
	}
	path, err := relative(input["path"])
	if err != nil {
		return nil, err
	}
	runner := workspace.Runner{WorkerExecutable: s.Worker, WorkerArgs: s.WorkerArgs, Environment: s.Environment}
	git := func(args ...string) (string, error) {
		return runner.RunGit(ctx, root, args, nil, map[string]string{"GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "GIT_PAGER": "cat"})
	}
	before, err := git("rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	result := map[string]any{"repositoryId": input["repositoryId"], "taskId": value["id"], "head": strings.TrimSpace(before), "observedAt": now(), "path": path}
	if name == "read_file" {
		data, err := workspace.ReadFile(root, path, 1024*1024)
		if err != nil {
			return nil, err
		}
		start, lines := 1, 200
		if v, ok := input["startLine"].(float64); ok {
			if v < 1 || v != float64(int(v)) {
				return nil, errors.New("invalid start line")
			}
			start = int(v)
		}
		if v, ok := input["lines"].(float64); ok {
			if v < 1 || v > 300 || v != float64(int(v)) {
				return nil, errors.New("invalid line count")
			}
			lines = int(v)
		}
		rows := strings.Split(string(data), "\n")
		end := min(start-1+lines, len(rows))
		if start > len(rows) {
			return nil, errors.New("line range exceeds file")
		}
		var b strings.Builder
		for i := start - 1; i < end; i++ {
			fmt.Fprintf(&b, "%d: %s\n", i+1, rows[i])
		}
		hash := sha256.Sum256(data)
		result["sha256"] = hex.EncodeToString(hash[:])
		result["text"] = b.String()
		result["totalLines"] = len(rows)
	} else if name == "git_inspect" {
		var args []string
		switch input["operation"] {
		case "status":
			args = []string{"--literal-pathspecs", "status", "--short", "--", path}
		case "diff":
			args = []string{"--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--", path}
		case "log":
			args = []string{"--literal-pathspecs", "log", "-20", "--format=%h %ad %s", "--date=iso", "--", path}
		default:
			return nil, errors.New("unsupported git read")
		}
		output, err := git(args...)
		if err != nil {
			return nil, err
		}
		result["text"] = trim(output, 100000)
	} else {
		output, err := git("--literal-pathspecs", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", path)
		if err != nil {
			return nil, err
		}
		files := []string{}
		seen := map[string]bool{}
		for _, file := range strings.Split(output, "\x00") {
			if file != "" && !seen[file] {
				files = append(files, file)
				seen[file] = true
			}
		}
		result["truncated"] = len(files) > 2000
		if len(files) > 2000 {
			files = files[:2000]
		}
		if name == "list_files" {
			result["files"] = files
		} else {
			needle := text(input["text"])
			if needle == "" || len(needle) > 1000 {
				return nil, errors.New("enter a bounded literal search")
			}
			matches := []map[string]any{}
			read := 0
			for _, file := range files {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				data, err := workspace.ReadFile(root, file, 256*1024)
				if err != nil {
					continue
				}
				read += len(data)
				if read > 8*1024*1024 {
					result["truncated"] = true
					break
				}
				if strings.ContainsRune(string(data), '\x00') {
					continue
				}
				for i, line := range strings.Split(string(data), "\n") {
					if strings.Contains(line, needle) {
						matches = append(matches, map[string]any{"path": file, "line": i + 1, "text": trim(line, 1000)})
						if len(matches) >= 100 {
							break
						}
					}
				}
				if len(matches) >= 100 {
					result["truncated"] = true
					break
				}
			}
			result["matches"] = matches
		}
	}
	if name == "read_file" {
		data, err := workspace.ReadFile(root, path, 1024*1024)
		if err != nil {
			result["changedDuringRead"] = true
		} else {
			hash := sha256.Sum256(data)
			result["changedDuringRead"] = hex.EncodeToString(hash[:]) != result["sha256"]
		}
	}
	after, err := git("rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	result["changedDuringRead"] = result["changedDuringRead"] == true || before != after
	return result, nil
}
func (s *Service) github(ctx context.Context, input map[string]any) (any, error) {
	repository := text(input["repository"])
	repoPattern := regexpRepo
	args := []string{}
	if repository != "" {
		if !repoPattern.MatchString(repository) {
			return nil, errors.New("repository must be OWNER/REPO")
		}
		args = []string{"--repo", repository}
	}
	op := text(input["operation"])
	var invocation []string
	switch op {
	case "issue", "pull_request", "checks", "diff":
		n, ok := input["number"].(float64)
		if !ok || n < 1 || n > 1e10 || n != float64(int64(n)) {
			return nil, errors.New("positive issue/PR number required")
		}
		number := strconv.FormatInt(int64(n), 10)
		if repository == "" {
			return nil, errors.New("explicit OWNER/REPO is required")
		}
		fields := "number,title,body,url,state,author,comments,labels,assignees,createdAt,updatedAt"
		switch op {
		case "issue":
			invocation = append([]string{"issue", "view", number}, args...)
			invocation = append(invocation, "--json", fields)
		case "pull_request":
			invocation = append([]string{"pr", "view", number}, args...)
			invocation = append(invocation, "--json", fields+",reviews,reviewDecision,statusCheckRollup,baseRefName,headRefName,mergedAt,isDraft")
		case "checks":
			invocation = append([]string{"pr", "checks", number}, args...)
			invocation = append(invocation, "--json", "name,state,bucket,link,workflow")
		case "diff":
			invocation = append([]string{"pr", "diff", number}, args...)
			invocation = append(invocation, "--color", "never")
		}
	case "search_issues", "search_prs":
		q := text(input["query"])
		if q == "" || len(q) > 2000 {
			return nil, errors.New("bounded search query required")
		}
		kind := "issues"
		if op == "search_prs" {
			kind = "prs"
		}
		invocation = append([]string{"search", kind}, args...)
		invocation = append(invocation, "--limit", "30", "--json", "number,title,url,state,repository,author,updatedAt", "--", q)
	case "api_get":
		endpoint := strings.TrimPrefix(text(input["endpoint"]), "/")
		if endpoint == "" || len(endpoint) > 4000 || strings.ContainsAny(endpoint, "\r\n\x00#") || strings.Contains(endpoint, "://") {
			return nil, errors.New("relative REST GET endpoint required")
		}
		decoded, err := urlPath(endpoint)
		if err != nil {
			return nil, err
		}
		for _, p := range strings.Split(strings.Split(decoded, "?")[0], "/") {
			if p == ".." || p == "." {
				return nil, errors.New("invalid REST endpoint")
			}
		}
		if strings.EqualFold(strings.Split(strings.Split(decoded, "?")[0], "/")[0], "graphql") || strings.HasPrefix(endpoint, "-") {
			return nil, errors.New("GraphQL and flags are not REST GET paths")
		}
		invocation = []string{"api", "--method", "GET", endpoint}
	default:
		return nil, errors.New("unsupported GitHub read")
	}
	directory, err := os.MkdirTemp("", "relay-provider-read-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(directory)
	result, err := process.Run(ctx, process.Options{WorkerExecutable: s.Worker, WorkerArgs: s.WorkerArgs, Environment: map[string]string{"GH_PROMPT_DISABLED": "1", "GH_PAGER": "cat", "PAGER": "cat", "NO_COLOR": "1"}, Command: "gh", Args: invocation, Directory: directory, Timeout: 30 * time.Second, MaxOutputBytes: 1024 * 1024})
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 && !(op == "checks" && (result.ExitCode == 1 || result.ExitCode == 8) && json.Valid([]byte(result.Stdout))) {
		return nil, errors.New(trim(result.Stderr, 3000))
	}
	return map[string]any{"provider": "github", "observedAt": now(), "operation": op, "output": result.Stdout}, nil
}

var regexpRepo = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

func urlPath(value string) (string, error) { return url.PathUnescape(value) }
