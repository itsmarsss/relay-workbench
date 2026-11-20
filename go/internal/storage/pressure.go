// Package storage tracks local disk pressure. It never deletes user data.
package storage

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

const GiB uint64 = 1024 * 1024 * 1024

type Policy struct {
	Enabled         bool     `json:"enabled"`
	WarningPercent  uint64   `json:"warningPercent"`
	CriticalPercent uint64   `json:"criticalPercent"`
	WarningBytes    uint64   `json:"warningBytes"`
	CriticalBytes   uint64   `json:"criticalBytes"`
	MonitoredPaths  []string `json:"monitoredPaths"`
}
type Space struct {
	TotalBytes     uint64 `json:"totalBytes,string"`
	AvailableBytes uint64 `json:"availableBytes,string"`
}
type Pressure struct {
	State             string `json:"state"`
	Space             Space  `json:"space"`
	WarningThreshold  uint64 `json:"warningThreshold,string"`
	CriticalThreshold uint64 `json:"criticalThreshold,string"`
	Message           string `json:"message"`
}

var ErrLowSpace = errors.New("not enough free disk space")

func Defaults() Policy {
	return Policy{Enabled: true, WarningPercent: 10, CriticalPercent: 3, WarningBytes: 10 * GiB, CriticalBytes: 2 * GiB, MonitoredPaths: []string{}}
}
func (p Policy) Validate() error {
	if p.WarningPercent > 100 || p.CriticalPercent > 100 || p.CriticalPercent > p.WarningPercent || p.CriticalBytes > p.WarningBytes || p.WarningBytes > (1<<53)-1 || p.CriticalBytes > (1<<53)-1 {
		return errors.New("invalid storage thresholds")
	}
	if p.MonitoredPaths == nil || len(p.MonitoredPaths) > 20 {
		return errors.New("invalid monitored paths")
	}
	seen := map[string]bool{}
	for _, path := range p.MonitoredPaths {
		if !filepath.IsAbs(path) || len(path) > 2000 || strings.ContainsAny(path, "\x00\r\n") {
			return errors.New("monitored paths must be absolute")
		}
		clean := filepath.Clean(path)
		if seen[clean] {
			return errors.New("duplicate monitored paths")
		}
		seen[clean] = true
	}
	return nil
}
func percent(total, value uint64) uint64 { return (total/100)*value + (total%100)*value/100 }

// lower picks the smaller threshold: a large disk warns at the fixed size rather than at a
// percentage that still leaves tens of gigabytes free, and a small disk warns at its percentage.
func lower(a, b uint64) uint64 {
	if a < b {
		return a
	}
	return b
}

// Evaluate uses space available to the current user, not space reserved for root.
func Evaluate(policy Policy, space Space) (Pressure, error) {
	if err := policy.Validate(); err != nil {
		return Pressure{}, err
	}
	if space.TotalBytes == 0 || space.AvailableBytes > space.TotalBytes {
		return Pressure{}, errors.New("invalid filesystem capacity")
	}
	result := Pressure{Space: space, WarningThreshold: lower(percent(space.TotalBytes, policy.WarningPercent), policy.WarningBytes), CriticalThreshold: lower(percent(space.TotalBytes, policy.CriticalPercent), policy.CriticalBytes)}
	switch {
	case !policy.Enabled:
		result.State = "disabled"
		result.Message = "Storage warnings are disabled."
	case space.AvailableBytes <= result.CriticalThreshold:
		result.State = "critical"
		result.Message = "Free space is critically low. Free space before starting more work."
	case space.AvailableBytes <= result.WarningThreshold:
		result.State = "warning"
		result.Message = "Free space is low. Review build caches and unused artifacts."
	default:
		result.State = "normal"
		result.Message = "Free space is above the configured thresholds."
	}
	return result, nil
}

// gibibytes is a size for a sentence, to one decimal place.
func gibibytes(bytes uint64) string {
	return fmt.Sprintf("%.1f GiB", float64(bytes)/float64(GiB))
}

// Admission is for the future scheduler before starting new work. It never
// interrupts an already running process or routes disk pressure to a debugger.
func Admission(policy Policy, space Space) error {
	p, err := Evaluate(policy, space)
	if err != nil {
		return err
	}
	if p.State == "critical" {
		return fmt.Errorf("%w: %s free, %s needed", ErrLowSpace, gibibytes(space.AvailableBytes), gibibytes(p.CriticalThreshold))
	}
	return nil
}
