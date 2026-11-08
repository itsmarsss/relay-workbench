// Metadata only: never send a prompt, start a thread, or run an agent turn.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const { provider, command } = JSON.parse(process.argv[2]);
const args =
  provider === 'codex'
    ? ['app-server', '--listen', 'stdio://']
    : provider === 'claude'
      ? [
          '--print',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--no-session-persistence',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--setting-sources',
          'user',
        ]
      : ['--mode', 'rpc', '--no-session'];
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
let done = false,
  bytes = 0,
  models = [],
  cursor = null,
  page = 0;
function finish(error) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  const safeModels = (Array.isArray(models) ? models : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) =>
      Object.fromEntries(
        [
          'id',
          'model',
          'value',
          'provider',
          'displayName',
          'display_name',
          'name',
          'resolvedModel',
          'hidden',
          'supportedEffortLevels',
          'supportedReasoningEfforts',
        ]
          .filter((key) => Object.hasOwn(item, key))
          .map((key) => [key, item[key]]),
      ),
    );
  console.log(JSON.stringify(error ? { error } : { models: safeModels }));
  child.stdin.end();
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
  kill.unref();
}
const send = (value) => {
  if (!done) child.stdin.write(JSON.stringify(value) + '\n');
};
const timer = setTimeout(
  () => finish('Model discovery timed out. Retry or enter a custom model.'),
  18000,
);
child.on('error', (error) =>
  finish(error.code === 'ENOENT' ? 'CLI not found' : 'Could not start model discovery'),
);
child.on('close', () => {
  if (!done) finish('CLI closed before reporting models');
});
child.stdin.on('error', () => {
  if (!done) finish('CLI closed the metadata connection');
});
child.stderr.on('data', (chunk) => {
  bytes += chunk.length;
  if (bytes > 2e6) finish('Model discovery output limit reached');
});
createInterface({ input: child.stdout }).on('line', (line) => {
  bytes += Buffer.byteLength(line);
  if (bytes > 2e6) return finish('Model discovery output limit reached');
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (!event || typeof event !== 'object') return;
  if (provider === 'codex') {
    if (event.error) return finish('CLI could not list models. Check provider sign-in and retry.');
    if (event.id === 'initialize') {
      send({ method: 'initialized' });
      send({ id: 'models', method: 'model/list', params: { limit: 100, includeHidden: false } });
    } else if (event.id === 'models') {
      if (!Array.isArray(event.result?.data)) return finish('CLI returned an invalid model list');
      models.push(...event.result.data);
      const next = event.result?.nextCursor;
      if (next && next !== cursor && ++page < 20) {
        cursor = next;
        send({
          id: 'models',
          method: 'model/list',
          params: { limit: 100, includeHidden: false, cursor },
        });
      } else finish();
    }
  } else if (
    provider === 'claude' &&
    event.type === 'control_response' &&
    event.response?.request_id === 'models'
  ) {
    if (event.response.subtype === 'error')
      return finish('Claude could not report its model catalog');
    models = event.response.response?.models ?? [];
    finish();
  } else if (provider === 'pi' && event.type === 'response' && event.id === 'models') {
    if (event.success === false) return finish('Pi could not report its model catalog');
    models = event.data?.models ?? [];
    finish();
  }
});
if (provider === 'codex')
  send({
    id: 'initialize',
    method: 'initialize',
    params: { clientInfo: { name: 'relay-model-picker', version: '0.1.0' } },
  });
else if (provider === 'claude')
  send({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } });
else send({ id: 'models', type: 'get_available_models' });
