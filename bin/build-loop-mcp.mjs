#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, parse } from 'node:path';
import { homedir } from 'node:os';
import { createHandler, serveStdio } from '../mcp/server.mjs';
console.log = console.info = console.debug = (...values) => console.error(...values);
const { dispatch, operations, requestApproval } = await import('../control/index.mjs');

const args = process.argv.slice(2);
let root = process.env.LOOP_PROJECT_ROOT;
if (args.length) {
  if (args.length !== 2 || args[0] !== '--root') { process.stderr.write('Usage: build-loop-mcp --root /absolute/project\n'); process.exit(64); }
  root = args[1];
}
try {
  if (!root || !isAbsolute(root)) throw new Error('An absolute project root is required in trusted host configuration.');
  root = realpathSync(root);
  if (!statSync(root).isDirectory()) throw new Error('Project root is not a directory.');
  if (root === parse(root).root || root === realpathSync(homedir())) throw new Error('Choose a project folder, not the filesystem root or your home directory.');
} catch (error) { process.stderr.write(`${error.message}\n`); process.exit(64); }
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
serveStdio(createHandler({ root, operations, dispatch, requestApproval, version,
  notify: message => { if (!process.stdout.destroyed) process.stdout.write(`${JSON.stringify(message)}\n`); } }));
