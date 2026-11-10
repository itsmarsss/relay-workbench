//go:build darwin || linux

package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/workspace"
)

func coordinatorFixture(t *testing.T, script string) (*Coordinator, *store.Store, string, string) {
	t.Helper()
	source := repositoryFixture(t)
	if err := os.WriteFile(filepath.Join(source, "file.txt"), []byte("local changes\n"), 0600); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	worker, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	program := filepath.Join(t.TempDir(), "agent")
	if err = os.WriteFile(program, []byte("#!/bin/sh\n"+script+"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	configService := task.ConfigurationService{Store: db}
	config, err := configService.Read()
	if err != nil {
		t.Fatal(err)
	}
	object(object(config.Value["harnesses"])["codex"])["command"] = program
	object(object(config.Value["harnesses"])["claude"])["enabled"] = false
	object(object(config.Value["harnesses"])["pi"])["enabled"] = false
	config.Value["repositories"] = []any{map[string]any{"id": "repo", "name": "Fixture", "path": source, "cwd": ".", "strategy": "worktree", "setup": []any{map[string]any{"command": "/bin/sh", "args": []any{"-c", "printf setup > setup.txt"}}}}}
	if _, err = configService.Replace(config.Revision, config.Value); err != nil {
		t.Fatal(err)
	}
	created, err := configService.CreateTask(map[string]any{"title": "Investigate", "repositoryId": "repo", "routing": map[string]any{"investigate": "codex", "plan": "codex"}})
	if err != nil {
		t.Fatal(err)
	}
	id := text(created["id"])
	coordinator, err := NewCoordinator(db, worker, []string{"-test.run=^TestStageWorker$", "--"}, map[string]string{"RELAY_STAGE_WORKER": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { coordinator.Close(); _ = db.Close() })
	return coordinator, db, id, source
}

func coordinatorTask(t *testing.T, db *store.Store, id string) map[string]any {
	t.Helper()
	raw, err := db.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err = json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func waitCoordinator(t *testing.T, c *Coordinator, id string) {
	t.Helper()
	c.mu.Lock()
	job := c.jobs[id]
	c.mu.Unlock()
	if job == nil {
		return
	}
	select {
	case <-job.done:
	case <-time.After(90 * time.Second):
		t.Fatal("workflow did not finish")
	}
}

func TestCoordinatorCreatesWorkspaceAndStopsAtPlanApproval(t *testing.T) {
	line := stageFinal()
	c, db, id, source := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+line+"'")
	result, err := c.Start(id)
	if err != nil || result["status"] != "queued" {
		t.Fatalf("start failed: %#v %v", result, err)
	}
	waitCoordinator(t, c, id)
	value := coordinatorTask(t, db, id)
	if value["status"] != "awaiting_plan" || value["chosenApproach"] != nil || len(array(value["attempts"])) != 2 {
		t.Fatalf("workflow did not stop at approval: %#v", value)
	}
	root := text(value["workspaceRoot"])
	if root == "" || root == source {
		t.Fatalf("workspace not isolated: %q", root)
	}
	if data, err := os.ReadFile(filepath.Join(root, "setup.txt")); err != nil || string(data) != "setup" {
		t.Fatal("configured setup did not run in workspace")
	}
	if data, err := os.ReadFile(filepath.Join(source, "file.txt")); err != nil || string(data) != "local changes\n" {
		t.Fatal("source checkout was modified")
	}
	if _, err := (Service{Store: db}).Approve(id, "a", "", Authorization{Human: true}); err != nil {
		t.Fatal(err)
	}
}

func TestCoordinatorRequiresApprovalAndBlocksUnsupervisedVerification(t *testing.T) {
	line := stageFinal()
	c, db, id, _ := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+line+"'")
	configService := task.ConfigurationService{Store: db}
	config, err := configService.Read()
	if err != nil {
		t.Fatal(err)
	}
	object(config.Value["harnesses"])["claude"] = object(config.Value["harnesses"])["codex"]
	if _, err = configService.Replace(config.Revision, config.Value); err != nil {
		t.Fatal(err)
	}
	if _, err = c.Start(id); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	if value := coordinatorTask(t, db, id); value["status"] != "awaiting_plan" {
		t.Fatalf("plan gate missing: %#v", value)
	}
	gate := coordinatorTask(t, db, id)
	planID := text(completedPlanAttempt(gate)["id"])
	gateRaw, _ := db.Get(id)
	revision := store.TaskRevision(gateRaw)
	if _, err = c.Approve(context.Background(), id, "missing", "", planID, revision); err == nil {
		t.Fatal("unknown approach accepted")
	}
	if value := coordinatorTask(t, db, id); value["status"] != "awaiting_plan" || len(array(value["approvals"])) != 0 {
		t.Fatal("invalid approval changed task")
	}
	if _, err = c.Approve(context.Background(), id, "a", "", planID, revision); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value := coordinatorTask(t, db, id)
	if value["status"] != "blocked" || value["stage"] != "verify" || value["verifiedFingerprint"] != nil || len(array(value["approvals"])) != 1 {
		t.Fatalf("unverified work advanced: %#v", value)
	}
	if !strings.Contains(text(value["error"]), "supervised check") {
		t.Fatalf("missing evidence not reported: %#v", value["error"])
	}
}

func TestCoordinatorRejectsUnsupportedAndUnavailableBeforeMutation(t *testing.T) {
	c, db, id, _ := coordinatorFixture(t, "exit 0")
	value := coordinatorTask(t, db, id)
	object(value["repository"])["strategy"] = "attach"
	body, _ := json.Marshal(value)
	if err := db.Save(body, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Start(id); err == nil || !strings.Contains(err.Error(), "attached") {
		t.Fatalf("unsupported strategy accepted: %v", err)
	}
	if value = coordinatorTask(t, db, id); value["status"] != "draft" || value["workspaceRoot"] != nil {
		t.Fatalf("preflight changed task: %#v", value)
	}
}

func TestCoordinatorStartupMarksInterruptedWorkWithoutDeletingWorkspace(t *testing.T) {
	line := stageFinal()
	c, db, id, _ := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+line+"'")
	c.Close()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "keep"), []byte("work"), 0600); err != nil {
		t.Fatal(err)
	}
	value := coordinatorTask(t, db, id)
	value["status"], value["workspaceRoot"], value["workspace"] = "running", dir, dir
	value["attempts"] = []any{map[string]any{"id": "attempt", "status": "running", "stage": "investigate"}}
	body, _ := json.Marshal(value)
	if err := db.Save(body, nil); err != nil {
		t.Fatal(err)
	}
	worker, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := NewCoordinator(db, worker, []string{"-test.run=^TestStageWorker$", "--"}, map[string]string{"RELAY_STAGE_WORKER": "1"})
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	value = coordinatorTask(t, db, id)
	if value["status"] != "interrupted" || object(array(value["attempts"])[0])["status"] != "interrupted" || recovered.Running() != 0 {
		t.Fatalf("unsafe restart recovery: %#v", value)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "keep")); err != nil || string(data) != "work" {
		t.Fatal("restart recovery removed work")
	}
}

func TestCoordinatorPauseStopsAgentAndKeepsWorkspace(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "started")
	c, db, id, source := coordinatorFixture(t, "touch \"$RELAY_MARKER\"\nsleep 30")
	c.env["RELAY_MARKER"] = marker
	if _, err := c.Start(id); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("agent did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := c.Pause(id); err != nil {
		t.Fatal(err)
	}
	value := coordinatorTask(t, db, id)
	if value["status"] != "paused" || text(value["workspaceRoot"]) == "" || c.Running() != 0 {
		t.Fatalf("pause did not preserve work: %#v", value)
	}
	if data, err := os.ReadFile(filepath.Join(source, "file.txt")); err != nil || string(data) != "local changes\n" {
		t.Fatal("pause changed the source checkout")
	}
	workspaceRoot := text(value["workspaceRoot"])
	if err := os.WriteFile(filepath.Join(workspaceRoot, "setup.txt"), []byte("preserve my changes"), 0600); err != nil {
		t.Fatal(err)
	}
	config, err := (task.ConfigurationService{Store: db}).Read()
	if err != nil {
		t.Fatal(err)
	}
	program := text(object(object(config.Value["harnesses"])["codex"])["command"])
	if err := os.WriteFile(program, []byte("#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '"+stageFinal()+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Resume(id); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value = coordinatorTask(t, db, id)
	if value["status"] != "awaiting_plan" || text(value["workspaceRoot"]) != workspaceRoot {
		t.Fatalf("resume did not reuse workspace: %#v", value)
	}
	if data, err := os.ReadFile(filepath.Join(workspaceRoot, "setup.txt")); err != nil || string(data) != "preserve my changes" {
		t.Fatal("resume reran setup or discarded work")
	}
}

func TestCoordinatorRefusesResumeWithIncompleteSetup(t *testing.T) {
	c, db, id, _ := coordinatorFixture(t, "exit 0")
	value := coordinatorTask(t, db, id)
	value["status"], value["stage"], value["workspaceRoot"], value["setupRunning"] = "blocked", "investigate", t.TempDir(), true
	body, _ := json.Marshal(value)
	if err := db.Save(body, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Resume(id); err == nil || !strings.Contains(err.Error(), "setup is incomplete") {
		t.Fatalf("uncertain setup was rerun: %v", err)
	}
	if value = coordinatorTask(t, db, id); value["status"] != "blocked" || value["setupRunning"] != true {
		t.Fatal("failed resume modified the task")
	}
}

func TestCoordinatorPreservesSpecificBlocker(t *testing.T) {
	c, db, id, _ := coordinatorFixture(t, "exit 0")
	value := coordinatorTask(t, db, id)
	value["status"], value["error"] = "blocked", "Repair limit reached. Inspect the failed check."
	body, _ := json.Marshal(value)
	if err := db.Save(body, nil); err != nil {
		t.Fatal(err)
	}
	c.finishError(id, &RepairLimitError{Message: "Repair limit reached. Inspect the failed check.", Cause: errors.New("generic check error")})
	value = coordinatorTask(t, db, id)
	if value["error"] != "Repair limit reached. Inspect the failed check." {
		t.Fatalf("specific blocker was overwritten: %#v", value["error"])
	}
}

func TestCoordinatorDoesNotRepeatInterruptedSetup(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "setup-started")
	c, db, id, _ := coordinatorFixture(t, "exit 0")
	c.env["RELAY_SETUP_MARKER"] = marker
	value := coordinatorTask(t, db, id)
	setup := []any{map[string]any{"command": "/bin/sh", "args": []any{"-c", `touch "$RELAY_SETUP_MARKER"; sleep 30`}}}
	object(value["repository"])["setup"] = setup
	object(object(array(value["repositories"])[0])["repository"])["setup"] = setup
	body, _ := json.Marshal(value)
	if err := db.Save(body, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Start(id); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("setup did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := c.Pause(id); err != nil {
		t.Fatal(err)
	}
	value = coordinatorTask(t, db, id)
	if value["status"] != "paused" || value["setupRunning"] != true || text(value["workspaceRoot"]) == "" {
		t.Fatalf("interrupted setup was not recorded: %#v", value)
	}
	if _, err := c.Resume(id); err == nil || !strings.Contains(err.Error(), "setup is incomplete") {
		t.Fatalf("uncertain setup was repeated: %v", err)
	}
}

func TestCoordinatorQueuesTasksSharingRepository(t *testing.T) {
	dir := t.TempDir()
	marker, release := filepath.Join(dir, "started"), filepath.Join(dir, "release")
	line := stageFinal()
	c, db, first, source := coordinatorFixture(t, "touch \"$RELAY_MARKER\"\nwhile [ ! -f \"$RELAY_RELEASE\" ]; do sleep 0.05; done\ncat >/dev/null\nprintf '%s\\n' '"+line+"'")
	c.env["RELAY_MARKER"], c.env["RELAY_RELEASE"] = marker, release
	created, err := (task.ConfigurationService{Store: db}).CreateTask(map[string]any{"title": "Second", "repositoryId": "repo", "routing": map[string]any{"investigate": "codex", "plan": "codex"}})
	if err != nil {
		t.Fatal(err)
	}
	second := text(created["id"])
	if _, err = c.Start(first); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err = os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first agent did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}
	runner := workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}
	common, err := runner.CommonDirectory(context.Background(), workspace.Profile{Path: source})
	if err != nil {
		t.Fatal(err)
	}
	if lease, err := c.repos.Acquire(second, []string{common}); !errors.Is(err, workspace.ErrWorkspaceBusy) {
		if lease != nil {
			lease.Release()
		}
		t.Fatalf("repository was not reserved: %v", err)
	}
	if _, err = c.Start(second); err != nil {
		t.Fatal(err)
	}
	if value := coordinatorTask(t, db, second); value["status"] != "queued" || text(value["workspaceRoot"]) != "" {
		t.Fatalf("second task did not queue: %#v", value)
	}
	if err = os.WriteFile(release, []byte("go"), 0600); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, first)
	waitCoordinator(t, c, second)
	one, two := coordinatorTask(t, db, first), coordinatorTask(t, db, second)
	if one["status"] != "awaiting_plan" || two["status"] != "awaiting_plan" || one["workspaceRoot"] == two["workspaceRoot"] {
		t.Fatalf("queued workflows did not finish in separate workspaces: %#v %#v", one, two)
	}
}

func TestCoordinatorResolvesBlockerWithoutRestartingTask(t *testing.T) {
	blocked := stageHandoff("blocked")
	c, db, id, _ := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+blocked+"'")
	if _, err := c.Start(id); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value := coordinatorTask(t, db, id)
	decision := object(value["blockerDecision"])
	if value["status"] != "blocked" || decision == nil {
		t.Fatalf("missing blocker: %#v", value)
	}
	raw, _ := db.Get(id)
	revision := store.TaskRevision(raw)
	decisionID := text(decision["id"])
	if _, err := c.Resolve(context.Background(), id, strings.Repeat("0", 64), decisionID, "retry", "a", ""); err == nil {
		t.Fatal("stale blocker was accepted")
	}
	if _, err := c.Resolve(context.Background(), id, revision, decisionID, "retry", "missing", ""); err == nil {
		t.Fatal("unknown debugger option was accepted")
	}
	config, err := (task.ConfigurationService{Store: db}).Read()
	if err != nil {
		t.Fatal(err)
	}
	program := text(object(object(config.Value["harnesses"])["codex"])["command"])
	if err = os.WriteFile(program, []byte("#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '"+stageFinal()+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err = c.Resolve(context.Background(), id, revision, decisionID, "retry", "a", "Try another diagnostic"); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value = coordinatorTask(t, db, id)
	if value["status"] != "awaiting_plan" || value["stage"] != "plan" || len(array(value["attempts"])) < 5 {
		t.Fatalf("targeted recovery did not continue: %#v", value)
	}
	messages := array(value["messages"])
	if len(messages) == 0 || !strings.Contains(text(object(messages[len(messages)-1])["text"]), "Try another diagnostic") || object(messages[len(messages)-1])["delivery"] != "delivered" {
		t.Fatal("human direction was lost")
	}
}

func TestCoordinatorCanPauseAtBlockerDecision(t *testing.T) {
	c, db, id, _ := coordinatorFixture(t, "exit 0")
	value := coordinatorTask(t, db, id)
	value["status"], value["stage"] = "blocked", "investigate"
	value["blockerDecision"] = map[string]any{"id": "decision", "summary": "Need input", "options": []any{}, "resolved": false}
	value["debugVerificationRequests"] = map[string]any{"fingerprint": "same", "count": 2}
	body, _ := json.Marshal(value)
	if err := db.Save(body, nil); err != nil {
		t.Fatal(err)
	}
	raw, _ := db.Get(id)
	result, err := c.Resolve(context.Background(), id, store.TaskRevision(raw), "decision", "pause", "", "")
	if err != nil || result["status"] != "paused" || object(result["blockerDecision"])["resolved"] != true || result["debugVerificationRequests"] != nil || c.Running() != 0 {
		t.Fatalf("blocker pause failed: %#v %v", result, err)
	}
}
