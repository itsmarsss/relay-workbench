//go:build darwin || linux

package workflow

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"relay.local/relay/internal/task"
)

func TestAddRepositoryInOneStepUsesWhatItDetects(t *testing.T) {
	c, db, _, _ := coordinatorFixture(t, "exit 0")
	repo := repositoryFixture(t)
	if err := os.WriteFile(filepath.Join(repo, "package.json"), []byte(`{"name":"widget-shop","packageManager":"pnpm@9.0.0","scripts":{"test":"node --test"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "pnpm-lock.yaml"), []byte("lockfileVersion: '9.0'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitFixture(t, repo, "remote", "add", "origin", "git@github.com:octo/widget-shop.git")
	result, err := c.Discover(context.Background(), "add", map[string]any{"path": repo})
	if err != nil {
		t.Fatal(err)
	}
	profile := object(object(result)["repository"])
	if _, err := exec.LookPath("gh"); err == nil {
		// Issue links work straight away for a GitHub repository.
		issue := object(profile["issueCommand"])
		if issue["command"] != "gh" || fmt.Sprint(issue["args"]) != "[issue view {ticket} --repo octo/widget-shop]" {
			t.Fatalf("issue import: %#v", issue)
		}
	}
	if profile["name"] != "widget-shop" || profile["verificationMode"] != "agent" || len(array(profile["setup"])) != 1 {
		t.Fatalf("profile: %#v", profile)
	}
	config, _ := (task.ConfigurationService{Store: db}).Read()
	saved := false
	for _, item := range array(config.Value["repositories"]) {
		if object(item)["name"] == "widget-shop" {
			saved = true
			if command := object(array(object(item)["setup"])[0]); command["command"] != "pnpm" {
				t.Fatalf("install step: %#v", command)
			}
		}
	}
	if !saved {
		t.Fatal("profile was not saved")
	}
	again, err := c.Discover(context.Background(), "add", map[string]any{"path": repo})
	if err != nil || object(again)["existing"] != true {
		t.Fatalf("adding twice made a duplicate: %#v %v", again, err)
	}
	if _, err = c.Discover(context.Background(), "add", map[string]any{"path": "relative/path"}); err == nil {
		t.Fatal("accepted a relative path")
	}
}

func TestCloneRepositoryFromAURL(t *testing.T) {
	c, db, _, _ := coordinatorFixture(t, "exit 0")
	source := repositoryFixture(t)
	bare := filepath.Join(t.TempDir(), "widgets.git")
	gitFixture(t, source, "clone", "-q", "--bare", source, bare)
	into := t.TempDir()
	// Only real remote URLs are accepted; a local path or an option is refused before git runs.
	for _, bad := range []string{bare, "--upload-pack=touch /tmp/x", "https://example.com/a b", "file:///etc"} {
		if _, err := c.Discover(context.Background(), "clone", map[string]any{"url": bad, "directory": into}); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	if entries, _ := os.ReadDir(into); len(entries) != 0 {
		t.Fatal("a refused URL created files")
	}
	// A real URL clones and adds; cloning one that is already there just adds it.
	destination := filepath.Join(into, "widgets")
	gitFixture(t, source, "clone", "-q", bare, destination)
	result, err := c.Discover(context.Background(), "clone", map[string]any{"url": "https://code.example/team/widgets.git", "directory": into})
	if err != nil {
		t.Fatal(err)
	}
	if path := text(object(object(result)["repository"])["path"]); filepath.Base(path) != "widgets" {
		t.Fatalf("cloned repository was not added: %#v", result)
	}
	config, _ := (task.ConfigurationService{Store: db}).Read()
	if len(array(config.Value["repositories"])) != 2 {
		t.Fatalf("expected the fixture and the clone: %d", len(array(config.Value["repositories"])))
	}
}

func TestSetupCheckListsPrerequisitesAndRunsOnlyItsOwnCommands(t *testing.T) {
	c, _, _, _ := coordinatorFixture(t, "exit 0")
	value, err := c.SetupCheck(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	items := value.([]SetupItem)
	byID := map[string]SetupItem{}
	for _, item := range items {
		byID[item.ID] = item
	}
	if byID["git"].Status != "ok" || !byID["git"].Required {
		t.Fatalf("git: %+v", byID["git"])
	}
	for _, id := range []string{"claude", "codex", "pi", "gh", "tmux", "go", "pnpm", "disk"} {
		if _, ok := byID[id]; !ok {
			t.Fatalf("missing %s", id)
		}
	}
	if byID["claude"].Status != "off" {
		t.Fatalf("a turned-off agent was probed: %+v", byID["claude"])
	}
	// A request names an item and an action; it can never carry a command.
	for _, body := range []map[string]any{
		{"item": "git", "action": "install", "command": "rm"},
		{"item": "nothing", "action": "install"},
		{"item": "git", "action": "install"}, // installed already: nothing to run
	} {
		c.terminals = true
		if _, err := c.RunSetup(context.Background(), body); err == nil {
			t.Fatalf("ran setup for %#v", body)
		}
	}
	c.mu.Lock()
	open := c.jobs[SetupTerminalID] != nil
	c.mu.Unlock()
	if open {
		t.Fatal("a refused request opened a terminal")
	}
}

func waitSetup(t *testing.T, c *Coordinator, id string, want ...string) RepositorySetup {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		state, _ := c.setupState(id)
		for _, status := range want {
			if state.Status == status {
				return state
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	state, _ := c.setupState(id)
	t.Fatalf("setup stayed %s: %s", state.Status, state.Summary)
	return state
}

func TestAnAgentProposesSetupAndNothingRunsUntilItIsApproved(t *testing.T) {
	proposal := `{"summary":"A shell project.","cwd":".","setup":[{"command":"/bin/sh","args":["-c","printf ran > setup-ran.txt"],"why":"prepares","source":"ci.yml"}],"checks":[{"command":"/bin/sh","args":["-c","test -f setup-ran.txt"],"why":"checks","source":"ci.yml"}],"services":[{"name":"Redis","why":"cache tests","source":"README.md"}],"environment":[],"guidance":"Use the shell."}`
	event, _ := json.Marshal(map[string]any{"type": "item.completed", "item": map[string]any{"type": "agent_message", "text": "Here it is:\n" + proposal}})
	c, db, _, source := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+string(event)+"'")
	config, _ := (task.ConfigurationService{Store: db}).Read()
	before, _ := json.Marshal(config.Value["repositories"])
	if _, err := c.RepositorySetupAction(context.Background(), map[string]any{"repositoryId": "repo", "action": "propose"}); err != nil {
		t.Fatal(err)
	}
	state := waitSetup(t, c, "repo", "proposed", "error")
	if state.Status != "proposed" || state.Proposal == nil || len(state.Proposal.Setup) != 1 || state.Proposal.Services[0].Name != "Redis" {
		t.Fatalf("proposal: %+v", state)
	}
	config, _ = (task.ConfigurationService{Store: db}).Read()
	if after, _ := json.Marshal(config.Value["repositories"]); string(after) != string(before) {
		t.Fatal("a proposal changed settings before approval")
	}
	if _, err := os.Stat(filepath.Join(source, "setup-ran.txt")); err == nil {
		t.Fatal("a proposed command ran")
	}
	if _, err := c.RepositorySetupAction(context.Background(), map[string]any{"repositoryId": "repo", "action": "apply", "proposal": state.Proposal, "useChecks": true}); err != nil {
		t.Fatal(err)
	}
	state = waitSetup(t, c, "repo", "tested", "failed", "error")
	if state.Status != "tested" || len(state.Steps) != 2 {
		t.Fatalf("test: %+v", state)
	}
	config, _ = (task.ConfigurationService{Store: db}).Read()
	profile := object(array(config.Value["repositories"])[0])
	if profile["verificationMode"] != "commands" || len(array(profile["setup"])) != 1 || !strings.Contains(text(profile["instructions"]), "Needs Redis") {
		t.Fatalf("profile: %#v", profile)
	}
	if _, err := os.Stat(filepath.Join(source, "setup-ran.txt")); err == nil {
		t.Fatal("the test ran in the original checkout instead of a throwaway copy")
	}
	if out := gitOutput(t, source, "worktree", "list"); strings.Count(out, "\n") != 0 {
		t.Fatalf("throwaway copies were left behind: %s", out)
	}
	// A failing check is reported, and asking again carries what failed to the agent.
	state.Proposal.Checks[0].Args = []string{"-c", "echo broke; exit 4"}
	if _, err := c.RepositorySetupAction(context.Background(), map[string]any{"repositoryId": "repo", "action": "apply", "proposal": state.Proposal, "useChecks": true}); err != nil {
		t.Fatal(err)
	}
	state = waitSetup(t, c, "repo", "tested", "failed", "error")
	if state.Status != "failed" || state.Steps[len(state.Steps)-1].Exit != 4 {
		t.Fatalf("failure: %+v", state)
	}
	// Commands must be argument lists: a shell line is refused.
	state.Proposal.Setup[0].Command = "rm -rf /"
	if _, err := c.RepositorySetupAction(context.Background(), map[string]any{"repositoryId": "repo", "action": "apply", "proposal": state.Proposal}); err == nil {
		t.Fatal("accepted a shell line as a command")
	}
}

func TestSetupOutputDropsTerminalColourCodes(t *testing.T) {
	if got := tailText("\x1b[31mfailed\x1b[0m here\x1b]0;title\x07", 100); got != "failed here" {
		t.Fatalf("got %q", got)
	}
}

func TestStagesRoutedToMissingAgentsUseAnInstalledOne(t *testing.T) {
	c, db, id, _ := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+stageFinal()+"'")
	value := coordinatorTask(t, db, id)
	// Only Codex is enabled in the fixture; route planning to Claude and triage to Pi.
	value["routing"] = map[string]any{"triage": "pi", "investigate": "codex", "plan": "claude", "implement": "codex", "review": "claude"}
	saved(t, db, value)
	if _, err := c.Start(id); err != nil {
		t.Fatalf("a task with an uninstalled agent in its routing could not start: %v", err)
	}
	waitCoordinator(t, c, id)
	value = coordinatorTask(t, db, id)
	routing := object(value["routing"])
	if routing["plan"] != "codex" || routing["review"] != "codex" || routing["triage"] != "codex" {
		t.Fatalf("routing: %#v", routing)
	}
	if value["status"] != "awaiting_plan" {
		t.Fatalf("task did not run: %v %v", value["status"], value["error"])
	}
	events, _ := db.Events(id, 0, 500)
	found := false
	for _, raw := range events {
		if strings.Contains(string(raw), "uses Codex") {
			found = true
		}
	}
	if !found {
		t.Fatal("the reroute was not recorded in the activity")
	}
}
