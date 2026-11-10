package assistant

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type stream struct {
	answer  string
	final   string
	calls   []ToolCall
	last    time.Time
	save    func(string, []ToolCall) error
	failure string
}

func newStream(save func(string, []ToolCall) error) *stream {
	return &stream{save: save, calls: []ToolCall{}}
}
func (s *stream) consume(line string) error {
	var event map[string]any
	if json.Unmarshal([]byte(line), &event) != nil {
		return nil
	}
	switch event["type"] {
	case "stream_event":
		e := obj(event["event"])
		if e["type"] == "content_block_delta" {
			delta := obj(e["delta"])
			if delta["type"] == "text_delta" {
				s.answer += text(delta["text"])
			}
		}
	case "assistant":
		for _, raw := range array(obj(event["message"])["content"]) {
			block := obj(raw)
			if block["type"] == "tool_use" {
				id := text(block["id"])
				found := false
				for _, c := range s.calls {
					if c.ID == id {
						found = true
					}
				}
				if !found {
					s.calls = append(s.calls, ToolCall{ID: id, Name: text(block["name"]), Input: block["input"], Status: "running"})
				}
			}
		}
	case "user":
		for _, raw := range array(obj(event["message"])["content"]) {
			block := obj(raw)
			if block["type"] == "tool_result" {
				for i := range s.calls {
					if s.calls[i].ID == text(block["tool_use_id"]) {
						s.calls[i].Status = "complete"
						if block["is_error"] == true {
							s.calls[i].Status = "failed"
						}
					}
				}
			}
		}
	case "result":
		if event["is_error"] == true {
			s.failure = text(event["result"])
		}
		s.final = text(event["result"])
		if s.final != "" {
			s.answer = s.final
		}
	}
	if len(s.answer) > 1024*1024 || len(s.calls) > 500 {
		return errors.New("assistant response exceeded limits")
	}
	if time.Since(s.last) > 150*time.Millisecond || event["type"] == "result" {
		s.last = time.Now()
		return s.save(s.answer, s.calls)
	}
	return nil
}
func (s *stream) finish() error {
	if s.failure != "" {
		return errors.New(s.failure)
	}
	if strings.TrimSpace(s.final) == "" {
		return errors.New("assistant returned no completed answer")
	}
	return s.save(s.final, s.calls)
}
