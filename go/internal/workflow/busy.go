package workflow

import "time"

// busyError says what is holding a task, so the person knows what to do instead of retrying.
// It still matches ErrStageBusy for callers that only need to know the task is taken.
type busyError struct{ message string }

func (e busyError) Error() string        { return e.message }
func (e busyError) Is(target error) bool { return target == ErrStageBusy }

// busyLocked describes the job holding a task. Callers hold c.mu.
func busyLocked(job *coordinatorJob) error {
	switch job.kind {
	case "monitor":
		return busyError{"Relay is checking this task's pull request; try again in a few seconds"}
	case "agent-terminal":
		return busyError{"close the agent terminal on this task first; Relay runs nothing on it while it is open"}
	case "setup-terminal":
		return busyError{"a setup terminal is open on this task; close it first"}
	case "manual":
		return busyError{"you have control of this task in a terminal; hand control back first"}
	case "update":
		return busyError{"Relay is updating this branch; wait for it to finish"}
	case "publish":
		return busyError{"Relay is publishing this task; wait for it to finish"}
	case "followup":
		return busyError{"a follow-up is running on this task; wait for it or pause it first"}
	case "cleanup":
		return busyError{"Relay is cleaning up this task's workspace; wait for it to finish"}
	}
	return busyError{"Relay is running a stage on this task; pause it first, or wait for this step to finish"}
}

// yieldMonitor stops a pull request check that is holding the task, so an action the person asked
// for goes ahead instead of failing. The check is only an observation; it runs again on its next poll.
func (c *Coordinator) yieldMonitor(id string) {
	c.mu.Lock()
	job := c.jobs[id]
	if job == nil || job.kind != "monitor" {
		c.mu.Unlock()
		return
	}
	job.preempted = true
	job.cancel()
	c.mu.Unlock()
	select {
	case <-job.done:
	case <-time.After(15 * time.Second):
	}
}

// activeErrorLocked explains why a task counts as active: the job holding it, or a status that
// outlived its job (for example manual control after a restart). Callers hold c.mu.
func (c *Coordinator) activeErrorLocked(id string, value map[string]any) error {
	if job := c.jobs[id]; job != nil {
		return busyLocked(job)
	}
	switch value["status"] {
	case "manual":
		return busyLocked(&coordinatorJob{kind: "manual"})
	case "queued":
		return busyError{"this task is queued to run; pause it first"}
	}
	return busyLocked(&coordinatorJob{})
}
