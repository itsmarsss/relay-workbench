package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"relay.local/relay/internal/harness"
	"relay.local/relay/internal/verification"
	"relay.local/relay/internal/workspace"
)

type verificationSession struct {
	runner      *verification.Runner
	fingerprint string
	entries     []any
}

func startVerification(ctx context.Context, task map[string]any, id string, entries []stageWorkspace, lease *workspace.Lease, options StageOptions, event harness.EventSink) (*verificationSession, error) {
	if !harness.HasApprovedApproach(task) {
		return nil, errors.New("verification requires an approved approach")
	}
	if options.Inspector == nil || options.Admission == nil {
		return nil, errors.New("verification needs workspace inspection and storage admission")
	}
	roots := make([]string, 0, len(entries))
	workspaces := make([]workspace.Workspace, 0, len(entries))
	repositories := make([]verification.Repository, 0, len(entries))
	for _, entry := range entries {
		roots = append(roots, entry.root)
		workspaces = append(workspaces, workspace.Workspace{RepositoryID: entry.id, Root: entry.root})
		repositories = append(repositories, verification.Repository{ID: entry.id, Root: entry.root, Cwd: entry.cwd, BaseCommit: entry.baseCommit})
	}
	var fingerprint string
	err := lease.Protect(id, roots, func(revalidate func() error) error {
		if err := options.Admission.Check(ctx, roots); err != nil {
			return err
		}
		snapshot, err := options.Inspector.Snapshot(ctx, workspaces)
		if err != nil {
			return err
		}
		if snapshot.Combined == "" || len(snapshot.Repositories) != len(entries) {
			return errors.New("verification workspace inspection is incomplete")
		}
		for _, entry := range entries {
			if snapshot.Repositories[entry.id] == "" {
				return errors.New("verification workspace inspection is incomplete")
			}
		}
		fingerprint = snapshot.Combined
		return revalidate()
	})
	if err != nil {
		return nil, err
	}
	runner, err := verification.StartRunner(ctx, verification.RunnerOptions{WorkerExecutable: options.WorkerExecutable, WorkerArgs: options.WorkerArgs, Environment: options.Environment, Repositories: repositories, SourceFingerprint: fingerprint, Timeout: options.Timeout, Gate: options.CheckGate, OnEvent: event})
	if err != nil {
		return nil, err
	}
	profiles := array(task["repositories"])
	if len(profiles) <= 1 {
		profiles = []any{task}
	}
	return &verificationSession{runner: runner, fingerprint: fingerprint, entries: profiles}, nil
}

func (s *verificationSession) prompt(worker string, entries []stageWorkspace) (string, error) {
	workspaces := make([]map[string]string, 0, len(entries))
	for _, entry := range entries {
		workspaces = append(workspaces, map[string]string{"repositoryId": entry.id, "root": entry.root, "cwd": entry.cwd})
	}
	command := map[string]any{
		"executable": worker,
		"prefix":     []string{"--internal-check", "--socket", s.runner.Socket(), "--token", s.runner.Token()},
		"arguments":  "--repository <repositoryId> --cwd <absolute-directory> -- <command> [arguments...]",
		"workspaces": workspaces,
	}
	encoded, err := json.Marshal(command)
	if err != nil {
		return "", err
	}
	return "\nSUPERVISED VERIFICATION:\nUse this helper for every verification check. Choose checks appropriate to the touched surfaces and repository guidance; do not infer whole-repository coverage. Each reported check must exactly match its supervised repository, cwd, command, argument list and exit code. Include requirements and their check indices in the structured verification report. Diagnostic checks may be marked --purpose diagnostic and do not satisfy verification requirements. Never claim a check ran unless the helper completed it.\n" + string(encoded), nil
}

func (s *verificationSession) finish(result harness.RunResult, runErr error) ([]any, error) {
	closeErr := s.runner.Close()
	records := s.runner.Records()
	encoded, err := json.Marshal(records)
	if err != nil {
		return nil, errors.Join(runErr, closeErr, err)
	}
	var journal []any
	if err = json.Unmarshal(encoded, &journal); err != nil {
		return nil, errors.Join(runErr, closeErr, err)
	}
	if runErr != nil || closeErr != nil {
		return journal, errors.Join(runErr, closeErr)
	}
	if result.Guard.Before.Combined != s.fingerprint || result.Guard.After.Combined != s.fingerprint {
		return journal, errors.New("workspace changed during verification; inspect the retained work")
	}
	var handoff map[string]any
	if json.Unmarshal(result.Handoff, &handoff) != nil || handoff == nil {
		return journal, errors.New("verification did not return a structured handoff")
	}
	if text(handoff["verdict"]) != "complete" {
		return journal, nil
	}
	latest := map[string]verification.CheckRecord{}
	for _, record := range records {
		if record.Purpose == "diagnostic" {
			continue
		}
		key, err := json.Marshal([]any{record.RepositoryID, record.Cwd, record.Command, record.Args})
		if err != nil {
			return journal, err
		}
		latest[string(key)] = record
	}
	if len(latest) == 0 {
		return journal, errors.New("verification needs a completed supervised check")
	}
	for _, record := range latest {
		if record.Status != "complete" || record.Code == nil {
			return journal, errors.New("a supervised verification check did not complete; inspect it before continuing")
		}
		if *record.Code != 0 {
			return journal, &verification.ValidationError{Code: "VERIFICATION_CHECK_FAILED", Message: fmt.Sprintf("A supervised check failed: %s exited %d", record.Command, *record.Code)}
		}
	}
	if err = verification.Validate(handoff, s.entries, true, map[string]any{"journal": journal, "sourceFingerprint": s.fingerprint}); err != nil {
		return journal, err
	}
	return journal, nil
}
