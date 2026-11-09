package storage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
)

const policyKey = "storage:policy"

var ErrPolicyChanged = errors.New("storage policy changed since inspection")

type PolicyStore interface {
	GetMeta(string) (string, bool, error)
	UpdateMeta(string, func(string, bool) (string, error)) error
}
type PolicySnapshot struct {
	Policy   Policy `json:"policy"`
	Revision string `json:"revision"`
}
type PolicyService struct{ Store PolicyStore }

func policyRevision(value string, exists bool) string {
	h := sha256.New()
	if exists {
		_, _ = h.Write([]byte{1})
	} else {
		_, _ = h.Write([]byte{0})
	}
	_, _ = h.Write([]byte(value))
	return hex.EncodeToString(h.Sum(nil))
}
func decodePolicy(value string, exists bool) (Policy, error) {
	if !exists {
		return Defaults(), nil
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(value), &fields) != nil || len(fields) != 6 {
		return Policy{}, errors.New("invalid stored storage policy")
	}
	for _, key := range []string{"enabled", "warningPercent", "criticalPercent", "warningBytes", "criticalBytes", "monitoredPaths"} {
		value, ok := fields[key]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return Policy{}, errors.New("invalid stored storage policy")
		}
	}
	var policy Policy
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		return Policy{}, errors.New("invalid stored storage policy")
	}
	if err := policy.Validate(); err != nil {
		return Policy{}, err
	}
	return policy, nil
}
func (s PolicyService) Read() (PolicySnapshot, error) {
	if s.Store == nil {
		return PolicySnapshot{}, errors.New("storage policy store unavailable")
	}
	value, exists, err := s.Store.GetMeta(policyKey)
	if err != nil {
		return PolicySnapshot{}, err
	}
	policy, err := decodePolicy(value, exists)
	if err != nil {
		return PolicySnapshot{}, err
	}
	return PolicySnapshot{policy, policyRevision(value, exists)}, nil
}

// Replace uses the exact prior receipt as a compare-and-swap; callers must
// authenticate any user making a change.
func (s PolicyService) Replace(expected string, policy Policy) (PolicySnapshot, error) {
	if s.Store == nil {
		return PolicySnapshot{}, errors.New("storage policy store unavailable")
	}
	if err := policy.Validate(); err != nil {
		return PolicySnapshot{}, err
	}
	raw, err := json.Marshal(policy)
	if err != nil {
		return PolicySnapshot{}, err
	}
	value := string(raw)
	err = s.Store.UpdateMeta(policyKey, func(previous string, exists bool) (string, error) {
		if expected == "" || policyRevision(previous, exists) != expected {
			return "", ErrPolicyChanged
		}
		return value, nil
	})
	if err != nil {
		return PolicySnapshot{}, err
	}
	if notifier, ok := s.Store.(interface{ NotifyChange() }); ok {
		notifier.NotifyChange()
	}
	return PolicySnapshot{policy, policyRevision(value, true)}, nil
}
