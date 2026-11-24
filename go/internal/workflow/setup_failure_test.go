package workflow

import (
	"strings"
	"testing"
)

// A setup program that cannot be found is named, with what to do about it.
func TestSetupFailureNamesAMissingCommand(t *testing.T) {
	err := setupFailure("world", "/nix/store/gone-nodejs/bin/node", 127)
	if !strings.Contains(err.Error(), "/nix/store/gone-nodejs/bin/node") || !strings.Contains(err.Error(), "command not found") {
		t.Fatal(err)
	}
	if err := setupFailure("world", "node", 2); err.Error() != "setup for world exited 2" {
		t.Fatal(err)
	}
}
