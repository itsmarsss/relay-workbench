//go:build darwin || linux

package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"relay.local/relay/internal/verification"
	"relay.local/relay/internal/workspace"
)

func TestVerificationFakeAgent(t *testing.T) {
	if os.Getenv("RELAY_VERIFY_FAKE_AGENT") != "1" {
		return
	}
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		os.Exit(3)
	}
	last := strings.LastIndex(string(input), "\n")
	var helper struct {
		Executable string   `json:"executable"`
		Prefix     []string `json:"prefix"`
	}
	if last < 0 || json.Unmarshal(input[last+1:], &helper) != nil {
		os.Exit(4)
	}
	root := os.Getenv("RELAY_VERIFY_ROOT")
	command, args, code := "/bin/echo", []string{"verified"}, 0
	if os.Getenv("RELAY_VERIFY_FAIL") == "1" {
		command, args, code = "/bin/sh", []string{"-c", "exit 7"}, 7
	}
	if os.Getenv("RELAY_VERIFY_SKIP") != "1" {
		argv := append(append([]string{}, helper.Prefix...), "--repository", "a", "--cwd", root, "--", command)
		argv = append(argv, args...)
		cmd := exec.Command(helper.Executable, argv...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		err := cmd.Run()
		var exit *exec.ExitError
		if code == 0 && err != nil || code != 0 && (!errors.As(err, &exit) || exit.ExitCode() != code) {
			os.Exit(5)
		}
	}
	if os.Getenv("RELAY_VERIFY_LIE") == "1" {
		args = []string{"different"}
	}
	check := map[string]any{"repositoryId": "a", "cwd": root, "command": command, "args": args, "code": code, "summary": "Focused check"}
	report := map[string]any{"checks": []any{check}, "requirements": []any{map[string]any{"repositoryId": "a", "source": "repository guidance", "requirement": "Verify the changed surface", "checkIndices": []any{0}}}, "reuse": []any{}}
	handoff := map[string]any{"summary": "Verification complete", "details": "Check evidence recorded", "files": []any{}, "evidence": []any{}, "risks": []any{}, "options": []any{}, "findings": []any{}, "verdict": "complete", "verification": report}
	encoded, _ := json.Marshal(handoff)
	line, _ := json.Marshal(map[string]any{"type": "item.completed", "item": map[string]any{"type": "agent_message", "text": string(encoded)}})
	fmt.Println(string(line))
	os.Exit(0)
}

func verificationFixture(t *testing.T, setting string) (*StageRunner, StageOptions, string) {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "relay-go")
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", binary, "../../cmd/relay-go")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build helper: %s %v", output, err)
	}
	script := `exec "$RELAY_VERIFY_AGENT_BINARY" -test.run='^TestVerificationFakeAgent$' --`
	runner, options, db := stageFixture(t, "verify", 1, script)
	value := readStageTask(t, db)
	value["chosenApproach"] = map[string]any{"id": "a"}
	value["approvals"] = []any{map[string]any{"type": "approach", "option": map[string]any{"id": "a"}}}
	body, _ := json.Marshal(value)
	if err := db.Save(body, nil); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.EvalSymlinks(text(value["workspaceRoot"]))
	if err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	options.WorkerExecutable, options.WorkerArgs = binary, []string{"--internal-worker"}
	options.Environment["RELAY_VERIFY_FAKE_AGENT"] = "1"
	options.Environment["RELAY_VERIFY_AGENT_BINARY"] = self
	options.Environment["RELAY_VERIFY_ROOT"] = root
	if setting != "" {
		options.Environment[setting] = "1"
	}
	options.Timeout = 20 * time.Second
	return runner, options, root
}

func TestVerificationStageRunsRealSupervisedCheck(t *testing.T) {
	runner, options, _ := verificationFixture(t, "")
	if err := runner.Run(context.Background(), stageTaskID, options); err != nil {
		t.Fatal(err)
	}
	value := readStageTask(t, runner.Store)
	if value["status"] != "queued" || value["stage"] != "review" || value["verifiedFingerprint"] != "snapshot" {
		t.Fatalf("verification did not advance: %#v", value)
	}
	attempt := object(array(value["attempts"])[0])
	evidence := array(attempt["verificationEvidence"])
	if len(evidence) != 1 || object(evidence[0])["status"] != "complete" || object(evidence[0])["code"] != float64(0) {
		t.Fatalf("supervised evidence missing: %#v", evidence)
	}
}

func TestVerificationStageRejectsInventedAndMismatchedEvidence(t *testing.T) {
	for _, setting := range []string{"RELAY_VERIFY_SKIP", "RELAY_VERIFY_LIE"} {
		t.Run(setting, func(t *testing.T) {
			runner, options, _ := verificationFixture(t, setting)
			if err := runner.Run(context.Background(), stageTaskID, options); err == nil {
				t.Fatal("fabricated evidence was accepted")
			}
			value := readStageTask(t, runner.Store)
			if value["status"] != "blocked" || value["verifiedFingerprint"] != nil {
				t.Fatal("fabricated evidence advanced the workflow")
			}
		})
	}
}

func TestVerificationStagePreservesFailedCheck(t *testing.T) {
	runner, options, _ := verificationFixture(t, "RELAY_VERIFY_FAIL")
	err := runner.Run(context.Background(), stageTaskID, options)
	var failure *verification.ValidationError
	if !errors.As(err, &failure) || failure.Code != "VERIFICATION_CHECK_FAILED" {
		t.Fatalf("failed check not classified: %v", err)
	}
	value := readStageTask(t, runner.Store)
	attempt := object(array(value["attempts"])[0])
	if value["status"] != "blocked" || object(array(attempt["verificationEvidence"])[0])["code"] != float64(7) {
		t.Fatalf("failed evidence lost: %#v", value)
	}
}

func TestVerificationFailureQueuesBoundedImplementationRepair(t *testing.T) {
	runner, options, _ := verificationFixture(t, "RELAY_VERIFY_FAIL")
	options.MaxRepairRounds = 1
	if err := runner.Run(context.Background(), stageTaskID, options); err != nil {
		t.Fatalf("repair was not queued: %v", err)
	}
	value := readStageTask(t, runner.Store)
	attempt := object(array(value["attempts"])[0])
	if value["status"] != "queued" || value["stage"] != "implement" || value["round"] != float64(1) || attempt["status"] != "failed" {
		t.Fatalf("failed check did not route to repair: %#v", value)
	}
	if object(array(attempt["verificationEvidence"])[0])["code"] != float64(7) {
		t.Fatal("repair lost failed check evidence")
	}
}

type changingStageInspector struct{ calls int }

func (i *changingStageInspector) Snapshot(_ context.Context, entries []workspace.Workspace) (workspace.FingerprintSnapshot, error) {
	i.calls++
	value := "snapshot"
	if i.calls > 2 {
		value = "changed"
	}
	return workspace.FingerprintSnapshot{Combined: value, Repositories: map[string]string{entries[0].RepositoryID: value}}, nil
}

func TestVerificationStageRejectsWorkspaceMutation(t *testing.T) {
	runner, options, _ := verificationFixture(t, "")
	options.Inspector = &changingStageInspector{}
	if err := runner.Run(context.Background(), stageTaskID, options); !errors.Is(err, workspace.ErrReadOnlyChanged) {
		t.Fatalf("workspace mutation was accepted: %v", err)
	}
	value := readStageTask(t, runner.Store)
	if value["status"] != "blocked" || value["verifiedFingerprint"] != nil {
		t.Fatal("changed workspace passed verification")
	}
}
