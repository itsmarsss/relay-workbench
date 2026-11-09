import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';

test('only the local embedded document allows same-origin framing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-deck-policy-'));
  const app = createApp({ directory, publicDirectory: resolve('public') });
  app.server.address = () => ({ port: 4310 });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (url, headers = {}) =>
    new Promise((resolveResponse) => {
      const response = {
        headers: {},
        statusCode: 200,
        headersSent: false,
        setHeader(name, value) {
          this.headers[name.toLowerCase()] = value;
        },
        writeHead(status, values) {
          this.statusCode = status;
          this.headersSent = true;
          for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
        },
        end(body) {
          resolveResponse({
            status: this.statusCode,
            headers: this.headers,
            body: String(body || ''),
          });
        },
      };
      app.server.emit(
        'request',
        { url, method: 'GET', headers: { host: '127.0.0.1:4310', ...headers } },
        response,
      );
    });
  const main = await request('/');
  assert.equal(main.status, 200);
  assert.equal(main.headers['x-frame-options'], 'DENY');
  assert.match(main.headers['content-security-policy'], /frame-ancestors 'none'/);
  const embedded = await request('/?embed=1');
  assert.equal(embedded.status, 200);
  assert.equal(embedded.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(embedded.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.match(embedded.body, /relay-style-nonce/);
  const otherAsset = await request('/styles.css?embed=1');
  assert.equal(otherAsset.headers['x-frame-options'], 'DENY');
  const external = await request('/?embed=1', { origin: 'https://example.com' });
  assert.equal(external.status, 403);
  assert.equal(external.headers['x-frame-options'], 'DENY');
});
