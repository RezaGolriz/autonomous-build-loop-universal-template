import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (args, options = {}) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 60000, ...options });

test('host packages are self-contained, exclude local state, and execute from another cwd', () => {
  const built = run(['tools/bundle.mjs']); assert.equal(built.status, 0, built.stderr);
  const desktop = join(root, 'dist/desktop'); const plugin = join(root, 'dist/codex/build-loop');
  const manifest = JSON.parse(readFileSync(join(desktop, 'manifest.json')));
  const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
  assert.equal(readFileSync(join(root, 'VERSION'), 'utf8').trim(), version);
  assert.equal(manifest.version, version);
  assert.equal(JSON.parse(readFileSync(join(plugin, '.codex-plugin/plugin.json'))).version, version);
  assert.equal(manifest.server.type, 'node');
  assert.ok(manifest.server.mcp_config.args.includes('${user_config.project_root}'));
  assert.ok(existsSync(join(desktop, manifest.server.entry_point)));
  for (const bundle of [desktop, plugin]) {
    for (const forbidden of ['.git', '.loop', '.env', 'node_modules', 'graphify-out', 'Claude outputs']) assert.equal(existsSync(join(bundle, forbidden)), false, forbidden);
    for (const required of ['bin/build-loop.mjs', 'control/index.mjs', 'engine/orchestrator.sh', 'docs/QUICKSTART.md']) assert.ok(existsSync(join(bundle, required)), required);
    const project = mkdtempSync(join(tmpdir(), 'loop-package-test-'));
    try {
      const inspected = run([join(bundle, 'bin/build-loop.mjs'), 'inspect', '--root', project, '--json'], { cwd: tmpdir() });
      assert.equal(inspected.status, 0, inspected.stderr); assert.equal(JSON.parse(inspected.stdout).ok, true);
      assert.deepEqual(readdirSync(project), [], 'inspection must not initialize or modify the project');
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
  assert.ok(existsSync(join(plugin, 'skills/build-loop/SKILL.md')));
  assert.ok(existsSync(join(root, 'dist/build-loop.mcpb')));
});

test('real stdio entrypoint rejects missing root and handles inspection without stdout noise', () => {
  const missing = run(['bin/build-loop-mcp.mjs'], { env: { PATH: process.env.PATH } });
  assert.notEqual(missing.status, 0); assert.equal(missing.stdout, '');
  const project = mkdtempSync(join(tmpdir(), 'loop-mcp-test-'));
  try {
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'distribution-test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'loop_inspect', arguments: {} } },
    ].map(JSON.stringify).join('\n') + '\n';
    const result = run(['bin/build-loop-mcp.mjs', '--root', project], { input });
    assert.equal(result.status, 0, result.stderr);
    const replies = result.stdout.trim().split('\n').map(JSON.parse); assert.equal(replies.length, 2);
    assert.equal(replies[1].result.structuredContent.ok, true); assert.deepEqual(readdirSync(project), []);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
