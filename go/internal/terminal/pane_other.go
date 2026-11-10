//go:build !darwin && !linux

package terminal

func Pane([]string) int { return 127 }
