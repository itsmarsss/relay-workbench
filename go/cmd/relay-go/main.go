// relay-go is an isolated migration preview. It is not a replacement
// for the legacy server and must not use the running instance's state.
package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"relay.local/relay/internal/httpapi"
	"relay.local/relay/internal/process"
	"relay.local/relay/internal/store"
)

func run(args []string) (result error) {
	flags := flag.NewFlagSet("relay-go", flag.ContinueOnError)
	dir := flags.String("data-dir", "", "Required: new isolated experimental state directory")
	web := flags.String("web-dir", "", "Required: built React preview directory")
	port := flags.Int("port", 4311, "Local preview port")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
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
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	log.Printf("Experimental Relay preview at http://127.0.0.1:%d", *port)
	select {
	case <-signals:
		ctx, cancel := httpapi.ShutdownTimeout()
		defer cancel()
		if err = server.Shutdown(ctx); err != nil {
			_ = server.Close()
			log.Printf("Shutdown: %v", err)
		}
		err = <-done
	case err = <-done:
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
func main() {
	if len(os.Args) > 1 && os.Args[1] == "--internal-worker" {
		os.Exit(process.Worker(os.Args[2:]))
	}
	if err := run(os.Args[1:]); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
