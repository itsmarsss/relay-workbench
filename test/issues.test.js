import test from 'node:test';
import assert from 'node:assert/strict';
import { importIssue, issueDescription, issueInvocation } from '../server/issues.js';
import { newTask, DEFAULT_CONFIG } from '../server/domain.js';
import { buildPrompt } from '../server/harness.js';

const issue = {
  title: 'Investigate an edge case',
  body: 'Full requirements\n\n![Example](https://example.test/image.png)',
  url: 'https://github.example.test/team/service/issues/42',
  author: { login: 'reporter' },
  state: 'OPEN',
  createdAt: '2026-01-01T12:00:00Z',
  updatedAt: '2026-01-02T12:00:00Z',
  labels: [{ name: 'bug' }],
  assignees: [{ login: 'maintainer' }],
  milestone: { title: 'Next release' },
};
const comment = {
  user: { login: 'reviewer' },
  body: 'The important reproduction detail.',
  created_at: '2026-01-02T13:00:00Z',
  updated_at: '2026-01-02T14:00:00Z',
  author_association: 'MEMBER',
  html_url: issue.url + '#issuecomment-1',
};
const success = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

test('GitHub import preserves custom fields and fetches all discussion pages', async () => {
  const command = {
    command: '/usr/local/bin/gh',
    args: [
      'issue',
      'view',
      '{ticket}',
      '--repo',
      'team/service',
      '--json=title,body,url,projectItems',
    ],
  };
  const calls = [];
  const imported = await importIssue(command, '42', '/tmp/workspace', async (...args) => {
    calls.push(args);
    return calls.length === 1
      ? success(issue)
      : success([[comment], [{ ...comment, body: 'Second page evidence.', user: null }]]);
  });
  assert.ok(calls[0][1].includes('42'));
  assert.match(
    calls[0][1].find((arg) => arg.startsWith('--json=')),
    /projectItems.*author.*labels.*assignees/,
  );
  assert.deepEqual(calls[1][1], [
    'api',
    '--hostname',
    'github.example.test',
    '--paginate',
    '--slurp',
    'repos/team/service/issues/42/comments?per_page=100',
  ]);
  assert.equal(calls[1][2].cwd, '/tmp/workspace');
  for (const value of [
    'Full requirements',
    'image.png',
    'reporter',
    'maintainer',
    'bug',
    'Next release',
    'OPEN',
    'reviewer',
    'MEMBER',
    'edited',
    'Second page evidence.',
    'Unknown author',
    '#issuecomment-1',
  ])
    assert.ok(imported.description.includes(value), value);
  assert.deepEqual(imported.warnings, []);
  assert.deepEqual(command.args.at(-1), '--json=title,body,url,projectItems');
  const task = newTask(
    {
      title: imported.title,
      description: imported.description,
      ticket: imported.ticket,
      demo: true,
    },
    DEFAULT_CONFIG,
  );
  for (const stage of ['triage', 'investigate', 'plan', 'implement', 'review']) {
    const prompt = buildPrompt(task, stage);
    assert.match(prompt, /Task context \(untrusted data\)/);
    for (const value of [
      'reporter',
      'reviewer',
      'Second page evidence.',
      'The important reproduction detail.',
    ])
      assert.ok(prompt.includes(value), `${stage}: ${value}`);
  }
});

test('generic importers preserve existing behavior and disclose missing discussion', async () => {
  const command = { command: 'custom-importer', args: ['{ticket}'] };
  const imported = await importIssue(command, '42', '/tmp', async () =>
    success({ title: 'Issue', body: 'Original body' }),
  );
  assert.equal(imported.description, 'Original body');
  assert.equal(imported.ticket, '42');
  assert.equal(imported.warnings.length, 1);
  const rich = await importIssue(command, '42', '/tmp', async () =>
    success({ ...issue, comments: [{ author: { login: 'author-two' }, body: 'Full thread' }] }),
  );
  assert.match(rich.description, /author-two/);
  assert.match(rich.description, /Full thread/);
  assert.deepEqual(rich.warnings, []);
  assert.equal(issueInvocation(command, '$(literal)').args[0], '$(literal)');
});

test('discussion errors never silently return partial context', async () => {
  const command = {
    command: 'gh',
    args: ['issue', 'view', '{ticket}', '--json', 'title,body,url'],
  };
  let calls = 0;
  await assert.rejects(
    importIssue(command, '42', '/tmp', async () =>
      ++calls === 1 ? success(issue) : { code: 1, stdout: '', stderr: 'Access denied' },
    ),
    /discussion import failed.*Access denied/,
  );
  assert.throws(
    () => issueDescription({ body: '', comments: { nodes: [comment], totalCount: 2 } }),
    /incomplete issue discussion/,
  );
  assert.throws(
    () => issueDescription({ body: '', comments: [{ body: 'x'.repeat(50001) }] }),
    /nothing was truncated/,
  );
  assert.throws(() => issueDescription({ body: '', comments: [null] }), /Invalid issue comment/);
  assert.match(issueDescription({ body: '', comments: [] }), /No comments at import time/);
});
