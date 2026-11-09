// Package process supervises non-interactive commands. It is not connected to
// the workflow engine or the terminal backend yet.
package process

import (
	"context"
	"errors"
	"fmt"
	"relay.local/relay/internal/runtimebudget"
	"sync/atomic"
	"time"
)

var (
	ErrCancelled          = errors.New("execution cancelled")
	ErrBudgetExhausted    = errors.New("execution budget exhausted")
	ErrTimeout            = errors.New("execution timed out")
	ErrOutputLimit        = errors.New("execution exceeded output limit")
	ErrOutputBackpressure = errors.New("output consumer cannot keep up")
	ErrCallbackBlocked    = errors.New("output consumer did not stop")
	ErrCleanup            = errors.New("could not verify process cleanup")
	ErrUnsupported        = errors.New("process supervision is not supported on this platform")
)

type ProgressPolicy struct {
	MaxTimeout             time.Duration
	ProgressWindow         time.Duration
	LastProgressUnixMillis *atomic.Int64
	Updates                chan<- runtimebudget.Snapshot
}
type BudgetError struct{ Snapshot runtimebudget.Snapshot }

func (e *BudgetError) Error() string {
	return fmt.Sprintf("%s; completed checks are preserved", ErrBudgetExhausted)
}
func (e *BudgetError) Unwrap() error { return ErrBudgetExhausted }

type Options struct {
	// WorkerExecutable and WorkerArgs must identify Relay's trusted internal worker.
	// They must never come from a ticket, model, or repository configuration.
	WorkerExecutable string
	WorkerArgs       []string
	Command          string
	Args             []string
	Directory        string
	Input            []byte
	Environment      map[string]string
	Timeout          time.Duration
	Progress         *ProgressPolicy
	TerminationGrace time.Duration
	MaxOutputBytes   int
	OnLine           func(ctx context.Context, line, stream string) error
}
type Result struct {
	ExitCode       int
	Signal         string
	Stdout, Stderr string
}
