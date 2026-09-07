import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatch, operations } from '../control/index.mjs';
import { resolveRunArgs } from '../control/loop-options.mjs';
import { renderDashboard } from '../control/dashboard.mjs';
import { createHandler } from '../mcp/server.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loop-dashboard-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
test('work kinds and run modes validate, and preserve explicit shell-equivalent bounds', async t => {
  const root = await fixture(t);
  const options = await dispatch(root, 'options');
  assert.deepEqual(Object.keys(options.work_kinds), ['feature', 'defect', 'maintenance', 'documentation', 'research', 'migration']);
  assert.equal(options.independent_review_required, true);
  assert.equal(resolveRunArgs({ request_id: 'one', run_mode: 'step' }).max_nodes, 1);
  assert.equal(resolveRunArgs({ request_id: 'many', run_mode: 'bounded' }).max_nodes, 12);
  assert.equal(resolveRunArgs({ request_id: 'custom', max_nodes: 7 }).max_nodes, 7);
  assert.throws(() => resolveRunArgs({ run_mode: 'step', max_nodes: 12 }));
  for (const operation of ['prepare', 'task']) assert.equal((await dispatch(root, operation, { work_kind: 'skip-review' })).ok, false);
  for (const operation of ['start', 'run', 'resume']) assert.equal((await dispatch(root, operation, { request_id: 'x', run_mode: 'unlimited' })).error.code, 'INVALID_INPUT');
});
test('every kind is persisted in prepared work items with fixed gates and specific guidance', async t => {
  for (const kind of Object.keys((await dispatch(await fixture(t), 'options')).work_kinds)) {
    const root = await fixture(t);
    assert.equal((await dispatch(root, 'demo', { kind: 'docs' })).ok, true);
    const plan = JSON.parse(await fs.readFile(path.join(root, '.loop/candidate/setup.plan.json')));
    const adapter = JSON.parse(await fs.readFile(path.join(root, '.loop/candidate/project.adapter.json')));
    const result = await dispatch(root, 'prepare', { ...plan.requested_scope, work_kind: kind, adapter, negative_control: plan.negative_control, replace_candidate: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    const work = await fs.readFile(path.join(root, '.loop/candidate/work-items/WI-001.md'), 'utf8');
    assert.match(work, new RegExp(`Kind: ${kind}\\n`));
    const state = JSON.parse(await fs.readFile(path.join(root, '.loop/candidate/state.json')));
    assert.equal(state.run_status, 'PAUSED'); assert.equal(Object.keys(state.gates).length, 6);
  }
});
test('dashboard supports empty and candidate projects and escapes untrusted content', async t => {
  const root = await fixture(t);
  assert.match(await renderDashboard(root, 'test'), /NOT CONFIGURED/);
  await dispatch(root, 'demo', { kind: 'docs' });
  const file = path.join(root, '.loop/candidate/work-items/WI-001.md');
  await fs.appendFile(file, '\n<script>alert("unsafe")</script>');
  const html = await renderDashboard(root, 'test');
  assert.match(html, /SETUP CANDIDATE/); assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<script>alert('));
  await fs.rename(file, file + '.backup'); await fs.symlink(file + '.backup', file);
  await assert.rejects(renderDashboard(root, 'test'), /symlink/);
});
test('local dashboard HTTP stays read-only, checks capability and host, and refreshes data', async t => {
  const root = await fixture(t);
  const opened = await dispatch(root, 'dashboard'); assert.equal(opened.ok, true, JSON.stringify(opened));
  t.after(() => { try { process.kill(opened.pid, 'SIGTERM'); } catch {} });
  const url = opened.dashboard_url;
  for (let repeat = 0; repeat < 3; repeat++) {
    const response = await fetch(url); assert.equal(response.status, 200); assert.match(await response.text(), /NOT CONFIGURED/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await fetch(new URL('/', url))).status, 404);
    assert.equal((await fetch(url, { method: 'POST' })).status, 403);
    assert.equal((await fetch(url, { headers: { Host: 'evil.invalid' } })).status, 403);
    assert.equal((await fetch(url, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  }
  assert.deepEqual(await fs.readdir(root), []);
  await dispatch(root, 'demo', { kind: 'docs' });
  assert.match(await (await fetch(url)).text(), /SETUP CANDIDATE/);
});
test('MCP exposes loop selection and dashboard operations with fixed project binding', async t => {
  const root = await fixture(t); const handle = createHandler({ root, operations, dispatch });
  await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const list = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools;
  assert.ok(list.find(tool => tool.name === 'loop_dashboard'));
  assert.ok(list.find(tool => tool.name === 'loop_prepare').inputSchema.properties.work_kind.enum.includes('defect'));
  const reply = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'loop_options', arguments: {} } });
  assert.equal(reply.result.structuredContent.run_modes.step.max_nodes, 1);
});
