import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '.relay', 'node_modules', 'docs'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}
let failed = false;
const files = await walk('.');
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { failed = true; process.stderr.write(result.stderr); }
}
if (failed) process.exitCode = 1;
else process.stdout.write(`Syntax checked ${files.length} JavaScript modules.\n`);
