package workflow

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
)

func demoFixture(t *testing.T) (*Coordinator, *store.Store, string) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	configService := task.ConfigurationService{Store: db}
	config, _ := configService.Read()
	for _, provider := range []string{"codex", "claude", "pi"} {
		agent := object(object(config.Value["harnesses"])[provider])
		agent["enabled"], agent["command"] = false, "/does-not-exist"
	}
	if _, err = configService.Replace(config.Revision, config.Value); err != nil {
		t.Fatal(err)
	}
	created, err := configService.CreateTask(map[string]any{"title": "Demo", "demo": true})
	if err != nil {
		t.Fatal(err)
	}
	worker, _ := os.Executable()
	c, err := NewCoordinator(db, worker, []string{"--invalid-worker-must-never-run"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close(); db.Close() })
	return c, db, text(created["id"])
}
func waitDemo(t *testing.T, c *Coordinator, id string) {
	t.Helper()
	c.mu.Lock()
	job := c.jobs[id]
	c.mu.Unlock()
	if job == nil {
		return
	}
	select {
	case <-job.done:
	case <-time.After(5 * time.Second):
		t.Fatal("demo stuck")
	}
}
func demoTask(t *testing.T, db *store.Store, id string) (map[string]any, string) {
	t.Helper()
	raw, err := db.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if json.Unmarshal(raw, &v) != nil {
		t.Fatal("bad task")
	}
	return v, store.TaskRevision(raw)
}
func TestDemoPreservesApprovalsWithoutRunningCommands(t *testing.T) {
	c, db, id := demoFixture(t)
	if _, err := c.Start(id); err != nil {
		t.Fatal(err)
	}
	waitDemo(t, c, id)
	v, rev := demoTask(t, db, id)
	if v["status"] != "awaiting_plan" || v["workspaceRoot"] != nil || v["chosenApproach"] != nil {
		t.Fatalf("demo gate: %#v", v)
	}
	if _, err := c.Accept(context.Background(), id, rev); err == nil {
		t.Fatal("accepted before implementation")
	}
	plan := completedPlanAttempt(v)
	if _, err := c.Approve(context.Background(), id, "focused", "", text(plan["id"]), rev); err != nil {
		t.Fatal(err)
	}
	waitDemo(t, c, id)
	v, rev = demoTask(t, db, id)
	if v["status"] != "awaiting_final" {
		t.Fatalf("final gate: %#v", v)
	}
	for _, item := range array(v["attempts"]) {
		a := object(item)
		if a["harness"] != "demo" || a["simulated"] != true || a["status"] != "complete" {
			t.Fatal("non-simulation attempt")
		}
	}
	if _, err := c.Accept(context.Background(), id, "stale"); err == nil {
		t.Fatal("stale acceptance")
	}
	accepted, err := c.Accept(context.Background(), id, rev)
	if err != nil || accepted["status"] != "completed" {
		t.Fatalf("accept: %#v %v", accepted, err)
	}
}
func TestDemoCancellationAndResume(t *testing.T) {
	c, db, id := demoFixture(t)
	if _, err := c.Start(id); err != nil {
		t.Fatal(err)
	}
	if err := c.Pause(id); err != nil {
		t.Fatal(err)
	}
	v, _ := demoTask(t, db, id)
	if v["status"] != "paused" {
		t.Fatalf("pause: %#v", v)
	}
	if _, err := c.Resume(id); err != nil {
		t.Fatal(err)
	}
	waitDemo(t, c, id)
	v, _ = demoTask(t, db, id)
	if v["status"] != "awaiting_plan" {
		t.Fatalf("resume: %#v", v)
	}
}
