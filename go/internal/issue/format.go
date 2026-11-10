package issue

import (
	"fmt"
	"math"
	"net/url"
	"strings"
	"unicode/utf16"
)

func object(value any) map[string]any { result, _ := value.(map[string]any); return result }
func text(value any) string           { result, _ := value.(string); return result }
func first(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}
func person(value any) string {
	if name, ok := value.(string); ok && name != "" {
		return name
	}
	item := object(value)
	if name := text(item["login"]); name != "" {
		return name
	}
	if name := text(item["name"]); name != "" {
		return name
	}
	return "Unknown author"
}
func markdown(value string) string {
	var result strings.Builder
	for _, character := range value {
		if character == '\r' || character == '\n' {
			result.WriteByte(' ')
			continue
		}
		if strings.ContainsRune("\\`*_{}[]<>#", character) {
			result.WriteByte('\\')
		}
		result.WriteRune(character)
	}
	return result.String()
}
func safeLink(value string) string {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || strings.ContainsAny(value, "\r\n\t ") {
		return ""
	}
	return strings.NewReplacer("(", "%28", ")", "%29").Replace(u.String())
}

// Description preserves the entire supplied discussion or returns an error.
// It does not interpret ticket text as instructions or shell commands.
func Description(issue map[string]any) (string, bool, error) {
	if issue == nil {
		return "", false, bad(502, "Invalid issue returned by importer")
	}
	bodyValue := first(issue["body"], issue["description"], "")
	body, ok := bodyValue.(string)
	if !ok {
		return "", false, bad(502, "Issue body must be a string")
	}
	body = strings.TrimSpace(body)
	metadata := []string{}
	if issue["author"] != nil {
		metadata = append(metadata, "Filed by: **"+markdown(person(issue["author"]))+"**")
	}
	for _, item := range []struct {
		label string
		value any
	}{{"Status", issue["state"]}, {"Created", first(issue["createdAt"], issue["created_at"])}, {"Updated", first(issue["updatedAt"], issue["updated_at"])}} {
		if value := text(item.value); value != "" {
			metadata = append(metadata, item.label+": "+markdown(value))
		}
	}
	for _, item := range []struct {
		label string
		value any
	}{{"Labels", issue["labels"]}, {"Assignees", issue["assignees"]}} {
		values, _ := item.value.([]any)
		if len(values) > 0 {
			names := make([]string, 0, len(values))
			for _, value := range values {
				names = append(names, markdown(person(value)))
			}
			metadata = append(metadata, item.label+": "+strings.Join(names, ", "))
		}
	}
	if issue["milestone"] != nil {
		value := issue["milestone"]
		if title := text(object(value)["title"]); title != "" {
			value = title
		}
		if title := text(value); title != "" {
			metadata = append(metadata, "Milestone: "+markdown(title))
		}
	}
	if len(metadata) > 0 {
		if link := safeLink(text(issue["url"])); link != "" {
			metadata = append([]string{"Source: " + link}, metadata...)
		}
	}
	var comments []any
	commentsIncluded := false
	if list, ok := issue["comments"].([]any); ok {
		comments, commentsIncluded = list, true
	} else if container := object(issue["comments"]); container != nil {
		list, ok := container["nodes"].([]any)
		if total, exists := container["totalCount"]; exists {
			count, valid := total.(float64)
			if !valid || math.IsNaN(count) || math.IsInf(count, 0) || count < 0 || math.Trunc(count) != count || !ok || count > float64(len(list)) {
				return "", false, bad(502, "Importer returned an incomplete issue discussion")
			}
		}
		comments, commentsIncluded = list, ok
	}
	parts := []string{body}
	if len(metadata) > 0 {
		parts = append(parts, "## Issue context\n\n- "+strings.Join(metadata, "\n- "))
	}
	if commentsIncluded {
		parts = append(parts, fmt.Sprintf("## Issue discussion (%d comments)", len(comments)))
		if len(comments) == 0 {
			parts = append(parts, "No comments at import time.")
		}
		for _, value := range comments {
			comment := object(value)
			if comment == nil {
				return "", false, bad(502, "Invalid issue comment returned by importer")
			}
			commentBody, ok := comment["body"].(string)
			if !ok {
				return "", false, bad(502, "Invalid issue comment returned by importer")
			}
			date, updated := text(first(comment["createdAt"], comment["created_at"])), text(first(comment["updatedAt"], comment["updated_at"]))
			attribution := []string{}
			if date != "" {
				attribution = append(attribution, markdown(date))
			}
			if updated != "" && updated != date {
				attribution = append(attribution, "edited "+markdown(updated))
			}
			if association := text(first(comment["authorAssociation"], comment["author_association"])); association != "" {
				attribution = append(attribution, markdown(association))
			}
			heading := "### " + markdown(person(first(comment["author"], comment["user"])))
			if len(attribution) > 0 {
				heading += " · " + strings.Join(attribution, " · ")
			}
			link := safeLink(text(first(comment["url"], comment["html_url"])))
			if link != "" {
				heading += "\n\n" + link
			}
			parts = append(parts, heading+"\n\n"+commentBody)
		}
	}
	description := strings.Join(parts, "\n\n")
	if len(utf16.Encode([]rune(description))) > 50000 {
		return "", false, bad(413, "Full issue context exceeds the 50,000-character task description limit; nothing was truncated")
	}
	return description, commentsIncluded, nil
}
