import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InputError, requireValue } from './domain.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_PATH =
  /^\/api\/attachments\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(?:png|jpg|gif|webp))$/;
const TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

export function inspectImage(bytes, type) {
  requireValue(TYPES.has(type), 'Use PNG, JPEG, GIF, or WebP images.', 415);
  requireValue(
    bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES,
    'Images must be between 1 byte and 10 MB.',
    413,
  );
  let width, height;
  if (
    type === 'image/png' &&
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes.readUInt32BE(8) === 13
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (
    type === 'image/gif' &&
    bytes.length >= 13 &&
    ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
  ) {
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
  } else if (type === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        length >= 8
      ) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (
    type === 'image/webp' &&
    bytes.length >= 30 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  ) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString('ascii', offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4),
        data = offset + 8;
      if (data + length > bytes.length) break;
      if (kind === 'VP8X' && length >= 10) {
        width = bytes.readUIntLE(data + 4, 3) + 1;
        height = bytes.readUIntLE(data + 7, 3) + 1;
        break;
      }
      if (kind === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
        const bits = bytes.readUInt32LE(data + 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
        break;
      }
      if (
        kind === 'VP8 ' &&
        length >= 10 &&
        (bytes[data] & 1) === 0 &&
        bytes.subarray(data + 3, data + 6).equals(Buffer.from([0x9d, 1, 0x2a]))
      ) {
        width = bytes.readUInt16LE(data + 6) & 0x3fff;
        height = bytes.readUInt16LE(data + 8) & 0x3fff;
        break;
      }
      offset = data + length + (length % 2);
    }
  }
  requireValue(
    Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0,
    'The file does not match its image type or has an invalid image header.',
  );
  requireValue(
    width <= 16000 && height <= 16000 && width * height <= 25000000,
    'Images must be at most 25 megapixels and 16,000 pixels on either side.',
  );
  return { type, extension: TYPES.get(type), width, height, size: bytes.length };
}

export async function uploadImage(req, directory) {
  const type = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  requireValue(TYPES.has(type), 'Use PNG, JPEG, GIF, or WebP images.', 415);
  requireValue(
    !req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity',
    'Compressed uploads are not supported.',
    415,
  );
  requireValue(
    !req.headers['content-length'] || Number(req.headers['content-length']) <= MAX_IMAGE_BYTES,
    'Images must be at most 10 MB.',
    413,
  );
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) {
      req.resume();
      throw new InputError('Images must be at most 10 MB.', 413);
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks),
    info = inspectImage(bytes, type);
  const target = join(directory, 'attachments');
  await mkdir(target, { recursive: true, mode: 0o700 });
  const filename = `${randomUUID()}.${info.extension}`;
  await writeFile(join(target, filename), bytes, { mode: 0o600, flag: 'wx' });
  return { ...info, url: `/api/attachments/${filename}` };
}

export async function readImage(path, directory) {
  const match = path.match(ATTACHMENT_PATH);
  requireValue(match, 'Image not found', 404);
  const target = join(directory, 'attachments');
  try {
    const [root, actual] = await Promise.all([realpath(target), realpath(join(target, match[1]))]);
    requireValue(actual === join(root, match[1]), 'Image not found', 404);
    const bytes = await readFile(actual);
    const type = [...TYPES].find(([, extension]) => match[1].endsWith('.' + extension))[0];
    const info = inspectImage(bytes, type);
    return { bytes, ...info };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR')
      throw new InputError('Image not found', 404);
    throw error;
  }
}

export async function attachmentContext(task, directory) {
  const sources = JSON.stringify({
    description: task.description,
    feedback: task.messages,
    instructions: task.repository?.instructions,
    repositories: task.repositoryMap,
  });
  const references = [
    ...new Set(
      [
        ...sources.matchAll(
          /(?:^|[\s("'])((?:\/api\/attachments\/)[a-f0-9-]{36}\.(?:png|jpg|gif|webp))/g,
        ),
      ].map((match) => match[1]),
    ),
  ];
  const images = [];
  for (const url of references) {
    try {
      const image = await readImage(url, directory);
      images.push({
        url,
        path: resolve(directory, 'attachments', url.split('/').at(-1)),
        type: image.type,
        width: image.width,
        height: image.height,
      });
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      images.push({ url, error: 'The image is missing or invalid in local attachment storage.' });
    }
  }
  return images;
}
