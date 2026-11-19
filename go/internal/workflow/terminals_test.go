package workflow

import (
	"context"
	"strings"
	"testing"

	"relay.local/relay/internal/store"
)

func TestManualBriefCarriesTaskContextAsBoundedText(t *testing.T) {
	if manualBrief(map[string]any{}) != "" {
		t.Fatal("a task without a title produced a brief")
	}
	task := map[string]any{
		"id":            "550e8400-e29b-41d4-a716-446655440000",
		"title":         "Fix the widget; $(touch SHOULD_NOT_RUN)",
		"ticket":        "https://code.example/org/repo/issues/7",
		"branch":        "relay/550e8400",
		"stage":         "verify",
		"description":   strings.Repeat("d", 7000) + "\x00",
		"latestSummary": "Checks pass.",
		"error":         "One reviewer question is open.",
		"chosenApproach": map[string]any{
			"id": "a", "title": "Unapproved idea", "description": "Should not appear.",
		},
	}
	brief := manualBrief(task)
	for _, want := range []string{"wait for my instructions", "Never credit yourself", "Task: Fix the widget; $(touch SHOULD_NOT_RUN)", "Task ID: 550e8400", "Ticket: https://code.example/org/repo/issues/7", "Branch: relay/550e8400", "Workflow stage: verify", "[truncated]", "Latest update: Checks pass.", "Open problem: One reviewer question is open."} {
		if !strings.Contains(brief, want) {
			t.Fatalf("brief is missing %q", want)
		}
	}
	if strings.ContainsRune(brief, 0) || strings.Contains(brief, "Unapproved idea") || len(brief) > 16000 {
		t.Fatalf("brief is unsafe or unbounded: %d bytes", len(brief))
	}
}

func TestAgentTerminalKeepsTheTaskAndHoldsOffStages(t *testing.T) {
	c, db, id, _ := coordinatorFixture(t, "cat >/dev/null\nprintf '%s\\n' '"+stageFinal()+"'")
	c.terminals = true
	if _, err := c.Start(id); err != nil {
		t.Fatal(err)
	}
	waitCoordinator(t, c, id)
	before := coordinatorTask(t, db, id)
	// The session itself needs Relay's own binary; here an open terminal is its job and record.
	job := &coordinatorJob{cancel: func() {}, done: make(chan struct{}), kind: "agent-terminal"}
	c.mu.Lock()
	c.jobs[id] = job
	c.mu.Unlock()
	t.Cleanup(func() {
		c.mu.Lock()
		if c.jobs[id] == job {
			delete(c.jobs, id)
		}
		c.mu.Unlock()
	})
	if err := db.SetMeta("terminal:"+id, `{"active":true,"mode":"agent","repositoryId":"repo","terminal":{"session":"relay-1","interactive":true}}`); err != nil {
		t.Fatal(err)
	}
	if !c.writableTerminal(id, before) {
		t.Fatal("a person cannot type into their own agent terminal")
	}
	if _, err := c.Resume(id); err == nil || !strings.Contains(err.Error(), "agent terminal") {
		t.Fatalf("a stage started under an open agent terminal: %v", err)
	}
	raw, _ := db.Get(id)
	if _, err := c.Terminal(context.Background(), id, "agent", map[string]any{"taskRevision": store.TaskRevision(raw)}); err != nil {
		t.Fatalf("reopening an open agent terminal failed: %v", err)
	}
	if after := coordinatorTask(t, db, id); after["status"] != before["status"] || after["stage"] != before["stage"] {
		t.Fatal("an agent terminal changed the task")
	}
	c.mu.Lock()
	delete(c.jobs, id)
	c.mu.Unlock()
	if c.writableTerminal(id, before) {
		t.Fatal("a closed agent terminal still accepts typing")
	}
	if result, _ := c.Terminal(context.Background(), id, "snapshot", map[string]any{}); result.(map[string]any)["available"] == true {
		t.Fatal("a closed agent terminal is reported open")
	}
	value := coordinatorTask(t, db, id)
	value["status"] = "running"
	saved(t, db, value)
	raw, _ = db.Get(id)
	if _, err := c.Terminal(context.Background(), id, "agent", map[string]any{"taskRevision": store.TaskRevision(raw)}); err == nil {
		t.Fatal("opened an agent terminal on a running task")
	}
}
