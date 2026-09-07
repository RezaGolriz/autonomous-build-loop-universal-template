import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dispatch } from '../control/index.mjs';
import { recordTrustedApproval } from '../control/approval.mjs';
const repo = fileURLToPath(new URL('../', import.meta.url));
process.env.BUILD_LOOP_APPROVAL_STORE = await mkdtemp(join(tmpdir(), 'loop-test-trust-'));
function mcp(root, name, args) {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e-test', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: `loop_${name}`, arguments: args } },
  ];
  const result = spawnSync(process.execPath, [join(repo, 'bin/build-loop-mcp.mjs'), '--root', root], { input: requests.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const reply = result.stdout.trim().split('\n').map(JSON.parse).find(message => message.id === 2);
  assert.ok(reply?.result && !reply.result.isError, JSON.stringify(reply)); return reply.result.structuredContent;
}
async function completed(root, id) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const result = await dispatch(root, 'status', { job_id: id });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!['QUEUED', 'RUNNING', 'STOPPING'].includes(result.job.status)) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Detached demo exceeded two minutes');
}
test('documented demo survives MCP EOF, passes all six gates, and permits a new bounded task after handover', { timeout: 150000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'loop-e2e-')));
  try {
    const demoArgs = JSON.parse(await readFile(join(repo, 'docs/examples/demo-docs.json')));
    const prepared = mcp(root, 'demo', demoArgs);
    // Test-only simulation of the human boundary, using an internal function.
    // Production MCP exposes no approval-recording operation.
    await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty');
    const activated = mcp(root, 'activate', {}); const setup = await completed(root, activated.job.job_id);
    assert.equal(setup.job.status, 'COMPLETED', JSON.stringify(setup)); assert.equal(setup.activation.valid, true);
    const startArgs = JSON.parse(await readFile(join(repo, 'docs/examples/start-demo.json')));
    const started = mcp(root, 'start', startArgs); const finished = await completed(root, started.job.job_id);
    assert.equal(finished.job.status, 'COMPLETED', JSON.stringify(finished)); assert.equal(finished.job.nodes_completed, 6);
    assert.equal(finished.state.phase, 'HANDOVER'); assert.equal(finished.state.run_status, 'WAITING_FOR_HUMAN');
    assert.ok(Object.values(finished.state.gates).every(gate => gate.status === 'PASSED'));
    assert.equal(mcp(root, 'status', { job_id: started.job.job_id }).job.job_id, started.job.job_id);
    const handover = mcp(root, 'handover', JSON.parse(await readFile(join(repo, 'docs/examples/handover-demo.json'))));
    assert.equal(handover.status, 'COMPLETED'); assert.equal(handover.external_action_performed, false);
    const task = mcp(root, 'task', { request: 'Clarify the demo guide.', acceptance_criteria: ['The guide keeps its heading.'], out_of_scope: ['Publishing.'], allowed_paths: ['docs/guide.md'], frozen_paths: ['tests/check-docs.mjs'] });
    assert.equal(task.status, 'PAUSED'); assert.notEqual(task.work_item_id, finished.state.work_item_id);
  } finally { await rm(root, { recursive: true, force: true }); }
});
