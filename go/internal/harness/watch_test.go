package harness

import "testing"

// A task paused after Relay published its pull request can still have that pull request watched.
func TestPullRequestChecksCoverPublishedAndLinkedPullRequests(t *testing.T) {
	repo := map[string]any{"id": "r"}
	published := map[string]any{"status": "paused", "repository": repo, "publication": map[string]any{"url": "https://code.example/pull/1"}}
	linked := map[string]any{"status": "paused", "repository": repo, "pullRequestLink": map[string]any{"url": "https://code.example/pull/2"}}
	none := map[string]any{"status": "paused", "repository": repo}
	if !hasPullRequest(published, "r") || !hasPullRequest(linked, "r") || hasPullRequest(none, "r") || hasPullRequest(published, "other") {
		t.Fatal("pull request detection is wrong")
	}
}
