import test from 'node:test';
import assert from 'node:assert/strict';
import { githubInvocation, readGithub } from '../server/side-provider.js';
import { createInspector } from '../server/side-inspection.js';

test('GitHub inspection builds fixed read commands with literal arguments', () => {
  for (const operation of ['issue', 'pull_request', 'diff', 'checks']) {
    const request = githubInvocation({
      repositoryId: 'one',
      operation,
      repository: 'team/service',
      number: 42,
    });
    assert.ok(request.args.includes('42'));
    assert.ok(request.args.includes('team/service'));
    assert.ok(
      !request.args.some((arg) => ['create', 'edit', 'merge', 'comment', 'review'].includes(arg)),
    );
  }
  const search = githubInvocation({
    repositoryId: 'one',
    operation: 'search_prs',
    query: '$(touch injected) --web',
  });
  assert.deepEqual(search.args.slice(-2), ['--', '$(touch injected) --web']);
  const rest = githubInvocation({
    repositoryId: 'one',
    operation: 'api_get',
    endpoint: 'repos/team/service/commits/abc1234/pulls?per_page=20',
  });
  assert.deepEqual(rest.args.slice(0, 3), ['api', '--method', 'GET']);
  const query =
    'query($name: String!) { repository(owner:"team", name:$name) { issues(first:10) { totalCount } } }';
  const graphql = githubInvocation({
    repositoryId: 'one',
    operation: 'graphql',
    query,
    variables: { name: 'service' },
  });
  assert.deepEqual(JSON.parse(graphql.input), { query, variables: { name: 'service' } });
  assert.deepEqual(graphql.args, ['api', 'graphql', '--input', '-']);
});
test('GitHub inspection rejects writes, extra flags, host injection and GraphQL mutations', () => {
  for (const operation of ['create', 'comment', 'edit', 'merge', 'approve', 'auth', 'api', 'exec'])
    assert.throws(() => githubInvocation({ repositoryId: 'one', operation }));
  assert.throws(() =>
    githubInvocation({ operation: 'issue', number: 42, repository: '--hostname=elsewhere' }),
  );
  assert.throws(() => githubInvocation({ operation: 'issue', number: -1 }));
  assert.throws(() =>
    githubInvocation({ operation: 'api_get', endpoint: 'repos/team/service', method: 'POST' }),
  );
  for (const endpoint of [
    'https://elsewhere/api',
    '//elsewhere/path',
    'graphql?query=mutation',
    'gr%61phql',
    'repos/../graphql',
    'repos/%2e%2e/graphql',
    '--method=POST',
  ])
    assert.throws(() => githubInvocation({ operation: 'api_get', endpoint }));
  for (const query of [
    'mutation { deleteIssue(input:{id:"x"}) { clientMutationId } }',
    'query { viewer { login } } mutation { deleteIssue(input:{id:"x"}) { clientMutationId } }',
    '# query\nmutation { x }',
    'subscription { x }',
  ])
    assert.throws(() => githubInvocation({ operation: 'graphql', query }));
  assert.ok(
    githubInvocation({
      operation: 'graphql',
      query: 'query { search(query:"mutation fixes", type:ISSUE, first:1) { issueCount } }',
    }),
  );
});
test('GitHub reads preserve failed and pending check states without masking authentication failures', async () => {
  for (const code of [1, 8]) {
    const result = await readGithub(
      { operation: 'checks', repository: 'team/service', number: 42 },
      '/tmp',
      async (command, args, options) => {
        assert.equal(command, 'gh');
        assert.equal(options.env.GH_PROMPT_DISABLED, '1');
        assert.ok(!Object.hasOwn(options.env, 'GH_TOKEN'));
        return { code, stdout: '[{"state":"PENDING"}]', stderr: '' };
      },
    );
    assert.equal(result.exitCode, code);
  }
  await assert.rejects(
    readGithub({ operation: 'checks', number: 42 }, '/tmp', async () => ({
      code: 1,
      stdout: '',
      stderr: 'Authentication unavailable',
    })),
    /Authentication unavailable/,
  );
  const inspect = createInspector([{ id: 'draft', workspace: null }]);
  await assert.rejects(
    inspect('read_file', { repositoryId: 'draft', path: 'source.txt' }),
    /No prepared worktree/,
  );
  await assert.rejects(
    inspect('github_read', { repositoryId: 'unknown', operation: 'api_get', endpoint: 'user' }),
    /Unknown task repository/,
  );
  await assert.rejects(
    inspect('github_read', { repositoryId: 'draft', operation: 'issue', number: 42 }),
    /Specify OWNER\/REPO/,
  );
});
