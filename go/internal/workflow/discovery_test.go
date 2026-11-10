//go:build darwin || linux

package workflow

import (
	"context"
	"os"
	"path/filepath"
	"relay.local/relay/internal/discovery"
	"testing"
)

func TestRepositoryDiscoveryDetailsRemainOptIn(t *testing.T) {
	coordinator, _, _, source := coordinatorFixture(t, "exit 0")
	ctx := context.Background()
	if _, err := coordinator.Discover(ctx, "repositories", map[string]any{"details": "yes"}); err == nil {
		t.Fatal("invalid details accepted")
	}
	if _, err := coordinator.Discover(ctx, "repositories", map[string]any{"roots": []any{source}, "unexpected": true}); err == nil {
		t.Fatal("unexpected field accepted")
	}
	legacy, err := coordinator.Discover(ctx, "repositories", map[string]any{"roots": []any{source}})
	if err != nil {
		t.Fatal(err)
	}
	if rows, ok := legacy.([]discovery.Repository); !ok || len(rows) != 1 {
		t.Fatalf("legacy response changed: %#v", legacy)
	}
	missing := filepath.Join(t.TempDir(), "missing")
	value, err := coordinator.Discover(ctx, "repositories", map[string]any{"roots": []any{source, missing}, "details": true})
	if err != nil {
		t.Fatal(err)
	}
	report, ok := value.(discovery.Report)
	if !ok || len(report.Repositories) != 1 || len(report.Roots) != 2 || len(report.Warnings) != 1 {
		t.Fatalf("report missing scope: %#v", value)
	}
	if report.Repositories[0].ConfiguredID != "repo" {
		t.Fatalf("configured repository not matched canonically: %#v", report.Repositories)
	}
	if _, err = os.Stat(source); err != nil {
		t.Fatal("source changed")
	}
}
