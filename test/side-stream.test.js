import test from 'node:test';
import assert from 'node:assert/strict';
import { sideStream } from '../server/side-stream.js';

test('side stream exposes public text and tool lifecycle without duplicate assistant text', () => {
  const updates = [];
  const stream = sideStream((update) => updates.push(update));
  const send = (event) => stream.consume(JSON.stringify(event));
  const delta = (event) => send({ type: 'stream_event', event });
  delta({ type: 'message_start', message: { id: 'one' } });
  delta({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  delta({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Checking history.' },
  });
  assert.equal(updates.at(-1).answer, 'Checking history.');
  delta({
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'tool_use',
      id: 'call',
      name: 'mcp__relay_source__git_inspect',
      input: {},
    },
  });
  delta({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"repositoryId":"one","operation":"log"}' },
  });
  delta({ type: 'content_block_stop', index: 1 });
  assert.equal(updates.at(-1).toolCalls[0].input.operation, 'log');
  send({
    type: 'assistant',
    message: {
      id: 'one',
      content: [
        { type: 'text', text: 'Checking history.' },
        {
          type: 'tool_use',
          id: 'call',
          name: 'mcp__relay_source__git_inspect',
          input: { repositoryId: 'one', operation: 'log' },
        },
      ],
    },
  });
  assert.equal(updates.at(-1).answer, 'Checking history.');
  assert.equal(updates.at(-1).toolCalls.length, 1);
  send({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'call', content: 'Observed commit', is_error: false },
      ],
    },
  });
  assert.equal(updates.at(-1).toolCalls[0].status, 'complete');
  assert.equal(updates.at(-1).toolCalls[0].output, 'Observed commit');
  delta({ type: 'message_start', message: { id: 'two' } });
  delta({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: 'private reasoning' },
  });
  delta({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'private reasoning' },
  });
  send({
    type: 'assistant',
    message: { id: 'two', content: [{ type: 'text', text: 'Here is the result.' }] },
  });
  assert.equal(updates.at(-1).answer, 'Checking history.\n\nHere is the result.');
  assert.doesNotMatch(JSON.stringify(updates), /private reasoning/);
  send({ type: 'result', result: 'Final answer', is_error: false });
  assert.equal(stream.result().result, 'Final answer');
});
test('side stream preserves failed tool evidence and requires a real final result', () => {
  let update;
  const stream = sideStream((value) => {
    update = value;
  });
  stream.consume('wrapper startup message');
  stream.consume(
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'one',
        content: [
          {
            type: 'tool_use',
            id: 'bad',
            name: 'mcp__relay_source__read_file',
            input: { path: 'missing' },
          },
        ],
      },
    }),
  );
  stream.consume(
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'bad',
            is_error: true,
            content: 'Unavailable'.repeat(1000),
          },
        ],
      },
    }),
  );
  assert.equal(update.toolCalls[0].status, 'failed');
  assert.equal(update.toolCalls[0].output.length, 4000);
  assert.equal(stream.result(), undefined);
});
