import test from 'node:test';
import assert from 'node:assert/strict';
import { draftRequest, jsonArray, jsonObject } from './forms.ts';
import { parseRoute } from './route.ts';
const config = {
  repositories: [
    {
      id: 'one',
      name: 'One',
      path: '/example',
      cwd: '.',
      strategy: 'worktree' as const,
      verificationMode: 'agent' as const,
      checks: [],
      setup: [],
      instructions: '',
    },
    {
      id: 'two',
      name: 'Two',
      path: '/example/two',
      cwd: '.',
      strategy: 'worktree' as const,
      verificationMode: 'agent' as const,
      checks: [],
      setup: [],
      instructions: '',
    },
  ],
};
test('drafts preserve selected repositories and reject injected privileged fields', () => {
  const base = {
    title: 'Task',
    description: 'Details',
    ticket: '',
    demo: false,
    repositories: ['one', 'two'],
    primary: 'two',
    preset: 'cross-repo',
    advanced: '{"dependencies":[{"repositoryId":"one","dependsOn":"two"}]}',
  };
  const result = draftRequest(base, config);
  assert.equal(result.repositoryId, 'two');
  assert.deepEqual(result.repositoryIds, ['one', 'two']);
  assert.throws(
    () => draftRequest({ ...base, advanced: '{"demo":true}' }, config),
    /Advanced options/,
  );
  assert.throws(() => draftRequest({ ...base, repositories: ['missing'] }, config), /changed/);
  assert.throws(() => draftRequest({ ...base, primary: 'missing' }, config), /primary/);
});
test('demo drafts do not accidentally select a real checkout', () => {
  const result = draftRequest(
    {
      title: 'Demo',
      description: '',
      ticket: '',
      demo: true,
      repositories: ['one'],
      primary: 'one',
      preset: null,
      advanced: '{}',
    },
    config,
  );
  assert.deepEqual(result.repositoryIds, []);
  assert.equal('repositoryId' in result, false);
});
test('JSON form options reject arrays and invalid syntax', () => {
  assert.throws(() => jsonObject('[]'), /object/);
  assert.throws(() => jsonObject('{bad'), /valid JSON/);
  assert.throws(() => jsonArray('{}'), /array/);
});
test('task routes retain selected tab and reject malformed IDs', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  assert.deepEqual(parseRoute(`#task/${id}/terminals`), { kind: 'task', id, tab: 'terminals' });
  assert.deepEqual(parseRoute(`#task/${id}/unknown`), { kind: 'task', id, tab: 'overview' });
  assert.deepEqual(parseRoute('#task/not-a-task/diff'), { kind: 'deck' });
  assert.deepEqual(parseRoute('#repositories'), { kind: 'repositories' });
});
