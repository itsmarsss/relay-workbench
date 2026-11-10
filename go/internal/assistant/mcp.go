package assistant

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  map[string]any  `json:"params"`
}

func (s *Service) serveTools(ctx context.Context, socket, capability string, chat Chat, messageID string) (func(), error) {
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(socket, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != "POST" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+capability)) != 1 {
			w.WriteHeader(403)
			return
		}
		var request rpcRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&request) != nil {
			w.WriteHeader(400)
			return
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			w.WriteHeader(400)
			return
		}
		result, err := s.rpc(r.Context(), chat, request)
		response := map[string]any{"jsonrpc": "2.0", "id": request.ID}
		if err != nil {
			response["error"] = map[string]any{"code": -32602, "message": err.Error()}
		} else {
			response["result"] = result
		}
		raw, _ := json.Marshal(response)
		if len(raw) > 2*1024*1024 {
			raw, _ = json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "error": map[string]any{"code": -32603, "message": "Result exceeds limit; narrow the request"}})
		}
		_, _ = w.Write(raw)
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	done := make(chan struct{})
	go func() { defer close(done); _ = server.Serve(listener) }()
	return func() { _ = server.Close(); <-done }, nil
}
func (s *Service) rpc(ctx context.Context, chat Chat, r rpcRequest) (any, error) {
	switch r.Method {
	case "initialize":
		return map[string]any{"protocolVersion": "2024-11-05", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "relay", "version": "1.0.0"}}, nil
	case "ping", "notifications/initialized":
		return map[string]any{}, nil
	case "tools/list":
		definitions := tools()
		if chat.TaskID != "" {
			filtered := []tool{}
			for _, t := range definitions {
				if !strings.HasPrefix(t.Name, "propose_") && t.Name != "create_draft" {
					filtered = append(filtered, t)
				}
			}
			definitions = filtered
		}
		return map[string]any{"tools": definitions}, nil
	case "tools/call":
		args := obj(r.Params["arguments"])
		if args == nil {
			args = map[string]any{}
		}
		result, err := s.call(ctx, chat, text(r.Params["name"]), args)
		if err != nil {
			return map[string]any{"content": []any{map[string]any{"type": "text", "text": err.Error()}}, "isError": true}, nil
		}
		raw, err := json.Marshal(result)
		if err != nil {
			return nil, err
		}
		return map[string]any{"content": []any{map[string]any{"type": "text", "text": string(raw)}}}, nil
	default:
		return nil, errors.New("unsupported MCP method")
	}
}

// MCPClient is a private stdio bridge. It never opens state, runs repository
// commands or exposes HTTP capabilities to the model.
func MCPClient(args []string, input io.Reader, output, diagnostic io.Writer) int {
	if len(args) != 2 {
		return 2
	}
	socket, capability := args[0], args[1]
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 40 * time.Second}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		line := append([]byte{}, scanner.Bytes()...)
		var request rpcRequest
		if json.Unmarshal(line, &request) != nil {
			continue
		}
		if len(request.ID) == 0 || string(request.ID) == "null" {
			continue
		}
		r, err := http.NewRequest("POST", "http://relay/mcp", bytes.NewReader(line))
		if err != nil {
			return 1
		}
		r.Header.Set("Authorization", "Bearer "+capability)
		r.Header.Set("Content-Type", "application/json")
		response, err := client.Do(r)
		if err != nil {
			fmt.Fprintln(diagnostic, "Relay tool bridge unavailable")
			return 1
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024+1))
		response.Body.Close()
		if err != nil || response.StatusCode != 200 || len(data) > 2*1024*1024 {
			return 1
		}
		if _, err = fmt.Fprintln(output, string(data)); err != nil {
			return 1
		}
	}
	if scanner.Err() != nil {
		return 1
	}
	return 0
}
