package httpapi

import (
	"context"
	"net/http"
)

// setupRoute: GET /api/setup lists prerequisites; POST /api/setup/run {item, action} opens the
// setup terminal with that item's own install or login command.
func (s *Server) setupRoute(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path == "/api/repositories/setup" {
		return s.repositorySetupRoute(w, r)
	}
	if r.URL.Path != "/api/setup" && r.URL.Path != "/api/setup/run" {
		return false
	}
	if !s.authorized(r) {
		respond(w, 403, map[string]string{"error": "Session token required"})
		return true
	}
	setup, ok := s.workflow.(interface {
		SetupCheck(context.Context) (any, error)
		RunSetup(context.Context, map[string]any) (any, error)
	})
	if !ok {
		respond(w, 503, map[string]string{"error": "Setup checks unavailable"})
		return true
	}
	if r.URL.Path == "/api/setup" {
		if r.Method != http.MethodGet {
			respond(w, 405, map[string]string{"error": "Use GET"})
			return true
		}
		value, err := setup.SetupCheck(r.Context())
		result(w, value, err, 200)
		return true
	}
	if r.Method != http.MethodPost {
		respond(w, 405, map[string]string{"error": "Use POST"})
		return true
	}
	body, err := requestObject(w, r)
	if err != nil {
		respond(w, 400, map[string]string{"error": "Invalid setup request"})
		return true
	}
	value, err := setup.RunSetup(r.Context(), body)
	result(w, value, err, 202)
	return true
}

// repositorySetupRoute: POST /api/repositories/setup {repositoryId, action: propose|apply|status}.
func (s *Server) repositorySetupRoute(w http.ResponseWriter, r *http.Request) bool {
	if !s.authorized(r) {
		respond(w, 403, map[string]string{"error": "Session token required"})
		return true
	}
	setup, ok := s.workflow.(interface {
		RepositorySetupAction(context.Context, map[string]any) (any, error)
	})
	if !ok {
		respond(w, 503, map[string]string{"error": "Repository setup unavailable"})
		return true
	}
	if r.Method != http.MethodPost {
		respond(w, 405, map[string]string{"error": "Use POST"})
		return true
	}
	body, err := requestObject(w, r)
	if err != nil {
		respond(w, 400, map[string]string{"error": "Invalid repository setup request"})
		return true
	}
	value, err := setup.RepositorySetupAction(r.Context(), body)
	result(w, value, err, 200)
	return true
}
