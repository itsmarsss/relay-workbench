//go:build darwin || linux

package store

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestStateLockHolder(t *testing.T) {
	dir := os.Getenv("RELAY_TEST_STATE_LOCK")
	if dir == "" {
		return
	}
	db, err := Open(dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if err = db.Save(json.RawMessage(`{"id":"retained","title":"Work","status":"running"}`), nil); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	fmt.Println("ready")
	time.Sleep(time.Hour)
}

func TestStateLockRecoversAfterProcessCrash(t *testing.T) {
	dir := t.TempDir()
	child := exec.Command(os.Args[0], "-test.run=^TestStateLockHolder$")
	child.Env = append(os.Environ(), "RELAY_TEST_STATE_LOCK="+dir)
	output, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	child.Stderr = os.Stderr
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })
	ready := make(chan bool, 1)
	go func() { ready <- bufio.NewScanner(output).Scan() }()
	select {
	case ok := <-ready:
		if !ok {
			t.Fatal("lock holder did not start")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("lock holder did not start")
	}
	if err = child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	db, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	value, err := db.Get("retained")
	if err != nil || !strings.Contains(string(value), `"status":"running"`) {
		t.Fatalf("existing task was not preserved: %s %v", value, err)
	}
}

func TestStateLockRecoveryHasOneWinner(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	child := exec.Command("/bin/sh", "-c", "exit 0")
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	pid := child.Process.Pid
	_ = child.Wait()
	if err = os.WriteFile(filepath.Join(dir, "server.lock"), []byte(strconv.Itoa(pid)), 0600); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	type result struct {
		db  *Store
		err error
	}
	results := make(chan result, 2)
	var group sync.WaitGroup
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			opened, err := Open(dir)
			results <- result{opened, err}
		}()
	}
	close(start)
	group.Wait()
	close(results)
	accepted := 0
	for result := range results {
		if result.err == nil {
			accepted++
			defer result.db.Close()
		}
	}
	if accepted != 1 {
		t.Fatalf("expected one owner, got %d", accepted)
	}
}

func TestStateLockDoesNotRemoveLiveInvalidOrSymlinkLocks(t *testing.T) {
	for _, kind := range []string{"live", "invalid", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			db, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			if err = db.Close(); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "server.lock")
			switch kind {
			case "live":
				err = os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())), 0600)
			case "invalid":
				err = os.WriteFile(path, []byte("not-a-pid"), 0600)
			case "symlink":
				target := filepath.Join(t.TempDir(), "target")
				if err = os.WriteFile(target, []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
				err = os.Symlink(target, path)
			}
			if err != nil {
				t.Fatal(err)
			}
			if opened, err := Open(dir); err == nil {
				_ = opened.Close()
				t.Fatal("unsafe lock was removed")
			}
			if _, err = os.Lstat(path); err != nil {
				t.Fatal("existing lock was removed")
			}
		})
	}
}

func TestStateRecoveryGuardRejectsSymlinksAndHardLinks(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			db, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			if err = db.Close(); err != nil {
				t.Fatal(err)
			}
			guard := filepath.Join(dir, "server.guard")
			if err = os.Remove(guard); err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(t.TempDir(), "target")
			if err = os.WriteFile(target, []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
			if kind == "symlink" {
				err = os.Symlink(target, guard)
			} else {
				err = os.Link(target, guard)
			}
			if err != nil {
				t.Fatal(err)
			}
			if opened, err := Open(dir); err == nil {
				_ = opened.Close()
				t.Fatal("unsafe recovery guard accepted")
			}
			if data, err := os.ReadFile(target); err != nil || string(data) != "preserve" {
				t.Fatal("recovery changed linked data")
			}
		})
	}
}
