// Package issue imports ticket context through explicitly configured commands.
package issue

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"relay.local/relay/internal/process"
)

type Command struct {
	Executable string
	Args       []string
}

type Result struct {
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Ticket      string   `json:"ticket"`
	Warnings    []string `json:"warnings"`
}

type ImportError struct {
	Status  int
	Message string
}

func (e *ImportError) Error() string       { return e.Message }
func bad(status int, message string) error { return &ImportError{Status: status, Message: message} }

var number = regexp.MustCompile(`^[0-9]+$`)
var githubName = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

var githubFields = []string{"title", "body", "url", "number", "author", "createdAt", "updatedAt", "state", "labels", "assignees", "milestone"}

func normalizedNumber(value string) string {
	value = strings.TrimLeft(value, "0")
	if value == "" {
		return "0"
	}
	return value
}

func githubReference(value string) (*url.URL, []string, bool) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Port() != "" {
		return nil, nil, false
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 4 || parts[0] == "." || parts[0] == ".." || parts[1] == "." || parts[1] == ".." || !githubName.MatchString(parts[0]) || !githubName.MatchString(parts[1]) || parts[2] != "issues" || !number.MatchString(parts[3]) {
		return nil, nil, false
	}
	return u, parts, true
}

func validTicket(value string) bool {
	if len(utf16.Encode([]rune(value))) > 2000 || strings.ContainsAny(value, "\x00\r\n\t ") {
		return false
	}
	if number.MatchString(value) {
		return true
	}
	u, err := url.Parse(value)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil
}

// Invocation inserts the ticket as a literal argument, never into a command
// string. A configured executable is trusted; ticket content is not.
func Invocation(command Command, ticket string) (Command, bool, error) {
	if !validTicket(ticket) {
		return Command{}, false, bad(400, "Use an issue number or HTTPS issue URL")
	}
	if strings.TrimSpace(command.Executable) == "" || strings.ContainsRune(command.Executable, '\x00') || strings.Contains(command.Executable, "{ticket}") || len(command.Args) > 100 {
		return Command{}, false, bad(400, "Configure a valid issue import command")
	}
	args := make([]string, len(command.Args))
	placeholders := 0
	for i, arg := range command.Args {
		if strings.ContainsRune(arg, '\x00') || len(arg) > 20000 {
			return Command{}, false, bad(400, "Invalid issue import argument")
		}
		if strings.Contains(arg, "{ticket}") {
			if arg != "{ticket}" {
				return Command{}, false, bad(400, "Use {ticket} as a separate command argument")
			}
			if i > 0 {
				previous := strings.ToLower(command.Args[i-1])
				if previous == "-c" || previous == "-lc" || previous == "-e" || previous == "--eval" || previous == "--command" || previous == "-command" || previous == "-encodedcommand" || previous == "-enc" || previous == "/c" {
					return Command{}, false, bad(400, "Ticket text cannot be used as a command script")
				}
			}
			placeholders++
			args[i] = ticket
		} else {
			args[i] = arg
		}
	}
	if placeholders != 1 {
		return Command{}, false, bad(400, "Issue import needs one {ticket} argument")
	}
	github := false
	if strings.EqualFold(filepath.Base(command.Executable), "gh") {
		for i := 0; i+1 < len(args); i++ {
			if args[i] == "issue" && args[i+1] == "view" {
				github = true
				break
			}
		}
	}
	if github {
		index := -1
		for i, arg := range args {
			if arg == "--json" || strings.HasPrefix(arg, "--json=") {
				index = i
				break
			}
		}
		existing := ""
		if index >= 0 {
			if args[index] == "--json" && index+1 < len(args) {
				existing = args[index+1]
			} else if strings.HasPrefix(args[index], "--json=") {
				existing = strings.TrimPrefix(args[index], "--json=")
			}
		}
		seen := map[string]bool{}
		fields := []string{}
		for _, field := range append(strings.Split(existing, ","), githubFields...) {
			if field != "" && !seen[field] {
				seen[field] = true
				fields = append(fields, field)
			}
		}
		joined := strings.Join(fields, ",")
		if index < 0 {
			args = append(args, "--json", joined)
		} else if args[index] == "--json" {
			if index+1 >= len(args) {
				return Command{}, false, bad(400, "GitHub JSON fields are missing")
			}
			args[index+1] = joined
		} else {
			args[index] = "--json=" + joined
		}
	}
	return Command{Executable: command.Executable, Args: args}, github, nil
}

type Execute func(context.Context, string, []string, string) (process.Result, error)

// Import performs read-only issue retrieval. The caller must choose a trusted
// configured command and a repository working directory.
func Import(ctx context.Context, command Command, ticket, cwd string, run Execute) (Result, error) {
	if ctx == nil || run == nil || !filepath.IsAbs(cwd) {
		return Result{}, bad(400, "Issue importer is not configured")
	}
	invocation, github, err := Invocation(command, ticket)
	if err != nil {
		return Result{}, err
	}
	result, err := run(ctx, invocation.Executable, invocation.Args, cwd)
	if err != nil {
		return Result{}, err
	}
	if result.ExitCode != 0 {
		detail := tail(result.Stderr, 2000)
		if strings.TrimSpace(detail) == "" {
			detail = tail(result.Stdout, 2000)
		}
		return Result{}, bad(502, fmt.Sprintf("Issue import failed (exit %d): %s", result.ExitCode, detail))
	}
	var item map[string]any
	if json.Unmarshal([]byte(result.Stdout), &item) != nil || item == nil {
		return Result{}, bad(502, "Issue command must return a JSON object with title and body")
	}
	if github {
		issueURL, ok := item["url"].(string)
		if !ok {
			return Result{}, bad(502, "GitHub importer returned an invalid issue URL")
		}
		u, parts, valid := githubReference(issueURL)
		if !valid {
			return Result{}, bad(502, "GitHub importer returned an invalid issue URL")
		}
		if number.MatchString(ticket) {
			if normalizedNumber(ticket) != normalizedNumber(parts[3]) {
				return Result{}, bad(502, "GitHub importer returned a different issue")
			}
		} else {
			requested, requestedParts, valid := githubReference(ticket)
			if !valid || !strings.EqualFold(requested.Hostname(), u.Hostname()) || !strings.EqualFold(requestedParts[0], parts[0]) || !strings.EqualFold(requestedParts[1], parts[1]) || normalizedNumber(requestedParts[3]) != normalizedNumber(parts[3]) {
				return Result{}, bad(502, "GitHub importer returned a different issue")
			}
		}
		endpoint := fmt.Sprintf("repos/%s/%s/issues/%s/comments?per_page=100", parts[0], parts[1], parts[3])
		comments, err := run(ctx, invocation.Executable, []string{"api", "--hostname", u.Hostname(), "--paginate", "--slurp", endpoint}, cwd)
		if err != nil {
			return Result{}, err
		}
		if comments.ExitCode != 0 {
			detail := tail(comments.Stderr, 2000)
			if strings.TrimSpace(detail) == "" {
				detail = tail(comments.Stdout, 2000)
			}
			return Result{}, bad(502, fmt.Sprintf("Issue discussion import failed (exit %d): %s", comments.ExitCode, detail))
		}
		var pages [][]any
		if json.Unmarshal([]byte(comments.Stdout), &pages) != nil || pages == nil {
			return Result{}, bad(502, "Issue discussion command returned invalid paginated JSON")
		}
		merged := []any{}
		for _, page := range pages {
			if page == nil {
				return Result{}, bad(502, "Invalid issue discussion page")
			}
			merged = append(merged, page...)
		}
		item["comments"] = merged
	}
	title, ok := item["title"].(string)
	if !ok || strings.TrimSpace(title) == "" || len(utf16.Encode([]rune(title))) > 240 {
		return Result{}, bad(502, "Issue title must be a nonempty string of at most 240 characters")
	}
	description, commentsIncluded, err := Description(item)
	if err != nil {
		return Result{}, err
	}
	resultTicket := ticket
	if value, ok := item["url"].(string); ok && safeLink(value) != "" {
		resultTicket = value
	}
	warnings := []string{}
	if !commentsIncluded {
		warnings = append(warnings, "The configured importer did not provide issue comments.")
	}
	return Result{Title: strings.TrimSpace(title), Description: description, Ticket: resultTicket, Warnings: warnings}, nil
}

func tail(value string, limit int) string {
	if len(value) > limit {
		return value[len(value)-limit:]
	}
	return value
}

// ProcessExecutor builds an explicit argv execution adapter for a trusted worker.
func ProcessExecutor(worker string, workerArgs []string, env map[string]string) Execute {
	return func(ctx context.Context, executable string, args []string, cwd string) (process.Result, error) {
		return process.Run(ctx, process.Options{WorkerExecutable: worker, WorkerArgs: workerArgs, Environment: env, Command: executable, Args: args, Directory: cwd, Timeout: 60 * time.Second, MaxOutputBytes: 8 * 1024 * 1024})
	}
}
