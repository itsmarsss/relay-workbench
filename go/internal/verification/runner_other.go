//go:build !darwin && !linux

package verification

import (
	"context"
	"errors"
	"fmt"
	"io"
)

type Runner struct{}

func StartRunner(context.Context, RunnerOptions) (*Runner, error) {
	return nil, errors.New("supervised verification is not supported on this platform")
}
func (*Runner) Socket() string         { return "" }
func (*Runner) Token() string          { return "" }
func (*Runner) Records() []CheckRecord { return nil }
func (*Runner) Close() error           { return nil }
func RunClient(_ []string, _ io.Writer, stderr io.Writer) int {
	fmt.Fprintln(stderr, "Supervised verification is not supported on this platform")
	return 1
}
