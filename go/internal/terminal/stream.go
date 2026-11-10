package terminal

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func decodeOutput(value string) []byte {
	result := []byte{}
	for i := 0; i < len(value); i++ {
		if value[i] == '\\' && i+3 < len(value) {
			if n, err := strconv.ParseUint(value[i+1:i+4], 8, 8); err == nil {
				result = append(result, byte(n))
				i += 3
				continue
			}
		}
		result = append(result, value[i])
	}
	return result
}

// Stream attaches a read-only control client. Input remains a separately
// authenticated operation; the browser never supplies tmux command text.
func Stream(ctx context.Context, info Info, send func(map[string]any) error) error {
	if err := validateInfo(info); err != nil {
		return err
	}
	childCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	child := exec.CommandContext(childCtx, "tmux", "-S", info.Socket, "-C", "attach-session", "-f", "ignore-size", "-t", info.Session)
	stdin, err := child.StdinPipe()
	if err != nil {
		return err
	}
	defer stdin.Close()
	stdout, err := child.StdoutPipe()
	if err != nil {
		return err
	}
	if err = child.Start(); err != nil {
		return err
	}
	defer func() { cancel(); _ = child.Wait() }()
	timer := time.AfterFunc(5*time.Second, cancel)
	defer timer.Stop()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 65536), 1024*1024)
	phase, token := "attach", ""
	var block, screen []string
	queued := []byte{}
	snapshot := func() error {
		phase = "screen"
		queued = nil
		_, err := fmt.Fprintf(stdin, "capture-pane -e -p -t %s\n", info.Session)
		return err
	}
	for scanner.Scan() {
		line := scanner.Text()
		if token != "" {
			if line == "%error "+token {
				return errors.New("terminal rejected the viewer")
			}
			if line != "%end "+token {
				block = append(block, line)
				continue
			}
			token = ""
			switch phase {
			case "attach":
				if err = snapshot(); err != nil {
					return err
				}
			case "screen":
				screen = block
				phase = "cursor"
				if _, err = fmt.Fprintf(stdin, "display-message -p -t %s '#{pane_width},#{pane_height},#{cursor_x},#{cursor_y}'\n", info.Session); err != nil {
					return err
				}
			case "cursor":
				if len(block) == 0 {
					return errors.New("terminal dimensions unavailable")
				}
				values := strings.Split(block[0], ",")
				if len(values) != 4 {
					return errors.New("invalid terminal dimensions")
				}
				numbers := make([]int, 4)
				for i, v := range values {
					numbers[i], err = strconv.Atoi(v)
					if err != nil {
						return err
					}
				}
				if numbers[0] < 2 || numbers[0] > 1000 || numbers[1] < 2 || numbers[1] > 500 {
					return errors.New("invalid terminal dimensions")
				}
				data := append([]byte("\x1b[2J\x1b[H"+strings.Join(screen, "\r\n")), queued...)
				data = append(data, []byte(fmt.Sprintf("\x1b[%d;%dH", numbers[3]+1, numbers[2]+1))...)
				if err = send(map[string]any{"type": "snapshot", "cols": numbers[0], "rows": numbers[1], "data": base64.StdEncoding.EncodeToString(data)}); err != nil {
					return err
				}
				timer.Stop()
				phase = "live"
				queued = nil
			}
			block = nil
			continue
		}
		if strings.HasPrefix(line, "%begin ") {
			token = strings.TrimPrefix(line, "%begin ")
			block = nil
			continue
		}
		if strings.HasPrefix(line, "%output ") {
			parts := strings.SplitN(line, " ", 3)
			if len(parts) != 3 {
				continue
			}
			data := decodeOutput(parts[2])
			if phase == "live" {
				if err = send(map[string]any{"type": "output", "data": base64.StdEncoding.EncodeToString(data)}); err != nil {
					return err
				}
			} else if phase == "cursor" {
				queued = append(queued, data...)
				if len(queued) > 1024*1024 {
					return errors.New("terminal output buffer exceeded")
				}
			}
		}
		if strings.HasPrefix(line, "%exit") {
			return nil
		}
		if strings.HasPrefix(line, "%layout-change ") && phase == "live" {
			if err = snapshot(); err != nil {
				return err
			}
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return scanner.Err()
}
