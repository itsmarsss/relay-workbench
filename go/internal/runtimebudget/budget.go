// Package runtimebudget ports the legacy progress-sensitive deadline policy.
// It is not connected to a process runner yet.
package runtimebudget

import (
	"errors"
	"fmt"
	"math"
	"time"
)

type Decision string

const (
	Wait   Decision = "wait"
	Extend Decision = "extend"
	Stop   Decision = "stop"
)

type Budget struct {
	StartedAt, Timeout, SoftDeadline, HardDeadline, ProgressWindow float64
	Extensions                                                     int
}

func New(timeout, startedAt float64, maxTimeout, progressWindow *float64) *Budget {
	max := timeout * 2
	if maxTimeout != nil {
		max = *maxTimeout
	}
	window := math.Min(timeout/2, 600000)
	if progressWindow != nil {
		window = *progressWindow
	}
	return &Budget{StartedAt: startedAt, Timeout: timeout, SoftDeadline: startedAt + timeout, HardDeadline: startedAt + math.Max(timeout, max), ProgressWindow: window}
}
func (b *Budget) Evaluate(now float64, lastProgress *float64) Decision {
	if now < b.SoftDeadline {
		return Wait
	}
	if now < b.HardDeadline && lastProgress != nil && !math.IsNaN(*lastProgress) && !math.IsInf(*lastProgress, 0) && *lastProgress > b.StartedAt && now-*lastProgress <= b.ProgressWindow {
		b.SoftDeadline = math.Min(b.HardDeadline, now+math.Max(50, math.Min(b.Timeout/4, 900000)))
		b.Extensions++
		return Extend
	}
	return Stop
}

type Snapshot struct {
	StartedAt      string  `json:"startedAt"`
	SoftDeadlineAt string  `json:"softDeadlineAt"`
	HardDeadlineAt string  `json:"hardDeadlineAt"`
	Extensions     int     `json:"extensions"`
	LastProgressAt *string `json:"lastProgressAt"`
}

func iso(v float64) (string, error) {
	if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > 8640000000000000 {
		return "", errors.New("Invalid time value")
	}
	instant := time.UnixMilli(int64(v)).UTC()
	year := instant.Year()
	prefix := ""
	if year >= 0 && year <= 9999 {
		prefix = fmt.Sprintf("%04d", year)
	} else {
		prefix = fmt.Sprintf("%+07d", year)
	}
	return prefix + instant.Format("-01-02T15:04:05.000Z"), nil
}
func (b *Budget) Snapshot(lastProgress *float64) (Snapshot, error) {
	started, err := iso(b.StartedAt)
	if err != nil {
		return Snapshot{}, err
	}
	soft, err := iso(b.SoftDeadline)
	if err != nil {
		return Snapshot{}, err
	}
	hard, err := iso(b.HardDeadline)
	if err != nil {
		return Snapshot{}, err
	}
	var progress *string
	if lastProgress != nil && *lastProgress != 0 && !math.IsNaN(*lastProgress) {
		value, err := iso(*lastProgress)
		if err != nil {
			return Snapshot{}, err
		}
		progress = &value
	}
	return Snapshot{started, soft, hard, b.Extensions, progress}, nil
}
