// relay-go serves the standalone rewrite. Keep its state and active repositories
// separate from any running legacy instance while evaluating migration.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"relay.local/relay/internal/transfer"
	"syscall"
	"time"

	"relay.local/relay/internal/assistant"
	"relay.local/relay/internal/httpapi"
	"relay.local/relay/internal/process"
	"relay.local/relay/internal/selfupdate"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/terminal"
	"relay.local/relay/internal/verification"
	"relay.local/relay/internal/workflow"
)

func run(args []string) (result error) {
	flags := flag.NewFlagSet("relay-go", flag.ContinueOnError)
	dir := flags.String("data-dir", "", "Required: new isolated experimental state directory")
	web := flags.String("web-dir", "", "Required: built React preview directory")
	exportPath := flags.String("export-state", "", "Export isolated state to a new .tar.gz file and exit")
	legacyPath := flags.String("export-legacy", "", "Export a stopped legacy state directory without modifying it")
	importPath := flags.String("import-state", "", "Import an archive into an absent --data-dir and exit")
	port := flags.Int("port", 4311, "Local preview port")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if *importPath != "" {
		if *dir == "" || *exportPath != "" || *legacyPath != "" {
			return errors.New("import requires only --data-dir and --import-state")
		}
		input, err := os.Open(*importPath)
		if err != nil {
			return err
		}
		defer input.Close()
		info, err := input.Stat()
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("import archive must be a regular file")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		return transfer.Restore(ctx, io.LimitReader(input, transfer.MaxBytes+1), *dir)
	}
	if *exportPath != "" {
		output, err := os.OpenFile(*exportPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		succeeded := false
		defer func() {
			output.Close()
			if !succeeded {
				os.Remove(*exportPath)
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if *legacyPath != "" {
			err = transfer.ExportLegacy(ctx, *legacyPath, output)
		} else {
			if *dir == "" {
				return errors.New("export requires --data-dir or --export-legacy")
			}
			db, e := store.Open(*dir)
			if e != nil {
				return e
			}
			err = transfer.Export(ctx, db, output)
			err = errors.Join(err, db.Close())
		}
		if err != nil {
			return err
		}
		if err = output.Sync(); err != nil {
			return err
		}
		if err = output.Close(); err != nil {
			return err
		}
		succeeded = true
		return nil
	}
	if *legacyPath != "" {
		return errors.New("--export-legacy also requires --export-state")
	}
	if *dir == "" || *web == "" {
		return errors.New("--data-dir and --web-dir are required; never use live Relay state")
	}
	db, err := store.Open(*dir)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, db.Close()) }()
	handler, err := httpapi.New(db, *port, *web)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		return err
	}
	defer listener.Close()
	worker, err := os.Executable()
	if err != nil {
		return err
	}
	coordinator, err := workflow.NewCoordinator(db, worker, []string{"--internal-worker"}, nil)
	if err != nil {
		return err
	}
	defer coordinator.Close()
	coordinator.EnableTerminals()
	chats, err := assistant.New(db, worker, []string{"--internal-worker"}, nil, coordinator)
	if err != nil {
		return err
	}
	defer chats.Close()
	handler.SetAssistant(chats)
	handler.SetCoordinator(coordinator)
	// Running from a clone of Relay's repository: keep it current with commits that passed CI.
	restart := make(chan struct{}, 1)
	updater := &selfupdate.Updater{Binary: worker, Store: db, Busy: func() bool {
		running, _ := coordinator.Workload()
		return running > 0 || chats.Active() > 0
	}, Restart: func() {
		select {
		case restart <- struct{}{}:
		default:
		}
	}}
	if root, ok := selfupdate.Locate(worker); ok {
		updater.Root = root
	}
	handler.SetUpdater(updater)
	updates, stopUpdates := context.WithCancel(context.Background())
	defer stopUpdates()
	go updater.Loop(updates)
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	log.Printf("Experimental Relay preview at http://127.0.0.1:%d", *port)
	stop := func() {
		ctx, cancel := httpapi.ShutdownTimeout()
		defer cancel()
		if err = server.Shutdown(ctx); err != nil {
			_ = server.Close()
			log.Printf("Shutdown: %v", err)
		}
		err = <-done
	}
	select {
	case <-signals:
		stop()
	case <-restart:
		log.Printf("Restarting into an update")
		restartRequested = true
		stop()
	case err = <-done:
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// restartRequested is set when an update is installed: once everything has shut down cleanly,
// the process replaces itself with the new build, keeping its arguments and environment.
var restartRequested bool

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--internal-terminal-worker" {
		os.Exit(terminal.Worker(os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "--internal-terminal-pane" {
		os.Exit(terminal.Pane(os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "--internal-assistant-mcp" {
		os.Exit(assistant.MCPClient(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	if len(os.Args) > 1 && os.Args[1] == "--internal-worker" {
		os.Exit(process.Worker(os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "--internal-check" {
		os.Exit(verification.RunClient(os.Args[2:], os.Stdout, os.Stderr))
	}
	if err := run(os.Args[1:]); err != nil {
		log.Print(err)
		os.Exit(1)
	}
	if restartRequested {
		binary, err := os.Executable()
		if err == nil {
			err = syscall.Exec(binary, os.Args, os.Environ())
		}
		log.Printf("Could not restart into the update: %v", err)
		os.Exit(1)
	}
}
