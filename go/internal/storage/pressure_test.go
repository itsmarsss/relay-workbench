package storage

import (
	"errors"
	"math"
	"testing"
)

func TestPressureUsesPercentAndAbsoluteThresholds(t *testing.T) {
	p := Defaults()
	for _, tc := range []struct {
		total, free uint64
		want        string
	}{{1000 * GiB, 200 * GiB, "normal"}, {1000 * GiB, 90 * GiB, "warning"}, {1000 * GiB, 20 * GiB, "critical"}, {20 * GiB, 9 * GiB, "warning"}, {20 * GiB, 1 * GiB, "critical"}} {
		got, err := Evaluate(p, Space{tc.total, tc.free})
		if err != nil || got.State != tc.want {
			t.Fatalf("%+v: %#v %v", tc, got, err)
		}
	}
}
func TestAdmissionDoesNotTreatPressureAsAgentFailure(t *testing.T) {
	p := Defaults()
	if err := Admission(p, Space{100 * GiB, GiB}); !errors.Is(err, ErrLowSpace) {
		t.Fatalf("critical: %v", err)
	}
	if err := Admission(p, Space{100 * GiB, 8 * GiB}); err != nil {
		t.Fatalf("warning blocked: %v", err)
	}
	p.Enabled = false
	if err := Admission(p, Space{100 * GiB, GiB}); err != nil {
		t.Fatalf("disabled: %v", err)
	}
}
func TestThresholdsRejectInvalidAndAvoidOverflow(t *testing.T) {
	p := Defaults()
	p.CriticalPercent = 11
	if err := p.Validate(); err == nil {
		t.Fatal("invalid percentages accepted")
	}
	p = Defaults()
	p.CriticalBytes = p.WarningBytes + 1
	if err := p.Validate(); err == nil {
		t.Fatal("invalid byte thresholds accepted")
	}
	p = Defaults()
	if _, err := Evaluate(p, Space{0, 0}); err == nil {
		t.Fatal("empty filesystem accepted")
	}
	got, err := Evaluate(p, Space{math.MaxUint64, math.MaxUint64})
	if err != nil || got.WarningThreshold != percent(math.MaxUint64, 10) {
		t.Fatalf("overflow: %#v %v", got, err)
	}
}

func TestMonitoredPathsMustBeExplicitAndDistinct(t *testing.T) {
	p := Defaults()
	p.MonitoredPaths = []string{"relative"}
	if err := p.Validate(); err == nil {
		t.Fatal("relative monitored path accepted")
	}
	p.MonitoredPaths = []string{"/example/cache", "/example/./cache"}
	if err := p.Validate(); err == nil {
		t.Fatal("duplicate monitored path accepted")
	}
	p.MonitoredPaths = []string{"/example/cache\nother"}
	if err := p.Validate(); err == nil {
		t.Fatal("multiline monitored path accepted")
	}
}
