//go:build darwin || linux

package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"relay.local/relay/internal/storage"
	"relay.local/relay/internal/task"
)

func (a *actions) History(id string) (map[string]any, error) {
	return map[string]any{"taskId": id, "checkpoints": []any{"saved"}}, nil
}
func (a *actions) Diff(_ context.Context, id string) (map[string]any, error) {
	return map[string]any{"taskId": id, "repositories": []any{}}, nil
}
func (a *actions) Approve(context.Context, string, string, string, string, string) (map[string]any, error) {
	a.calls++
	return map[string]any{}, nil
}
func (a *actions) Accept(context.Context, string, string) (map[string]any, error) {
	a.calls++
	return map[string]any{}, nil
}
func (a *actions) Publish(context.Context, string, string, string) (map[string]any, error) {
	a.calls++
	return map[string]any{}, nil
}
func (a *actions) Resolve(context.Context, string, string, string, string, string, string) (map[string]any, error) {
	a.calls++
	return map[string]any{}, nil
}

func TestHistoryChangesAndLatestActivityRemainTaskScoped(t *testing.T) {
	s, db, _ := fixture(t)
	config := task.ConfigurationService{Store: db}
	value, err := config.CreateTask(map[string]any{"title": "Evidence", "demo": true})
	if err != nil {
		t.Fatal(err)
	}
	id := text(value["id"])
	for i := 0; i < 205; i++ {
		if _, err := db.Event(id, json.RawMessage(fmt.Sprintf(`{"summary":"event-%d"}`, i))); err != nil {
			t.Fatal(err)
		}
	}
	chat, err := s.Create("Side", id)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"read_task_history", "read_task_changes"} {
		result, err := s.call(context.Background(), chat, tool, map[string]any{"taskId": id})
		if err != nil || obj(result)["taskId"] != id {
			t.Fatalf("%s: %#v %v", tool, result, err)
		}
		if _, err := s.call(context.Background(), chat, tool, map[string]any{"taskId": "other"}); err == nil {
			t.Fatal("side scope escaped")
		}
	}
	result, err := s.call(context.Background(), chat, "read_task_activity", map[string]any{"taskId": id})
	if err != nil {
		t.Fatal(err)
	}
	// Newest first, so the latest event leads even on a long task.
	rows := result.([]any)
	if len(rows) != 80 || obj(rows[0])["summary"] != "event-204" {
		t.Fatalf("activity is stale: %d rows, first %#v", len(rows), rows[0])
	}
}

func TestGatedProposalsOnlyApplyAfterExactHumanDecision(t *testing.T) {
	s, db, a := fixture(t)
	config := task.ConfigurationService{Store: db}
	value, err := config.CreateTask(map[string]any{"title": "Proposal", "demo": true})
	if err != nil {
		t.Fatal(err)
	}
	chat, err := s.Create("Workspace", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"approve", "accept", "publish", "resolve"} {
		previous := a.calls
		proposal, err := s.propose(chat, "propose_task_change", map[string]any{"taskId": value["id"], "operation": operation, "body": map[string]any{}, "reason": "User requested this action"})
		if err != nil {
			t.Fatal(err)
		}
		if previous != a.calls {
			t.Fatal("proposal applied immediately")
		}
		decided, err := s.Decide(context.Background(), chat.ID, map[string]any{"proposalId": proposal.ID, "decision": "approve"})
		if err != nil || decided.Status != "applied" || a.calls != previous+1 {
			t.Fatalf("decision: %#v %v", decided, err)
		}
		if _, err := s.Decide(context.Background(), chat.ID, map[string]any{"proposalId": proposal.ID, "decision": "approve"}); err == nil {
			t.Fatal("proposal replayed")
		}
	}
	proposal, err := s.propose(chat, "propose_task_change", map[string]any{"taskId": value["id"], "operation": "edit", "body": map[string]any{"title": "Updated"}, "reason": "Rename"})
	if err != nil || proposal.Before["title"] != "Proposal" {
		t.Fatal("missing prior field values")
	}
}

func TestStorageProposalRequiresApprovalAndFreshPolicy(t *testing.T) {
	s, db, _ := fixture(t)
	chat, err := s.Create("Settings", "")
	if err != nil {
		t.Fatal(err)
	}
	service := storage.PolicyService{Store: db}
	before, err := service.Read()
	if err != nil {
		t.Fatal(err)
	}
	proposed := before.Policy
	proposed.WarningPercent++
	proposal, err := s.call(context.Background(), chat, "propose_storage_change", map[string]any{"policy": asMap(t, proposed), "reason": "Adjust disk warning"})
	if err != nil {
		t.Fatal(err)
	}
	after, err := service.Read()
	if err != nil || after.Revision != before.Revision {
		t.Fatal("policy changed without approval")
	}
	id := proposal.(Proposal).ID
	decided, err := s.Decide(context.Background(), chat.ID, map[string]any{"proposalId": id, "decision": "approve"})
	if err != nil || decided.Status != "applied" {
		t.Fatalf("storage decision: %#v %v", decided, err)
	}
	current, _ := service.Read()
	if current.Policy.WarningPercent != proposed.WarningPercent {
		t.Fatal("approved policy missing")
	}
	proposal, err = s.call(context.Background(), chat, "propose_storage_change", map[string]any{"policy": asMap(t, before.Policy), "reason": "Another adjustment"})
	if err != nil {
		t.Fatal(err)
	}
	changed := current.Policy
	changed.WarningPercent++
	if _, err := service.Replace(current.Revision, changed); err != nil {
		t.Fatal(err)
	}
	decided, err = s.Decide(context.Background(), chat.ID, map[string]any{"proposalId": proposal.(Proposal).ID, "decision": "approve"})
	if err != nil || decided.Status != "failed" {
		t.Fatal("stale policy applied")
	}
}
func asMap(t *testing.T, value any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}
