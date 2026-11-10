package publication

import "testing"

func TestPublicationFollowsCrossRepositoryDependencies(t *testing.T) {
	task := map[string]any{"preset": "cross-repo", "repository": map[string]any{"id": "one"}, "repositories": []any{map[string]any{"repository": map[string]any{"id": "one", "name": "First"}}, map[string]any{"repository": map[string]any{"id": "two", "name": "Second"}}}, "dependencies": []any{map[string]any{"repositoryId": "two", "dependsOn": "one"}}}
	if err := Prerequisites(task, "two"); err == nil {
		t.Fatal("unpublished prerequisite was ignored")
	}
	first := object(array(task["repositories"])[0])
	first["publication"] = map[string]any{"state": "open", "url": "https://code.example/team/one/pull/1"}
	if err := Prerequisites(task, "two"); err != nil {
		t.Fatal(err)
	}
	first["publication"] = map[string]any{"state": "closed", "url": "https://code.example/team/one/pull/1"}
	if err := Prerequisites(task, "two"); err == nil {
		t.Fatal("closed prerequisite accepted")
	}
	first["publication"] = map[string]any{"state": "merged", "url": "javascript:alert(1)"}
	if err := Prerequisites(task, "two"); err == nil {
		t.Fatal("unsafe prerequisite URL accepted")
	}
}
