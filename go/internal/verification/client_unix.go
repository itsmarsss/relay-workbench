//go:build darwin || linux

package verification

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"time"
)

// RunClient is the agent-facing helper. It forwards literal argv to the
// parent-owned runner and propagates the actual command exit code.
func RunClient(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("relay-check", flag.ContinueOnError)
	flags.SetOutput(stderr)
	socket := flags.String("socket", "", "Relay verification socket")
	token := flags.String("token", "", "Relay verification session token")
	repository := flags.String("repository", "", "Task repository ID")
	cwd := flags.String("cwd", "", "Working directory inside the repository")
	purpose := flags.String("purpose", "verification", "verification or diagnostic")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	command := flags.Args()
	if *socket == "" || *token == "" || *repository == "" || len(command) == 0 {
		fmt.Fprintln(stderr, "A verification session, repository and command are required")
		return 2
	}
	if *cwd == "" {
		var err error
		*cwd, err = os.Getwd()
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}
	conn, err := net.DialTimeout("unix", *socket, 5*time.Second)
	if err != nil {
		fmt.Fprintf(stderr, "Could not connect to Relay verification: %v\n", err)
		return 1
	}
	defer conn.Close()
	request := CheckRequest{Token: *token, RepositoryID: *repository, Cwd: *cwd, Command: command[0], Args: append([]string{}, command[1:]...), Purpose: *purpose}
	if err = json.NewEncoder(conn).Encode(request); err != nil {
		fmt.Fprintf(stderr, "Could not send check: %v\n", err)
		return 1
	}
	decoder := json.NewDecoder(conn)
	for {
		var frame checkFrame
		if err = decoder.Decode(&frame); err != nil {
			fmt.Fprintf(stderr, "Relay verification ended before reporting a result: %v\n", err)
			return 1
		}
		switch frame.Type {
		case "line":
			output := stdout
			if frame.Stream == "stderr" {
				output = stderr
			}
			fmt.Fprintln(output, frame.Text)
		case "error":
			fmt.Fprintln(stderr, frame.Error)
			return 1
		case "result":
			fmt.Fprintf(stdout, "Relay supervised check exited %d.\n", frame.Code)
			if frame.Code < 0 || frame.Code > 255 {
				return 1
			}
			return frame.Code
		default:
			fmt.Fprintln(stderr, "Relay verification returned an invalid response")
			return 1
		}
	}
}
