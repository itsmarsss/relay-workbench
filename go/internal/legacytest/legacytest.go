// Package legacytest holds the original Node implementation's answers for the Go parity tests.
//
// The Go service was ported from a Node.js one, and its tests compared every result with what
// the Node code returned for the same input. The Node code is gone; its answers were recorded
// first, keyed by the exact input, and the tests compare against those recordings. A test whose
// input changes needs a new expected answer written by hand, the same as any other test.
package legacytest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func directory() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "recorded")
}

// Output returns the recorded legacy answer for the command the test would have run: the same
// inline program, standard input and trailing arguments. The legacy script's own path (the first
// argument after the program) is not part of the key. Set RELAY_RECORD_LEGACY=1 with the legacy
// sources present to record afresh.
//
// Paths that differ on every run (temporary directories) can be named in stable: they are
// replaced by placeholders in the key, so the recording still matches.
func Output(t testing.TB, label string, cmd *exec.Cmd, combined bool, stable ...string) ([]byte, error) {
	t.Helper()
	var input []byte
	if cmd.Stdin != nil {
		read, err := io.ReadAll(cmd.Stdin)
		if err != nil {
			t.Fatal(err)
		}
		input = read
		cmd.Stdin = bytes.NewReader(read)
	}
	steady := func(value []byte) []byte {
		for i, path := range stable {
			if path != "" {
				value = bytes.ReplaceAll(value, []byte(path), []byte(fmt.Sprintf("<path %d>", i)))
			}
		}
		return value
	}
	hash := sha256.New()
	hash.Write([]byte(t.Name() + "\x00" + label))
	for i, arg := range cmd.Args {
		// node --input-type=module -e <program> <legacy script> [arguments...]
		if i == 0 || i == 4 {
			continue
		}
		hash.Write([]byte{0})
		hash.Write(steady([]byte(arg)))
	}
	hash.Write([]byte{0})
	hash.Write(steady(input))
	path := filepath.Join(directory(), label+"-"+hex.EncodeToString(hash.Sum(nil))[:20]+".out")
	if os.Getenv("RELAY_RECORD_LEGACY") == "1" {
		var out []byte
		var err error
		if combined {
			out, err = cmd.CombinedOutput()
		} else {
			out, err = cmd.Output()
		}
		if err != nil {
			return out, err
		}
		if err = os.WriteFile(path, out, 0o644); err != nil {
			t.Fatal(err)
		}
		return out, nil
	}
	out, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		t.Fatalf("no recorded legacy answer for this %s input; the input changed, so write the expected result into the test", label)
	}
	return out, err
}
