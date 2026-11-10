package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"relay.local/relay/internal/harness"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/workspace"
)

// Demo runs only in-memory simulations. No repository, provider or remote
// command can run, including configured setup and verification commands.
func (c *Coordinator) enqueueDemoLocked(id string, resume, automatic bool) (map[string]any, error) {
	value, err := c.update(id, func(value map[string]any) error {
		if value["demo"] != true {
			return errors.New("task is not simulated")
		}
		status := text(value["status"])
		gate := automatic && (status == "awaiting_plan" || status == "awaiting_final")
		if !resume && status != "draft" {
			return errors.New("start requires a draft task")
		}
		if resume && !gate && status != "paused" && status != "interrupted" && status != "blocked" {
			return errors.New("demo cannot resume in its current state")
		}
		stage := text(value["stage"])
		if stage != "triage" && stage != "investigate" && stage != "plan" && stage != "implement" && stage != "verify" && stage != "review" {
			return errors.New("invalid demo stage")
		}
		if (stage == "implement" || stage == "verify" || stage == "review") && !harness.HasApprovedApproach(value) {
			return errors.New("approve a demo approach before implementation")
		}
		if !gate {
			value["status"], value["error"] = "queued", nil
		}
		return nil
	}, map[string]any{"type": "queued", "source": "relay", "summary": "Simulated workflow queued. No commands will execute."})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	job := &coordinatorJob{cancel: cancel, done: make(chan struct{})}
	c.jobs[id] = job
	go c.runDemo(ctx, id, job)
	return value, nil
}
func (c *Coordinator) startDemoLocked(id string) {
	ctx, cancel := context.WithCancel(context.Background())
	job := &coordinatorJob{cancel: cancel, done: make(chan struct{})}
	c.jobs[id] = job
	go c.runDemo(ctx, id, job)
}
func demoHandoff(stage string, value map[string]any) map[string]any {
	h := map[string]any{"summary": "Simulated " + stage + " completed.", "details": "This demo illustrates Relay's workflow. No source was inspected or changed, no agent ran, and no checks or remote operations executed.", "files": []any{}, "evidence": []any{"Simulated result; not evidence about any repository."}, "risks": []any{}, "options": []any{}, "findings": []any{}, "memorySuggestions": []any{}, "verdict": "complete", "routing": value["routing"]}
	if stage == "plan" {
		h["options"] = []any{map[string]any{"id": "focused", "title": "Focused repair", "description": "Simulate the smallest complete change and a targeted regression check.", "tradeoffs": "A narrow change limits scope; unrelated cleanup is deferred."}, map[string]any{"id": "redesign", "title": "Broader redesign", "description": "Simulate a revised abstraction and wider tests.", "tradeoffs": "More flexibility, with a larger review and migration surface."}}
		h["recommendedOptionId"], h["recommendationReason"] = "focused", "The focused option is proportional to this demo."
	}
	return h
}
func (c *Coordinator) runDemo(ctx context.Context, id string, job *coordinatorJob) {
	defer func() {
		if ctx.Err() != nil {
			_, _ = c.update(id, func(value map[string]any) error {
				for _, item := range array(value["attempts"]) {
					a := object(item)
					if a["status"] == "running" {
						a["status"], a["finishedAt"] = "interrupted", timestamp(time.Now())
					}
				}
				return nil
			}, map[string]any{"type": "interrupted", "source": "relay", "summary": "Demo stopped; simulated activity is retained."})
			c.finishError(id, ctx.Err())
		}
		job.cancel()
		c.mu.Lock()
		delete(c.jobs, id)
		c.notifyLocked()
		close(job.done)
		c.mu.Unlock()
	}()
	for {
		if ctx.Err() != nil {
			return
		}
		raw, err := c.store.Get(id)
		var value map[string]any
		if err != nil || json.Unmarshal(raw, &value) != nil || value["demo"] != true {
			return
		}
		if value["status"] == "awaiting_plan" || value["status"] == "awaiting_final" {
			delegation, exists, e := c.store.GetMeta("automation:" + id)
			var auth map[string]any
			if e != nil || !exists || json.Unmarshal([]byte(delegation), &auth) != nil || auth["enabled"] != true {
				return
			}
			service := Service{Store: c.store}
			authorization := Authorization{AutomationID: text(auth["authorizationId"]), Scope: text(auth["scope"])}
			if value["status"] == "awaiting_plan" {
				_, err = service.Approve(id, "focused", "Auto selected the simulated recommendation.", authorization)
			} else {
				_, err = service.AcceptDemo(id, authorization)
			}
			if err != nil {
				c.finishError(id, err)
				return
			}
			continue
		}
		if value["status"] != "queued" {
			return
		}
		stage := text(value["stage"])
		attemptID, err := stageUUID()
		if err != nil {
			c.finishError(id, err)
			return
		}
		_, err = c.update(id, func(v map[string]any) error {
			if v["demo"] != true || v["status"] != "queued" || v["stage"] != stage {
				return store.ErrTaskChanged
			}
			a := map[string]any{"id": attemptID, "stage": stage, "status": "running", "harness": "demo", "simulated": true, "startedAt": timestamp(time.Now())}
			if attempts := array(v["attempts"]); len(attempts) > 0 {
				a["parentAttemptId"], a["relation"] = object(attempts[len(attempts)-1])["id"], "Simulated handoff"
			}
			v["attempts"] = append(array(v["attempts"]), a)
			v["status"] = "running"
			return nil
		}, map[string]any{"type": "started", "source": "relay", "stage": stage, "harness": "demo", "attemptId": attemptID, "summary": "Simulating " + stage + "."})
		if err != nil {
			c.finishError(id, err)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(150 * time.Millisecond):
		}
		_, err = c.update(id, func(v map[string]any) error {
			if v["demo"] != true || v["status"] != "running" || v["stage"] != stage {
				return store.ErrTaskChanged
			}
			attempts := array(v["attempts"])
			if len(attempts) == 0 {
				return errors.New("demo attempt missing")
			}
			a := object(attempts[len(attempts)-1])
			if a["id"] != attemptID {
				return store.ErrTaskChanged
			}
			h := demoHandoff(stage, v)
			a["status"], a["finishedAt"], a["handoff"] = "complete", timestamp(time.Now()), h
			for _, item := range array(v["messages"]) {
				m := object(item)
				if m["delivery"] == "pending" {
					m["delivery"], m["attemptId"] = "delivered", attemptID
				}
			}
			fingerprint := workspace.FingerprintSnapshot{Combined: "simulated:" + id}
			return advanceStage(v, stage, h, 1, 0, workspace.GuardResult{Before: fingerprint, After: fingerprint}, map[string]bool{"codex": true, "claude": true, "pi": true}, 3)
		}, map[string]any{"type": "handoff", "stage": stage, "harness": "demo", "attemptId": attemptID, "summary": "Simulated " + stage + " completed."})
		if err != nil {
			c.finishError(id, err)
			return
		}
	}
}
