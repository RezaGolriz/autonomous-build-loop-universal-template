#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const steps = [
  ['bash', ['bootstrap/check-prerequisites.sh']],
  [process.execPath, ['--test', ...readdirSync(`${root}/tests`).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`)]],
  ...readdirSync(`${root}/tests`).filter(name => /^(?:run-|engine-).*\.sh$/.test(name)).sort().map(name => ['bash', [`tests/${name}`]])
];
for (const [command, args] of steps) {
  console.log(`Running ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout: 600000 });
  if (result.status !== 0) { console.error(result.error?.message ?? `Failed with exit ${result.status}`); process.exit(result.status || 1); }
}
console.log('All configured test suites passed. This does not certify real provider or Desktop UI behavior.');
