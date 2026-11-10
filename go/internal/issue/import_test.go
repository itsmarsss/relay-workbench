//go:build darwin || linux

package issue

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"relay.local/relay/internal/process"
)

func TestIssueWorker(t *testing.T) {
	if os.Getenv("RELAY_ISSUE_WORKER") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Exit(process.Worker(os.Args[i+1:]))
		}
	}
	os.Exit(127)
}

func TestIssueInvocationKeepsTicketLiteralAndRejectsScripts(t *testing.T) {
	ticket := "https://example.test/issues/$(touch-not-a-command)"
	invocation, github, err := Invocation(Command{Executable: "issue-cli", Args: []string{"view", "{ticket}"}}, ticket)
	if err != nil || github || invocation.Args[1] != ticket {
		t.Fatalf("literal ticket changed: %#v %v", invocation, err)
	}
	for _, command := range []Command{
		{Executable: "/bin/sh", Args: []string{"-c", "{ticket}"}},
		{Executable: "/usr/bin/env", Args: []string{"sh", "-c", "{ticket}"}},
		{Executable: "pwsh", Args: []string{"-EncodedCommand", "{ticket}"}},
		{Executable: "cli", Args: []string{"--issue={ticket}"}},
		{Executable: "cli", Args: []string{"{ticket}", "{ticket}"}},
	} {
		if _, _, err := Invocation(command, ticket); err == nil {
			t.Fatalf("unsafe command accepted: %#v", command)
		}
	}
	for _, value := range []string{"", "http://example.test/issue/1", "https://user:pass@example.test/issue/1", "https://example.test/issue/1\nnext"} {
		if _, _, err := Invocation(Command{Executable: "cli", Args: []string{"{ticket}"}}, value); err == nil {
			t.Fatalf("invalid ticket accepted: %q", value)
		}
	}
}

func TestGitHubInvocationSupportsGlobalRepositoryFlags(t *testing.T) {
	invocation, github, err := Invocation(Command{Executable: "gh", Args: []string{"--repo", "owner/repo", "issue", "view", "{ticket}"}}, "42")
	if err != nil || !github || !strings.Contains(strings.Join(invocation.Args, " "), "--json title,body,url") {
		t.Fatalf("global flags lost GitHub context: %#v %v", invocation, err)
	}
}

func TestImportGitHubIncludesFullDiscussionAndAuthor(t *testing.T) {
	calls := [][]string{}
	run := func(_ context.Context, executable string, args []string, cwd string) (process.Result, error) {
		calls = append(calls, append([]string{executable}, args...))
		if len(calls) == 1 {
			return process.Result{ExitCode: 0, Stdout: `{"title":"Issue title","body":"Issue body","url":"https://code.example/team/repo/issues/42","author":{"login":"filed_by"},"labels":[{"name":"bug"}]}`}, nil
		}
		return process.Result{ExitCode: 0, Stdout: `[[{"body":"First comment","user":{"login":"reviewer"},"created_at":"2026-01-01","html_url":"https://code.example/team/repo/issues/42#c1"}],[{"body":"Second comment","author":{"login":"other"}}]]`}, nil
	}
	result, err := Import(context.Background(), Command{Executable: "gh", Args: []string{"issue", "view", "{ticket}", "--json", "state"}}, "42", t.TempDir(), run)
	if err != nil {
		t.Fatal(err)
	}
	if result.Title != "Issue title" || !strings.Contains(result.Description, "Filed by: **filed\\_by**") || !strings.Contains(result.Description, "First comment") || !strings.Contains(result.Description, "Second comment") || len(result.Warnings) != 0 {
		t.Fatalf("context missing: %#v", result)
	}
	if len(calls) != 2 || !strings.Contains(strings.Join(calls[0], " "), "state,title,body,url") || !strings.Contains(strings.Join(calls[1], " "), "--paginate --slurp") {
		t.Fatalf("pagination or fields missing: %#v", calls)
	}
}

func TestImportGitHubRejectsMismatchedIssueBeforeLoadingComments(t *testing.T) {
	calls := 0
	run := func(context.Context, string, []string, string) (process.Result, error) {
		calls++
		return process.Result{ExitCode: 0, Stdout: `{"title":"Wrong","body":"Body","url":"https://code.example/team/repo/issues/43"}`}, nil
	}
	if _, err := Import(context.Background(), Command{Executable: "gh", Args: []string{"issue", "view", "{ticket}"}}, "42", t.TempDir(), run); err == nil || !strings.Contains(err.Error(), "different issue") || calls != 1 {
		t.Fatalf("mismatched issue accepted: calls %d, error %v", calls, err)
	}
}

func TestIssueDescriptionFailsClosedOnIncompleteOrOversizedDiscussion(t *testing.T) {
	var item map[string]any
	if err := json.Unmarshal([]byte(`{"body":"Body","comments":{"totalCount":2,"nodes":[{"body":"one"}]}}`), &item); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Description(item); err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("partial discussion accepted: %v", err)
	}
	item = map[string]any{"body": strings.Repeat("x", 50001), "comments": []any{}}
	var limit *ImportError
	if _, _, err := Description(item); !errors.As(err, &limit) || limit.Status != 413 {
		t.Fatalf("oversized issue was truncated: %v", err)
	}
}

func TestIssueImportWarnsWhenDiscussionIsUnavailable(t *testing.T) {
	run := func(context.Context, string, []string, string) (process.Result, error) {
		return process.Result{ExitCode: 0, Stdout: `{"title":"T","body":"B","author":{"name":"Author"}}`}, nil
	}
	result, err := Import(context.Background(), Command{Executable: "cli", Args: []string{"{ticket}"}}, "123", t.TempDir(), run)
	if err != nil || len(result.Warnings) != 1 || !strings.Contains(result.Description, "Filed by: **Author**") || result.Ticket != "123" {
		t.Fatalf("missing warning or context: %#v %v", result, err)
	}
}

func TestProcessExecutorDoesNotEvaluateTicketArgument(t *testing.T) {
	root := t.TempDir()
	program, observed := filepath.Join(root, "importer"), filepath.Join(root, "argument")
	if err := os.WriteFile(program, []byte("#!/bin/sh\nprintf '%s' \"$1\" > \"$RELAY_ISSUE_ARGUMENT\"\nprintf '%s' '{\"title\":\"T\",\"body\":\"B\"}'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	worker, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	execute := ProcessExecutor(worker, []string{"-test.run=^TestIssueWorker$", "--"}, map[string]string{"RELAY_ISSUE_WORKER": "1", "RELAY_ISSUE_ARGUMENT": observed})
	ticket := "https://example.test/$(touch-not-a-command)"
	if _, err = Import(context.Background(), Command{Executable: program, Args: []string{"{ticket}"}}, ticket, root, execute); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(observed)
	if err != nil || string(data) != ticket {
		t.Fatalf("ticket argument changed: %q %v", data, err)
	}
}

func TestIssueImportCancellationStopsConfiguredProcess(t *testing.T) {
	root := t.TempDir()
	program, marker := filepath.Join(root, "importer"), filepath.Join(root, "started")
	if err := os.WriteFile(program, []byte("#!/bin/sh\ntouch \"$RELAY_ISSUE_MARKER\"\nsleep 30\n"), 0700); err != nil {
		t.Fatal(err)
	}
	worker, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	execute := ProcessExecutor(worker, []string{"-test.run=^TestIssueWorker$", "--"}, map[string]string{"RELAY_ISSUE_WORKER": "1", "RELAY_ISSUE_MARKER": marker})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := Import(ctx, Command{Executable: program, Args: []string{"{ticket}"}}, "42", root, execute)
		done <- err
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("issue importer did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, process.ErrCancelled) {
			t.Fatalf("cancellation not propagated: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled issue importer did not terminate")
	}
}
