import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createApp } from './app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(process.env.RELAY_DATA_DIR || resolve(root, '.relay'));
const port = Number(process.env.RELAY_PORT || 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RELAY_PORT must be a valid port');
const app = createApp({ directory, publicDirectory: resolve(root, 'public') });
app.server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`\n  Relay is ready → http://127.0.0.1:${port}\n  State: ${directory}\n\n`);
});
app.server.on('error', async error => { process.stderr.write(`Relay could not start: ${error.message}\n`); await app.close(); process.exitCode = 1; });
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return; closing = true;
  await app.close(); process.exit(0);
});
