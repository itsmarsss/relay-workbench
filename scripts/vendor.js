import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('public/vendor', { recursive: true });
for (const [source, target] of [
  ['@xterm/xterm/lib/xterm.mjs', 'xterm.mjs'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/xterm/LICENSE', 'xterm-LICENSE'],
  ['@xterm/addon-fit/lib/addon-fit.mjs', 'addon-fit.mjs'],
  ['@xterm/addon-fit/LICENSE', 'addon-fit-LICENSE'],
  ['motion/dist/motion.js', 'motion.js'],
  ['motion/LICENSE.md', 'motion-LICENSE'],
  ['marked/lib/marked.esm.js', 'marked.js'],
  ['marked/LICENSE', 'marked-LICENSE'],
  ['dompurify/dist/purify.es.mjs', 'purify.js'],
  ['dompurify/LICENSE', 'dompurify-LICENSE'],
  ['dompurify/LICENSE-MPL', 'dompurify-LICENSE-MPL'],
])
  await copyFile(`node_modules/${source}`, `public/vendor/${target}`);

// xterm creates three dynamic stylesheets. Give only those styles the page's
// nonce so the application keeps its strict CSP without allowing inline styles.
const terminalPath = 'public/vendor/xterm.mjs';
let terminal = await readFile(terminalPath, 'utf8');
let styleCount = 0;
terminal = terminal.replace(/([\w.]+)\.createElement\("style"\)/g, (match) => {
  styleCount++;
  return `relayTerminalStyle(${match})`;
});
if (styleCount !== 3)
  throw new Error('Review xterm stylesheet creation before updating vendor assets');
terminal += `\nfunction relayTerminalStyle(element) {
  element.nonce = document.querySelector('meta[name="relay-style-nonce"]')?.content || '';
  return element;
}\n`;
await writeFile(terminalPath, terminal);
