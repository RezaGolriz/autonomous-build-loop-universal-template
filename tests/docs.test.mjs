import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['.git', '.loop', 'dist', 'node_modules', 'graphify-out', '.graphify-cache'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}
test('documentation local links resolve to repository files', () => {
  const broken = [];
  for (const file of files(root)) {
    const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = match[1].replace(/^<|>$/g, '').split(/\s+"/)[0];
      if (/^(?:[a-z]+:|#)/i.test(href)) continue;
      const path = decodeURIComponent(href.split('#')[0]);
      if (path && !existsSync(resolve(dirname(file), path))) broken.push(`${file.slice(root.length + 1)} -> ${path}`);
    }
  }
  assert.deepEqual(broken, []);
});
test('JSON documentation blocks without explicit placeholders are valid JSON', () => {
  const invalid = [];
  for (const file of files(root)) {
    for (const block of readFileSync(file, 'utf8').matchAll(/```json\s*\n([\s\S]*?)```/g)) {
      if (block[1].includes('...') || block[1].includes('//') || block[1].includes('"DONE"|')) continue;
      try { JSON.parse(block[1]); } catch { invalid.push(file.slice(root.length + 1)); }
    }
  }
  assert.deepEqual(invalid, []);
});
