package httpapi

import (
	"encoding/hex"
	"strings"
	"testing"

	"relay.local/relay/internal/selfupdate"
)

type fakeUpdater struct {
	enabled bool
	checks  int
}

func (f *fakeUpdater) Status() selfupdate.Status {
	return selfupdate.Status{Enabled: f.enabled, Available: true, State: "current", Summary: "Up to date."}
}
func (f *fakeUpdater) SetEnabled(on bool) error { f.enabled = on; return nil }
func (f *fakeUpdater) CheckSoon()               { f.checks++ }

func TestUpdatesNeedTheSessionTokenToChange(t *testing.T) {
	app, _ := setup(t)
	token := hex.EncodeToString(app.token[:])
	updater := &fakeUpdater{enabled: true}
	app.SetUpdater(updater)
	if w := requestBody(app, "GET", "/api/updates", "", "", "", "", ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"state":"current"`) {
		t.Fatalf("status: %d %s", w.Code, w.Body.String())
	}
	if w := requestBody(app, "POST", "/api/updates", "", "", "", "application/json", `{"enabled":false}`); w.Code != 403 || !updater.enabled {
		t.Fatalf("changed updates without the token: %d", w.Code)
	}
	if w := requestBody(app, "POST", "/api/updates", token, "", "", "application/json", `{"enabled":false}`); w.Code != 200 || updater.enabled {
		t.Fatalf("could not turn updates off: %d %s", w.Code, w.Body.String())
	}
	if w := requestBody(app, "POST", "/api/updates", token, "", "", "application/json", `{"check":true}`); w.Code != 200 || updater.checks != 1 {
		t.Fatalf("check was not requested: %d", w.Code)
	}
	if w := requestBody(app, "POST", "/api/updates", token, "", "", "application/json", `{"enabled":true,"check":true}`); w.Code != 400 {
		t.Fatalf("accepted a mixed request: %d", w.Code)
	}
}
