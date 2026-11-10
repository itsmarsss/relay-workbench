package publication

import "testing"

func validSnapshot() map[string]any {
	return map[string]any{"url": "https://code.example/team/repo/pull/7", "number": "7", "title": "A change", "state": "open", "draft": true, "checks": "pending", "review": "required"}
}

func TestPublicationSnapshotRequiresSafeObservedState(t *testing.T) {
	value := validSnapshot()
	result, err := ParseSnapshot(value)
	if err != nil || result.URL == "" || result.Draft == nil || !*result.Draft {
		t.Fatalf("valid snapshot: %#v %v", result, err)
	}
	for _, change := range []func(map[string]any){
		func(v map[string]any) { v["url"] = "javascript:alert(1)" },
		func(v map[string]any) { v["url"] = "https://user:password@code.example/repo" },
		func(v map[string]any) { v["url"] = "" },
		func(v map[string]any) { v["state"] = "invented" },
		func(v map[string]any) { v["checks"] = "pass" },
		func(v map[string]any) { v["draft"] = "yes" },
		func(v map[string]any) { delete(v, "review") },
	} {
		candidate := validSnapshot()
		change(candidate)
		if _, err := ParseSnapshot(candidate); err == nil {
			t.Fatalf("invalid snapshot accepted: %#v", candidate)
		}
	}
	unknown := validSnapshot()
	unknown["state"], unknown["url"], unknown["draft"] = "unknown", "", nil
	if _, err := ParseSnapshot(unknown); err != nil {
		t.Fatalf("valid unknown state rejected: %v", err)
	}
}
