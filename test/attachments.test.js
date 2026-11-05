import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectImage } from '../server/attachments.js';

test('image headers support PNG, GIF, JPEG, and WebP dimension formats', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNHkAAAAASUVORK5CYII=',
    'base64',
  );
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 3, 0, 4, 1, 1, 0x11, 0, 0xff, 0xd9,
  ]);
  assert.equal(inspectImage(png, 'image/png').width, 1);
  assert.equal(inspectImage(gif, 'image/gif').height, 1);
  assert.equal(inspectImage(jpeg, 'image/jpeg').width, 4);
  for (const kind of ['VP8X', 'VP8L', 'VP8 ']) {
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0);
    webp.writeUInt32LE(22, 4);
    webp.write('WEBP', 8);
    webp.write(kind, 12);
    webp.writeUInt32LE(10, 16);
    if (kind === 'VP8X') {
      webp.writeUIntLE(3, 24, 3);
      webp.writeUIntLE(2, 27, 3);
    }
    if (kind === 'VP8L') {
      webp[20] = 0x2f;
      webp.writeUInt32LE(3 + (2 << 14), 21);
    }
    if (kind === 'VP8 ') {
      webp.set([0x9d, 1, 0x2a], 23);
      webp.writeUInt16LE(4, 26);
      webp.writeUInt16LE(3, 28);
    }
    const info = inspectImage(webp, 'image/webp');
    assert.equal(info.width, 4);
    assert.equal(info.height, 3);
  }
  for (const type of ['image/png', 'image/gif', 'image/jpeg', 'image/webp']) {
    assert.throws(() => inspectImage(Buffer.from('not an image'), type), /invalid image header/);
    assert.throws(() => inspectImage(Buffer.alloc(0), type), /between 1 byte/);
  }
  const huge = Buffer.from(png);
  huge.writeUInt32BE(6000, 16);
  huge.writeUInt32BE(6000, 20);
  assert.throws(() => inspectImage(huge, 'image/png'), /25 megapixels/);
  const zero = Buffer.from(png);
  zero.writeUInt32BE(0, 16);
  assert.throws(() => inspectImage(zero, 'image/png'), /invalid image header/);
});

test('agent context resolves local images and reports missing attachments', async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { attachmentContext } = await import('../server/attachments.js');
  const directory = await mkdtemp(join(tmpdir(), 'relay-images-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'attachments'));
  const filename = '00000000-0000-0000-0000-000000000000.png';
  await writeFile(
    join(directory, 'attachments', filename),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNHkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const url = '/api/attachments/' + filename;
  const missing = '/api/attachments/11111111-1111-1111-1111-111111111111.png';
  const context = await attachmentContext(
    {
      description: `![Expected](${url})`,
      messages: [{ text: `Repeated ${url} and missing ${missing}` }],
      repository: { instructions: 'No extra images.' },
    },
    directory,
  );
  assert.equal(context.length, 2);
  assert.equal(context[0].path, join(directory, 'attachments', filename));
  assert.equal(context[0].type, 'image/png');
  assert.match(context[1].error, /missing or invalid/);
  const { buildPrompt } = await import('../server/harness.js');
  const { newTask, DEFAULT_CONFIG } = await import('../server/domain.js');
  const task = newTask({ title: 'Use screenshot', demo: true }, DEFAULT_CONFIG);
  const prompt = buildPrompt({ ...task, imageAttachments: context }, 'investigate');
  assert.ok(prompt.includes(context[0].path));
  assert.match(prompt, /never infer its contents/);
  assert.equal(
    (
      await attachmentContext(
        { description: '![External](https://example.com/picture.png)' },
        directory,
      )
    ).length,
    0,
  );
});
