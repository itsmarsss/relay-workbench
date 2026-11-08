// Older side prompts appended workflow metadata to otherwise conversational replies.
// Only remove the known empty footer, not prose or fenced examples discussing it.
export function sideAnswerText(value) {
  return String(value ?? '').replace(
    /(?:^|\r?\n)[ \t]*memorySuggestions:[ \t]*\[[ \t]*\][ \t]*(?:\r?\n)?$/,
    '',
  );
}
