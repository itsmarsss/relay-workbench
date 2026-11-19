package httpapi

import (
	"net/http"

	"relay.local/relay/internal/selfupdate"
)

// Updater is Relay's self-update loop, when it runs from a clone of its repository.
type Updater interface {
	Status() selfupdate.Status
	SetEnabled(bool) error
	CheckSoon()
}

func (s *Server) SetUpdater(value Updater) { s.updater = value }

// updatesRoute: GET the update status; POST {"enabled": bool} or {"check": true}.
func (s *Server) updatesRoute(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/updates" {
		return false
	}
	if s.updater == nil {
		respond(w, 200, selfupdate.Status{State: "idle", Summary: "Updates are not available for this installation."})
		return true
	}
	switch r.Method {
	case http.MethodGet:
		respond(w, 200, s.updater.Status())
	case http.MethodPost:
		if !s.authorized(r) {
			respond(w, 403, map[string]string{"error": "Session token required"})
			return true
		}
		body, err := requestObject(w, r)
		if err != nil || len(body) != 1 {
			respond(w, 400, map[string]string{"error": "Send enabled or check"})
			return true
		}
		if enabled, ok := body["enabled"].(bool); ok {
			if err = s.updater.SetEnabled(enabled); err != nil {
				respond(w, 500, map[string]string{"error": err.Error()})
				return true
			}
		} else if body["check"] == true {
			s.updater.CheckSoon()
		} else {
			respond(w, 400, map[string]string{"error": "Send enabled or check"})
			return true
		}
		respond(w, 200, s.updater.Status())
	default:
		w.Header().Set("Allow", "GET, POST")
		respond(w, 405, map[string]string{"error": "Use GET or POST"})
	}
	return true
}
