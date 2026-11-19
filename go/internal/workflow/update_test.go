//go:build darwin || linux

package workflow

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"relay.local/relay/internal/store"
	"relay.local/relay/internal/workspace"
)

func gitOutput(t *testing.T, root string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %s: %v", args, out, err)
	}
	return strings.TrimSpace(string(out))
}

// updateFixture is an accepted, published task whose pull request branch lives on a remote that
// has moved on: another change landed on main after the branch was pushed.
func updateFixture(t *testing.T, mainFile, mainContent string) (*Coordinator, *store.Store, string, string, string, string) {
	t.Helper()
	c, db, id, source, program := acceptedPublicationFixture(t)
	for key, item := range map[string]string{"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid", "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"} {
		c.env[key] = item
	}
	value := coordinatorTask(t, db, id)
	root, branch := text(value["workspaceRoot"]), text(value["branch"])
	remote := filepath.Join(t.TempDir(), "remote.git")
	gitFixture(t, source, "init", "-q", "--bare", remote)
	gitFixture(t, source, "remote", "set-url", "origin", remote)
	gitFixture(t, source, "push", "-q", "origin", "HEAD:refs/heads/main")
	gitFixture(t, root, "add", "-A")
	gitFixture(t, root, "commit", "-q", "-m", "feat: accepted change")
	gitFixture(t, root, "push", "-q", "origin", "HEAD:refs/heads/"+branch)
	other := filepath.Join(t.TempDir(), "other")
	gitFixture(t, source, "clone", "-q", "--branch", "main", remote, other)
	if err := os.WriteFile(filepath.Join(other, mainFile), []byte(mainContent), 0600); err != nil {
		t.Fatal(err)
	}
	gitFixture(t, other, "add", "-A")
	gitFixture(t, other, "commit", "-q", "-m", "feat: landed on main")
	gitFixture(t, other, "push", "-q", "origin", "main")
	head := gitOutput(t, root, "rev-parse", "HEAD")
	value = coordinatorTask(t, db, id)
	_ = updateWorkspace(value, "repo", func(entry map[string]any) {
		entry["workspaceHead"] = head
		entry["publication"] = map[string]any{"url": "https://code.example/team/repo/pull/7", "state": "open"}
		entry["delivery"] = map[string]any{"id": "d1", "status": "complete", "phase": "monitoring", "commit": head}
	})
	saved(t, db, value)
	return c, db, id, root, remote, program
}

func startUpdate(t *testing.T, c *Coordinator, db *store.Store, id, action string) {
	t.Helper()
	raw, _ := db.Get(id)
	if _, err := c.UpdateBranch(context.Background(), id, map[string]any{"taskRevision": store.TaskRevision(raw), "repositoryId": "repo", "action": action}); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
}

func TestUpdateBranchMergesCleanlyAndPushesWithoutAnAgent(t *testing.T) {
	c, db, id, root, remote, program := updateFixture(t, "other.txt", "from main\n")
	marker := filepath.Join(t.TempDir(), "agent-ran")
	if err := os.WriteFile(program, []byte("#!/bin/sh\ntouch "+marker+"\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	startUpdate(t, c, db, id, "start")
	value := coordinatorTask(t, db, id)
	record := object(value[branchUpdateKey])
	if record["status"] != "complete" || !strings.Contains(text(record["summary"]), "pushed") {
		t.Fatalf("update did not finish: %#v", record)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a clean merge started an agent")
	}
	branch := text(value["branch"])
	pushed := gitOutput(t, remote, "rev-parse", "refs/heads/"+branch)
	if pushed != gitOutput(t, root, "rev-parse", "HEAD") || pushed != text(record["commit"]) {
		t.Fatal("merged head was not pushed")
	}
	if gitOutput(t, remote, "merge-base", "--is-ancestor", "refs/heads/main", "refs/heads/"+branch) != "" {
		t.Fatal("unexpected output")
	}
	if text(value["baseCommit"]) != gitOutput(t, remote, "rev-parse", "refs/heads/main") || text(value["workspaceHead"]) != pushed || text(object(value["delivery"])["commit"]) != pushed {
		t.Fatalf("task did not record the new branch: %#v", value)
	}
	// The accepted task keeps working after the update: a follow-up still sees accepted work.
	if err := os.WriteFile(program, []byte("#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '"+followupFinal("complete")+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ := db.Get(id)
	if _, err := c.Followup(context.Background(), id, map[string]any{"taskRevision": store.TaskRevision(raw), "message": "Explain this change", "provider": "codex"}); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	if run := object(array(coordinatorTask(t, db, id)["deliveryRuns"])[0]); run["status"] != "complete" {
		t.Fatalf("follow-up failed after the update: %#v", run)
	}
	startUpdate(t, c, db, id, "start")
	if record = object(coordinatorTask(t, db, id)[branchUpdateKey]); record["status"] != "complete" || !strings.Contains(text(record["summary"]), "Already up to date") {
		t.Fatalf("second update was not a no-op: %#v", record)
	}
}

func TestUpdateBranchResolvesConflictsThenWaitsForAPersonToPush(t *testing.T) {
	c, db, id, root, remote, program := updateFixture(t, "file.txt", "main's version\n")
	script := "#!/bin/sh\ncat >/dev/null\nprintf 'approved change\\nmain'\"'\"'s version\\n' > file.txt\nprintf '%s\\n' '" + stageFinal() + "'\n"
	if err := os.WriteFile(program, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	branch := text(coordinatorTask(t, db, id)["branch"])
	before := gitOutput(t, remote, "rev-parse", "refs/heads/"+branch)
	startUpdate(t, c, db, id, "start")
	value := coordinatorTask(t, db, id)
	record := object(value[branchUpdateKey])
	if record["status"] != "review" || len(array(record["conflicts"])) != 1 {
		t.Fatalf("conflicts were not resolved for review: %#v", record)
	}
	if gitOutput(t, remote, "rev-parse", "refs/heads/"+branch) != before {
		t.Fatal("a resolution was pushed before review")
	}
	if data, _ := os.ReadFile(filepath.Join(root, "file.txt")); !strings.Contains(string(data), "main's version") {
		t.Fatal("resolution was not kept")
	}
	if gitOutput(t, root, "status", "--porcelain") != "" {
		t.Fatal("resolved merge was not committed")
	}
	startUpdate(t, c, db, id, "push")
	record = object(coordinatorTask(t, db, id)[branchUpdateKey])
	if record["status"] != "complete" || gitOutput(t, remote, "rev-parse", "refs/heads/"+branch) != text(record["commit"]) {
		t.Fatalf("reviewed resolution was not pushed: %#v", record)
	}
}

func TestUpdateBranchDiscardDropsAnUnpushedResolution(t *testing.T) {
	c, db, id, root, _, program := updateFixture(t, "file.txt", "main's version\n")
	if err := os.WriteFile(program, []byte("#!/bin/sh\ncat >/dev/null\nprintf 'resolved\\n' > file.txt\nprintf '%s\\n' '"+stageFinal()+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	head := gitOutput(t, root, "rev-parse", "HEAD")
	startUpdate(t, c, db, id, "start")
	startUpdate(t, c, db, id, "discard")
	record := object(coordinatorTask(t, db, id)[branchUpdateKey])
	if record["status"] != "discarded" || gitOutput(t, root, "rev-parse", "HEAD") != head {
		t.Fatalf("discard did not restore the branch: %#v", record)
	}
}

func TestUpdateBranchLeavesUnresolvedConflictsInPlace(t *testing.T) {
	c, db, id, root, _, program := updateFixture(t, "file.txt", "main's version\n")
	// The agent claims success but leaves the markers: Relay must not commit that.
	if err := os.WriteFile(program, []byte("#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '"+stageFinal()+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	head := gitOutput(t, root, "rev-parse", "HEAD")
	startUpdate(t, c, db, id, "start")
	record := object(coordinatorTask(t, db, id)[branchUpdateKey])
	if record["status"] != "failed" || !strings.Contains(text(record["summary"]), "conflict markers remain") {
		t.Fatalf("unresolved merge was accepted: %#v", record)
	}
	if gitOutput(t, root, "rev-parse", "HEAD") != head {
		t.Fatal("unresolved merge was committed")
	}
	// Starting again clears Relay's own half-finished merge instead of refusing.
	startUpdate(t, c, db, id, "discard")
	if record = object(coordinatorTask(t, db, id)[branchUpdateKey]); record["status"] != "discarded" {
		t.Fatalf("could not discard the half-finished merge: %#v", record)
	}
}

func TestUpdateBranchRefusesDirtyWorkAndRunningTasks(t *testing.T) {
	c, db, id, root, _, _ := updateFixture(t, "other.txt", "from main\n")
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("unsaved\n"), 0600); err != nil {
		t.Fatal(err)
	}
	startUpdate(t, c, db, id, "start")
	record := object(coordinatorTask(t, db, id)[branchUpdateKey])
	if record["status"] != "failed" || !strings.Contains(text(record["summary"]), "uncommitted") {
		t.Fatalf("dirty workspace was updated: %#v", record)
	}
	if data, _ := os.ReadFile(filepath.Join(root, "file.txt")); string(data) != "unsaved\n" {
		t.Fatal("dirty work was discarded")
	}
	value := coordinatorTask(t, db, id)
	value["status"] = "running"
	saved(t, db, value)
	raw, _ := db.Get(id)
	if _, err := c.UpdateBranch(context.Background(), id, map[string]any{"taskRevision": store.TaskRevision(raw), "repositoryId": "repo"}); err == nil {
		t.Fatal("updated a running task")
	}
	if _, err := c.UpdateBranch(context.Background(), id, map[string]any{"taskRevision": store.TaskRevision(raw), "repositoryId": "repo", "action": "push"}); err == nil {
		t.Fatal("pushed without a reviewed update")
	}
}

func TestEnvironmentalWaiverSendsVerifiedWorkToReview(t *testing.T) {
	c, db, id, _ := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+stageFinal()+"'")
	if _, err := c.Start(id); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value := coordinatorTask(t, db, id)
	inspector := workspace.Runner{WorkerExecutable: c.worker, WorkerArgs: c.args, Environment: c.env}
	snapshot, err := inspector.Snapshot(context.Background(), []workspace.Workspace{{RepositoryID: "repo", Root: text(value["workspaceRoot"])}})
	if err != nil {
		t.Fatal(err)
	}
	value["status"], value["stage"], value["error"] = "blocked", "investigate", "Verification failed"
	value["chosenApproach"] = map[string]any{"id": "a"}
	object(value["routing"])["review"] = "codex"
	value["approvals"] = []any{map[string]any{"type": "approach", "option": map[string]any{"id": "a"}}}
	value["attempts"] = append(array(value["attempts"]), map[string]any{"id": "verify-1", "stage": "verify", "status": "complete", "beforeFingerprint": snapshot.Combined, "afterFingerprint": snapshot.Combined})
	value["blockerDecision"] = map[string]any{"id": "verify-1", "stage": "verify", "summary": "Postgres is not running", "options": []any{}, "resolved": false}
	saved(t, db, value)
	resolve := func(note string) error {
		raw, _ := db.Get(id)
		_, err := c.Resolve(context.Background(), id, store.TaskRevision(raw), "verify-1", "environmental", "", note)
		return err
	}
	if resolve("It fails on main too because local Postgres is down") == nil {
		t.Fatal("waived a stage that is not verification")
	}
	value = coordinatorTask(t, db, id)
	value["stage"] = "verify"
	saved(t, db, value)
	if resolve("env") == nil {
		t.Fatal("waived without a reason")
	}
	if err := resolve("It fails on main too because local Postgres is down"); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value = coordinatorTask(t, db, id)
	if value["status"] != "awaiting_final" || value["verifiedFingerprint"] != snapshot.Combined || value["reviewedFingerprint"] != snapshot.Combined {
		t.Fatalf("waived verification did not reach final review: %v %v", value["status"], value["error"])
	}
	found := false
	for _, item := range array(value["approvals"]) {
		if approval := object(item); approval["type"] == "verification_waiver" && strings.Contains(text(approval["note"]), "Postgres") {
			found = true
		}
	}
	if !found {
		t.Fatal("waiver was not recorded")
	}
}

func TestOperatorReservationWaitsForNothingWithoutAWorkspace(t *testing.T) {
	c, db, id, _ := coordinatorFixture(t, "exit 0")
	release, err := c.ReserveWorkspace(context.Background(), id)
	if err != nil {
		t.Fatalf("a task without a workspace could not host an operator: %v", err)
	}
	release()
	value := coordinatorTask(t, db, id)
	value["status"] = "running"
	saved(t, db, value)
	if _, err = c.ReserveWorkspace(context.Background(), id); err == nil {
		t.Fatal("an operator was let into a running task")
	}
}

func TestCheckoutRemovedOutsideRelayIsRecordedAsCleanedUp(t *testing.T) {
	c, db, id, _ := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+stageFinal()+"'")
	if _, err := c.Start(id); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	value := coordinatorTask(t, db, id)
	root := text(value["workspaceRoot"])
	c.noteRemovedWorkspaces(value)
	if coordinatorTask(t, db, id)["workspaceCleanup"] != nil {
		t.Fatal("a checkout that exists was recorded as removed")
	}
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	c.noteRemovedWorkspaces(value)
	value = coordinatorTask(t, db, id)
	cleanup := object(value["workspaceCleanup"])
	if cleanup["status"] != "removed" || cleanup["root"] != root || value["workspaceRoot"] != nil {
		t.Fatalf("removed checkout was not recorded: %#v", cleanup)
	}
}
