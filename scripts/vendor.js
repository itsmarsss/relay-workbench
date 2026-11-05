import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('public/vendor', { recursive: true });
for (const [source, target] of [
  ['marked/lib/marked.esm.js', 'marked.js'],
  ['marked/LICENSE', 'marked-LICENSE'],
  ['dompurify/dist/purify.es.mjs', 'purify.js'],
  ['dompurify/LICENSE', 'dompurify-LICENSE'],
  ['dompurify/LICENSE-MPL', 'dompurify-LICENSE-MPL'],
])
  await copyFile(`node_modules/${source}`, `public/vendor/${target}`);
