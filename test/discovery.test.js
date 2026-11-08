import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverRepositories } from '../server/repository-discovery.js';
import { ModelCatalog, normalizeModels } from '../server/model-catalog.js';
import { runProcess } from '../server/process.js';
import { modelPicker } from '../public/model-picker.js';

test('discovery finds checkouts and worktrees without traversing dependencies or links', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'relay-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['service/.git', 'node_modules/hidden/.git', '.hidden/.git', 'nested/tree'])
    await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, 'nested/tree/.git'), 'gitdir: /example/metadata');
  await symlink(root, join(root, 'cycle'));
  const result = await discoverRepositories([{ path: join(root, 'service') }], { root });
  assert.deepEqual(
    result.repositories.map((r) => [r.name, r.configured]),
    [
      ['service', true],
      ['tree', false],
    ],
  );
  assert.equal(result.truncated, false);
  const bounded = await discoverRepositories([], { root, maxDirectories: 1 });
  assert.equal(bounded.truncated, true);
  await assert.rejects(discoverRepositories([], { root: 'relative' }), /absolute/);
  assert.equal(
    (await discoverRepositories([], { root: join(root, 'missing') })).warnings.length,
    1,
  );
});

test('model catalogs normalize IDs and malformed metadata', () => {
  assert.deepEqual(
    normalizeModels('pi', [
      { provider: 'example', id: 'fast', name: 'Fast' },
      null,
      { id: 'secret', hidden: true },
    ]),
    [{ id: 'example/fast', name: 'Fast', efforts: [] }],
  );
  assert.deepEqual(
    normalizeModels('codex', [
      { model: 'deep', supportedReasoningEfforts: [null, { reasoningEffort: 'high' }] },
    ])[0].efforts,
    ['high'],
  );
  assert.deepEqual(
    normalizeModels('claude', [{ value: 'fast', supportedEffortLevels: 'invalid' }])[0].efforts,
    [],
  );
});

test('catalog deduplicates probes, caches, and preserves models on refresh failure', async () => {
  let calls = 0,
    fail = false;
  const catalog = new ModelCatalog({
    run: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      if (fail) throw Error('not available');
      return { code: 0, stdout: JSON.stringify({ models: [{ model: 'example-model' }] }) };
    },
  });
  const config = { command: 'example-agent' };
  const values = await Promise.all([
    catalog.provider('codex', config),
    catalog.provider('codex', config),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(values[0], values[1]);
  await catalog.provider('codex', config);
  assert.equal(calls, 1);
  fail = true;
  const stale = await catalog.provider('codex', config, true);
  assert.equal(stale.status, 'unavailable');
  assert.equal(stale.models[0].id, 'example-model');
  await catalog.stop();
});

test('catalog shutdown aborts pending discovery', async () => {
  let started;
  const ready = new Promise((r) => {
    started = r;
  });
  const catalog = new ModelCatalog({
    run: async (command, args, { signal }) => {
      started();
      await new Promise((resolve, reject) => {
        if (signal.aborted) reject(Error('aborted'));
        else signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
      });
    },
  });
  const pending = catalog.provider('codex', { command: 'example' });
  await ready;
  await catalog.stop();
  assert.equal((await pending).status, 'unavailable');
});

test('provider probes request only metadata and strip unrelated fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'relay-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const provider of ['codex', 'claude', 'pi']) {
    const command = join(root, provider);
    await writeFile(
      command,
      `#!${process.execPath}
import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
const msg=JSON.parse(line);
const models=[{id:'example-fast',model:'example-fast',name:'Example Fast',credential:'never expose'}];
if(msg.method==='initialize') console.log(JSON.stringify({id:'initialize',result:{}}));
else if(msg.method==='model/list') console.log(JSON.stringify({id:'models',result:{data:models}}));
else if(msg.type==='control_request' && msg.request.subtype==='initialize') console.log(JSON.stringify({type:'control_response',response:{request_id:'models',response:{models}}}));
else if(msg.type==='get_available_models') console.log(JSON.stringify({type:'response',id:'models',data:{models}}));
else if(msg.method!=='initialized') process.exit(2);
});`,
      { mode: 0o755 },
    );
    const result = await runProcess(
      process.execPath,
      ['server/model-probe.js', JSON.stringify({ provider, command })],
      { timeout: 5000 },
    );
    assert.equal(result.code, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.models[0].id, 'example-fast');
    assert.equal(data.models[0].credential, undefined);
  }
});

test('picker merges discovered models and saved custom overrides safely', () => {
  const html = modelPicker({
    provider: 'codex',
    value: 'custom',
    catalog: { codex: { models: [{ id: 'fast', name: '<Fast>' }] } },
  });
  assert.match(html, /data-allow-custom/);
  assert.match(html, /&lt;Fast&gt;/);
  assert.match(html, /value="custom" selected/);
});
