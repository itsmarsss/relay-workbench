package task

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"relay.local/relay/internal/store"
)

type Configuration struct {
	Value    map[string]any `json:"config"`
	Revision string         `json:"revision"`
}
type ConfigurationService struct {
	Store *store.Store
	Now   func() time.Time
}

func revision(snapshot store.ConfigSnapshot) string {
	h := sha256.New()
	if snapshot.Exists {
		_, _ = h.Write([]byte{1})
	} else {
		_, _ = h.Write([]byte{0})
	}
	_, _ = h.Write(snapshot.Data)
	return hex.EncodeToString(h.Sum(nil))
}
func decodeConfig(snapshot store.ConfigSnapshot) (map[string]any, error) {
	if !snapshot.Exists {
		return Defaults(), nil
	}
	var raw map[string]any
	if json.Unmarshal(snapshot.Data, &raw) != nil || raw == nil {
		return nil, errors.New("invalid stored configuration")
	}
	if repositories, ok := raw["repositories"].([]any); ok {
		for _, value := range repositories {
			profile := object(value)
			if profile == nil || textValue(profile["id"]) == "" {
				return nil, errors.New("stored repository profile needs a stable ID")
			}
		}
	}
	return ValidateConfig(raw)
}

// Read returns a normalized snapshot and revision for optimistic editing.
func (s ConfigurationService) Read() (Configuration, error) {
	if s.Store == nil {
		return Configuration{}, errors.New("configuration store unavailable")
	}
	var result Configuration
	err := s.Store.WithConfig(func(snapshot store.ConfigSnapshot, _ func([]byte) error, _ func() error) error {
		value, err := decodeConfig(snapshot)
		if err != nil {
			return err
		}
		result = Configuration{Value: value, Revision: revision(snapshot)}
		return nil
	})
	return result, err
}

// Replace requires a matching revision and authenticated caller. It preserves
// the old file on validation failure or a concurrent edit.
func (s ConfigurationService) Replace(expected string, raw map[string]any) (Configuration, error) {
	if s.Store == nil {
		return Configuration{}, errors.New("configuration store unavailable")
	}
	validated, err := ValidateConfig(raw)
	if err != nil {
		return Configuration{}, err
	}
	data, err := json.MarshalIndent(validated, "", "  ")
	if err != nil {
		return Configuration{}, err
	}
	data = append(data, '\n')
	var result Configuration
	err = s.Store.WithConfig(func(snapshot store.ConfigSnapshot, replace func([]byte) error, _ func() error) error {
		if expected == "" || revision(snapshot) != expected {
			return store.ErrConfigChanged
		}
		if err := replace(data); err != nil {
			return err
		}
		result = Configuration{Value: validated, Revision: revision(store.ConfigSnapshot{Data: data, Exists: true})}
		return nil
	})
	return result, err
}

// CreateTask snapshots configuration and persists the draft while configuration
// writers are excluded. The caller must authenticate the user separately.
func (s ConfigurationService) CreateTask(raw map[string]any) (map[string]any, error) {
	if s.Store == nil {
		return nil, errors.New("configuration store unavailable")
	}
	var result map[string]any
	err := s.Store.WithConfig(func(snapshot store.ConfigSnapshot, _ func([]byte) error, verify func() error) error {
		config, err := decodeConfig(snapshot)
		if err != nil {
			return err
		}
		if err = verify(); err != nil {
			return err
		}
		result, err = (Service{Store: s.Store, Now: s.Now}).Create(raw, config)
		return err
	})
	return result, err
}
