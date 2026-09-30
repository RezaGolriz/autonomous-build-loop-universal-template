#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, parse } from 'node:path';
import { homedir } from 'node:os';
import { createHandler, serveStdio } from '../mcp/server.mjs';
import { detectPlatform, platformProblem } from '../control/platform.mjs';
console.log = console.info = console.debug = (...values) => console.error(...values);
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// Explain, over MCP, why this server cannot run here, instead of exiting.
const explain = (problem) => { process.stderr.write(`${problem.code}: ${problem.message}\n`); serveStdio(createHandler({ root: null, operations: {}, dispatch: null, requestApproval: null, version, unavailable: problem })); };
const platform = detectPlatform();
const unsupported = platformProblem(null, platform);
if (unsupported) explain(unsupported);
else await main();

async function main() {
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
  const drive = platformProblem(root, platform);
  if (drive) { explain(drive); return; }
  serveStdio(createHandler({ root, operations, dispatch, requestApproval, version,
    notify: message => { if (!process.stdout.destroyed) process.stdout.write(`${JSON.stringify(message)}\n`); } }));
}
