package verification

import (
	"context"
	"time"
)

type Repository struct{ ID, Root, Cwd, BaseCommit string }

type RunnerOptions struct {
	WorkerExecutable  string
	WorkerArgs        []string
	Environment       map[string]string
	Repositories      []Repository
	SourceFingerprint string
	Timeout           time.Duration
	Gate              chan struct{}
	OnEvent           func(context.Context, map[string]any) error
}

type CheckRequest struct {
	Token        string   `json:"token"`
	RepositoryID string   `json:"repositoryId"`
	Cwd          string   `json:"cwd"`
	Command      string   `json:"command"`
	Args         []string `json:"args"`
	Purpose      string   `json:"purpose"`
}

type CheckRecord struct {
	ID                string    `json:"id"`
	RepositoryID      string    `json:"repositoryId"`
	Cwd               string    `json:"cwd"`
	Command           string    `json:"command"`
	Args              []string  `json:"args"`
	Purpose           string    `json:"purpose"`
	Status            string    `json:"status"`
	SourceFingerprint string    `json:"sourceFingerprint"`
	Code              *int      `json:"code,omitempty"`
	StartedAt         time.Time `json:"startedAt"`
	FinishedAt        time.Time `json:"finishedAt"`
	Error             string    `json:"error,omitempty"`
}

type checkFrame struct {
	Type   string `json:"type"`
	Stream string `json:"stream,omitempty"`
	Text   string `json:"text,omitempty"`
	Code   int    `json:"code,omitempty"`
	Error  string `json:"error,omitempty"`
}
