//go:build !darwin && !linux

package process

import "context"

func Run(context.Context, Options) (Result, error) { return Result{}, ErrUnsupported }
func Worker([]string) int                          { return 127 }
