// Package publication validates provider-neutral pull-request observations.
package publication

import (
	"errors"
	"net/url"
	"strings"
	"unicode/utf16"
)

type Snapshot struct {
	URL    string `json:"url"`
	Number string `json:"number"`
	Title  string `json:"title"`
	State  string `json:"state"`
	Draft  *bool  `json:"draft"`
	Checks string `json:"checks"`
	Review string `json:"review"`
}

func member(value string, choices ...string) bool {
	for _, choice := range choices {
		if value == choice {
			return true
		}
	}
	return false
}

// ParseSnapshot validates every field before Relay exposes a provider link.
func ParseSnapshot(value any) (Snapshot, error) {
	item, ok := value.(map[string]any)
	if !ok || item == nil {
		return Snapshot{}, errors.New("publication returned no snapshot")
	}
	result := Snapshot{}
	for key, target := range map[string]*string{"url": &result.URL, "number": &result.Number, "title": &result.Title, "state": &result.State, "checks": &result.Checks, "review": &result.Review} {
		v, ok := item[key].(string)
		if !ok || len(utf16.Encode([]rune(v))) > 2000 || strings.ContainsRune(v, '\x00') {
			return Snapshot{}, errors.New("invalid publication " + key)
		}
		*target = v
	}
	if !member(result.State, "unknown", "not_created", "open", "closed", "merged") || !member(result.Checks, "unknown", "pending", "passing", "failing") || !member(result.Review, "unknown", "required", "approved", "changes_requested") {
		return Snapshot{}, errors.New("invalid publication status")
	}
	if draft, exists := item["draft"]; !exists {
		return Snapshot{}, errors.New("invalid publication draft status")
	} else if draft != nil {
		value, ok := draft.(bool)
		if !ok {
			return Snapshot{}, errors.New("invalid publication draft status")
		}
		result.Draft = &value
	}
	if result.URL != "" {
		u, err := url.Parse(result.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || strings.ContainsAny(result.URL, "\x00\r\n\t ") {
			return Snapshot{}, errors.New("invalid publication URL")
		}
	}
	if member(result.State, "open", "closed", "merged") && result.URL == "" {
		return Snapshot{}, errors.New("observed pull request needs a verified URL")
	}
	return result, nil
}
