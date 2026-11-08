import test from 'node:test';
import assert from 'node:assert/strict';
import { sideAnswerText } from '../public/side-answer.js';
import { MEMORY_CONTEXT_RULES, MEMORY_RULES } from '../server/memory.js';
import { sideStream } from '../server/side-stream.js';
import { sideChat } from '../public/side-chat.js';

test('side replies remove only the legacy empty metadata footer', () => {
  assert.equal(sideAnswerText('Useful answer.\n\nmemorySuggestions: []'), 'Useful answer.\n');
  assert.equal(sideAnswerText('memorySuggestions: []'), '');
  for (const answer of [
    'Explain memorySuggestions: [] in this sentence.',
    'Example:\n```yaml\nmemorySuggestions: []\n```',
    'memorySuggestions: []\nThis is an example.',
    'A streamed answer with trailing ',
    'memorySuggestions: [{"title":"An actual proposal"}]',
  ])
    assert.equal(sideAnswerText(answer), answer);
  assert.doesNotMatch(MEMORY_CONTEXT_RULES, /memorySuggestions|Use \[\]/);
  assert.match(MEMORY_RULES, /memorySuggestions/);
  assert.match(MEMORY_CONTEXT_RULES, /Current explicit user direction/);
});
test('legacy stored replies and streamed text keep metadata out of side chat', () => {
  const answer = 'Useful answer.\n\nmemorySuggestions: []';
  const html = sideChat(
    {
      sideQuestions: [
        {
          id: 'old',
          createdAt: new Date().toISOString(),
          stage: 'plan',
          question: 'Why?',
          status: 'complete',
          answer,
        },
      ],
    },
    true,
  );
  assert.match(html, /Useful answer/);
  assert.doesNotMatch(html, /memorySuggestions/);
  let progress;
  const stream = sideStream((update) => {
    progress = update;
  });
  stream.consume(
    JSON.stringify({
      type: 'assistant',
      message: { id: 'one', content: [{ type: 'text', text: answer }] },
    }),
  );
  assert.doesNotMatch(progress.answer, /memorySuggestions/);
});
