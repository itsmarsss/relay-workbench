package workflow

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestBusyErrorsSayWhatHoldsTheTask(t *testing.T) {
	for kind, want := range map[string]string{
		"monitor":        "checking this task's pull request",
		"agent-terminal": "close the agent terminal",
		"manual":         "hand control back",
		"update":         "updating this branch",
		"publish":        "publishing",
		"followup":       "follow-up is running",
		"":               "pause it first",
	} {
		err := busyLocked(&coordinatorJob{kind: kind})
		if !errors.Is(err, ErrStageBusy) || !strings.Contains(err.Error(), want) {
			t.Fatalf("%q: %v", kind, err)
		}
	}
	c := &Coordinator{jobs: map[string]*coordinatorJob{}}
	if err := c.activeErrorLocked("t", map[string]any{"status": "manual"}); !strings.Contains(err.Error(), "hand control back") {
		t.Fatalf("manual without a job: %v", err)
	}
}

// A person's action stops a pull request check instead of failing; other jobs are left alone.
func TestYieldMonitorStopsOnlyPullRequestChecks(t *testing.T) {
	c := &Coordinator{jobs: map[string]*coordinatorJob{}}
	ctx, cancel := context.WithCancel(context.Background())
	monitor := &coordinatorJob{cancel: cancel, done: make(chan struct{}), kind: "monitor"}
	c.jobs["t"] = monitor
	go func() {
		<-ctx.Done()
		c.mu.Lock()
		delete(c.jobs, "t")
		close(monitor.done)
		c.mu.Unlock()
	}()
	started := time.Now()
	c.yieldMonitor("t")
	if c.jobs["t"] != nil || !monitor.preempted || time.Since(started) > 5*time.Second {
		t.Fatalf("monitor was not stopped: %#v", c.jobs["t"])
	}
	stage := &coordinatorJob{cancel: func() { t.Fatal("a stage must not be cancelled") }, done: make(chan struct{})}
	c.jobs["t"] = stage
	c.yieldMonitor("t")
	if c.jobs["t"] != stage {
		t.Fatal("stage job was removed")
	}
}

// A paused task's own pull request is still watched; only acting on its feedback needs acceptance.
func TestPausedTaskStillWatchesItsPublishedPullRequest(t *testing.T) {
	task := map[string]any{"status": "paused", "publication": map[string]any{"url": "https://code.example/pull/1"}}
	if url, accepted := watchedPullRequest(task, task); url != "https://code.example/pull/1" || accepted {
		t.Fatalf("got %q accepted=%v", url, accepted)
	}
	linked := map[string]any{"status": "paused", "pullRequestLink": map[string]any{"url": "https://code.example/pull/2"}}
	if url, accepted := watchedPullRequest(linked, linked); url != "https://code.example/pull/2" || accepted {
		t.Fatalf("got %q accepted=%v", url, accepted)
	}
}
