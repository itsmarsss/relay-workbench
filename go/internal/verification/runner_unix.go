//go:build darwin || linux

package verification

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"relay.local/relay/internal/process"
)

// Runner executes only explicit command arguments received over its private
// local socket. The journal is held by Relay, not supplied by the model.
type Runner struct {
	options                  RunnerOptions
	ctx                      context.Context
	cancel                   context.CancelFunc
	listener                 net.Listener
	directory, socket, token string
	directoryInfo            os.FileInfo
	repositoryInfo           map[string]os.FileInfo
	mu                       sync.Mutex
	records                  []CheckRecord
	started                  int
	wg                       sync.WaitGroup
	slots                    chan struct{}
	closeOnce                sync.Once
	closeErr                 error
}

func StartRunner(ctx context.Context, options RunnerOptions) (*Runner, error) {
	if ctx == nil || options.WorkerExecutable == "" || options.Timeout <= 0 || options.SourceFingerprint == "" || len(options.Repositories) == 0 || options.OnEvent == nil {
		return nil, errors.New("verification runner is not configured")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	options.Repositories = append([]Repository(nil), options.Repositories...)
	options.WorkerArgs = append([]string(nil), options.WorkerArgs...)
	environment := map[string]string{}
	for key, value := range options.Environment {
		environment[key] = value
	}
	options.Environment = environment
	if options.Gate == nil {
		options.Gate = make(chan struct{}, 1)
	}
	if cap(options.Gate) != 1 {
		return nil, errors.New("verification resource gate must have capacity one")
	}
	seen := map[string]bool{}
	identities := map[string]os.FileInfo{}
	for i := range options.Repositories {
		entry := &options.Repositories[i]
		if entry.ID == "" || seen[entry.ID] || !filepath.IsAbs(entry.Root) {
			return nil, errors.New("invalid verification repository")
		}
		root, err := filepath.EvalSymlinks(entry.Root)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(root)
		if err != nil || !info.IsDir() {
			return nil, errors.New("verification repository is unavailable")
		}
		entry.Root, seen[entry.ID], identities[entry.ID] = root, true, info
	}
	directory, err := os.MkdirTemp("", "relay-check-")
	if err != nil {
		return nil, err
	}
	directoryInfo, err := os.Lstat(directory)
	if err != nil {
		_ = os.RemoveAll(directory)
		return nil, err
	}
	tokenBytes := make([]byte, 32)
	if _, err = rand.Read(tokenBytes); err != nil {
		_ = os.RemoveAll(directory)
		return nil, err
	}
	socket := filepath.Join(directory, "check.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		_ = os.RemoveAll(directory)
		return nil, err
	}
	if unix, ok := listener.(*net.UnixListener); ok {
		// The socket path may be replaced while an agent runs. Cleanup below
		// removes it only after checking the directory identity.
		unix.SetUnlinkOnClose(false)
	}
	if err = os.Chmod(socket, 0600); err != nil {
		_ = listener.Close()
		_ = os.RemoveAll(directory)
		return nil, err
	}
	runCtx, cancel := context.WithCancel(ctx)
	runner := &Runner{options: options, ctx: runCtx, cancel: cancel, listener: listener, directory: directory, directoryInfo: directoryInfo, repositoryInfo: identities, socket: socket, token: hex.EncodeToString(tokenBytes), slots: make(chan struct{}, 16)}
	runner.wg.Add(1)
	go runner.serve()
	return runner, nil
}

func (r *Runner) Socket() string { return r.socket }
func (r *Runner) Token() string  { return r.token }

func (r *Runner) Records() []CheckRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]CheckRecord, len(r.records))
	copy(result, r.records)
	for i := range result {
		result[i].Args = append([]string{}, result[i].Args...)
		if result[i].Code != nil {
			code := *result[i].Code
			result[i].Code = &code
		}
	}
	return result
}

func (r *Runner) serve() {
	defer r.wg.Done()
	for {
		conn, err := r.listener.Accept()
		if err != nil {
			return
		}
		select {
		case r.slots <- struct{}{}:
		default:
			_ = conn.Close()
			continue
		}
		r.wg.Add(1)
		go func() {
			defer r.wg.Done()
			defer func() { <-r.slots }()
			r.handle(conn)
		}()
	}
}

func withinRoot(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel)
}

func (r *Runner) validate(request CheckRequest) (CheckRequest, error) {
	if len(request.Token) != len(r.token) || subtle.ConstantTimeCompare([]byte(request.Token), []byte(r.token)) != 1 {
		return request, errors.New("invalid verification session")
	}
	if request.Purpose != "verification" && request.Purpose != "diagnostic" {
		return request, errors.New("invalid check purpose")
	}
	if request.Command == "" || len(request.Command) > 1000 || strings.ContainsRune(request.Command, '\x00') || len(request.Args) > 100 || !filepath.IsAbs(request.Cwd) {
		return request, errors.New("invalid check command")
	}
	for _, arg := range request.Args {
		if len(arg) > 20000 || strings.ContainsRune(arg, '\x00') {
			return request, errors.New("invalid check argument")
		}
	}
	var root string
	for _, entry := range r.options.Repositories {
		if entry.ID == request.RepositoryID {
			root = entry.Root
			break
		}
	}
	if root == "" {
		return request, errors.New("unknown check repository")
	}
	currentRoot, err := os.Stat(root)
	if err != nil || !currentRoot.IsDir() || !os.SameFile(currentRoot, r.repositoryInfo[request.RepositoryID]) {
		return request, errors.New("verification repository changed")
	}
	cwd, err := filepath.EvalSymlinks(request.Cwd)
	if err != nil || !withinRoot(root, cwd) {
		return request, errors.New("check directory is outside the selected repository")
	}
	info, err := os.Stat(cwd)
	if err != nil || !info.IsDir() {
		return request, errors.New("check directory is unavailable")
	}
	request.Cwd = cwd
	return request, nil
}

func (r *Runner) emit(ctx context.Context, event map[string]any) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("verification event handler failed: %v", recovered)
		}
	}()
	return r.options.OnEvent(ctx, event)
}

func (r *Runner) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	decoder := json.NewDecoder(io.LimitReader(conn, 256*1024))
	decoder.DisallowUnknownFields()
	var request CheckRequest
	if err := decoder.Decode(&request); err != nil {
		_ = json.NewEncoder(conn).Encode(checkFrame{Type: "error", Error: "Invalid check request"})
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	request, err := r.validate(request)
	if err != nil {
		_ = json.NewEncoder(conn).Encode(checkFrame{Type: "error", Error: err.Error()})
		return
	}
	ctx, cancel := context.WithCancel(r.ctx)
	defer cancel()
	go func() { _, _ = io.Copy(io.Discard, io.LimitReader(conn, 1)); cancel() }()
	send := func(frame checkFrame) error {
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		return json.NewEncoder(conn).Encode(frame)
	}
	select {
	case r.options.Gate <- struct{}{}:
		defer func() { <-r.options.Gate }()
	case <-ctx.Done():
		_ = send(checkFrame{Type: "error", Error: "Check cancelled while waiting for resources"})
		return
	}
	r.mu.Lock()
	if r.started >= 200 {
		r.mu.Unlock()
		_ = send(checkFrame{Type: "error", Error: "Verification check limit reached"})
		return
	}
	r.started++
	r.mu.Unlock()
	identifier := make([]byte, 16)
	if _, err = rand.Read(identifier); err != nil {
		_ = send(checkFrame{Type: "error", Error: "Could not identify check"})
		return
	}
	record := CheckRecord{ID: hex.EncodeToString(identifier), RepositoryID: request.RepositoryID, Cwd: request.Cwd, Command: request.Command, Args: append([]string{}, request.Args...), Purpose: request.Purpose, Status: "running", SourceFingerprint: r.options.SourceFingerprint, StartedAt: time.Now().UTC()}
	if err = r.emit(ctx, map[string]any{"type": "activity", "kind": "tool", "summary": "Running supervised check", "repositoryId": request.RepositoryID, "details": request.Command}); err != nil {
		_ = send(checkFrame{Type: "error", Error: err.Error()})
		return
	}
	result, runErr := process.Run(ctx, process.Options{WorkerExecutable: r.options.WorkerExecutable, WorkerArgs: r.options.WorkerArgs, Environment: r.options.Environment, Command: request.Command, Args: request.Args, Directory: request.Cwd, Timeout: r.options.Timeout, MaxOutputBytes: 8 * 1024 * 1024, OnLine: func(lineCtx context.Context, line, stream string) error {
		if len(line) > 40000 {
			line = line[:40000]
		}
		if err := r.emit(lineCtx, map[string]any{"type": "transcript", "stream": stream, "text": line, "repositoryId": request.RepositoryID}); err != nil {
			return err
		}
		return send(checkFrame{Type: "line", Stream: stream, Text: line})
	}})
	record.FinishedAt = time.Now().UTC()
	if runErr != nil {
		record.Status, record.Error = "interrupted", runErr.Error()
	} else {
		code := result.ExitCode
		record.Status, record.Code = "complete", &code
		if err = r.emit(ctx, map[string]any{"type": "activity", "kind": "tool", "summary": fmt.Sprintf("Supervised check exited %d", result.ExitCode), "repositoryId": request.RepositoryID, "details": request.Command}); err != nil {
			record.Status, record.Error, record.Code, runErr = "interrupted", err.Error(), nil, err
		}
	}
	r.mu.Lock()
	r.records = append(r.records, record)
	r.mu.Unlock()
	if runErr != nil {
		_ = send(checkFrame{Type: "error", Error: runErr.Error()})
		return
	}
	_ = send(checkFrame{Type: "result", Code: result.ExitCode})
}

func (r *Runner) Close() error {
	if r == nil {
		return nil
	}
	r.closeOnce.Do(func() {
		r.cancel()
		_ = r.listener.Close()
		r.wg.Wait()
		info, err := os.Lstat(r.directory)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !os.SameFile(info, r.directoryInfo) {
			r.closeErr = errors.New("verification directory changed; inspect it before cleanup")
			return
		}
		r.closeErr = os.RemoveAll(r.directory)
	})
	return r.closeErr
}
