package workflow

import (
	"strings"
	"testing"
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
	for _, want := range []string{"wait for my instructions", "Task: Fix the widget; $(touch SHOULD_NOT_RUN)", "Task ID: 550e8400", "Ticket: https://code.example/org/repo/issues/7", "Branch: relay/550e8400", "stage when I took over: verify", "[truncated]", "Latest update: Checks pass.", "Open problem: One reviewer question is open."} {
		if !strings.Contains(brief, want) {
			t.Fatalf("brief is missing %q", want)
		}
	}
	if strings.ContainsRune(brief, 0) || strings.Contains(brief, "Unapproved idea") || len(brief) > 16000 {
		t.Fatalf("brief is unsafe or unbounded: %d bytes", len(brief))
	}
}
