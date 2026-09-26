// Chat-hosted execution: the chat agent does the node work and the engine still
// referees every node. The mock provider stands in for the chat's sub-agent, so
// no model is needed: it is run on each brief exactly as a sub-agent would be.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { dispatch } from '../control/index.mjs';
import { renderDashboard } from '../control/dashboard.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mock = path.join(repo, 'hosts', 'mock', 'provider.sh');
process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chat-approval-store-')));
await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);
process.env.CHAT_NEXT_WAIT_SECONDS = '60';
process.env.CHAT_SUBMIT_WAIT_SECONDS = '120';
delete process.env.MOCK_SCRIPT;

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2));

// The python-cli fixture the orchestrator suite uses, with the chat host.
async function fixture(configure = { host: 'chat', review_host: 'chat' }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chat-mode-')));
  await fs.cp(path.join(repo, 'tests', 'fixtures', 'python-cli'), root, { recursive: true });
  for (const name of await fs.readdir(path.join(root, 'tests'))) if (name.endsWith('.sh')) await fs.chmod(path.join(root, 'tests', name), 0o755);
  await fs.mkdir(path.join(root, '.loop', 'work-items'), { recursive: true });
  await fs.mkdir(path.join(root, '.loop', 'evidence'), { recursive: true });
  await fs.mkdir(path.join(root, '.loop', 'control'), { recursive: true });
  const adapter = await readJson(path.join(repo, 'examples', 'adapters', 'python-cli.json'));
  adapter.commands.push({ ...adapter.commands[0], id: 'build-check', phase: 'EXECUTE' });
  await writeJson(path.join(root, '.loop', 'project.adapter.json'), adapter);
  await writeJson(path.join(root, 'project.adapter.json'), adapter);
  await fs.copyFile(path.join(repo, 'template', '.loop', 'workflow.json'), path.join(root, '.loop', 'workflow.json'));
  const state = await readJson(path.join(repo, 'template', '.loop', 'state.example.json'));
  await writeJson(path.join(root, '.loop', 'state.json'), { ...state, work_item_id: 'TEST-1', run_status: 'PAUSED', max_rounds: 40, max_gate_failures: 3, max_wall_seconds: 600 });
  await fs.copyFile(path.join(repo, 'template', 'work-items', 'WI-001-template.md'), path.join(root, '.loop', 'work-items', 'TEST-1.md'));
  const configured = await dispatch(root, 'configure', configure);
  assert.equal(configured.ok, true, JSON.stringify(configured));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial');
  return root;
}

// What a fresh sub-agent does with the brief: here, the deterministic mock.
function subAgent(root, brief) {
  const run = spawnSync(mock, [], { cwd: root, input: JSON.stringify(brief), encoding: 'utf8', env: { ...process.env, LOOP_ROOT: root, MOCK_SCRIPT: '' } });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

async function settled(root) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const result = await dispatch(root, 'status', {});
    if (!result.job || !['QUEUED', 'RUNNING', 'STOPPING'].includes(result.job.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('job did not settle');
}

const done = { schema_version: 1, status: 'DONE', defect_class: null, blocker: null, notes: 'fabricated' };

test('chat_next returns a DEFINE brief; a result the engine cannot accept blocks the run; one submission per node', { timeout: 120000 }, async () => {
  const root = await fixture();
  try {
    const next = await dispatch(root, 'chat_next', {});
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.equal(next.phase, 'DEFINE');
    // A short opaque node id, the readable run id beside it, and a random attempt id.
    assert.match(next.node_id, /^n-[0-9a-f]{12}$/);
    assert.match(next.label, /^run-TEST-1-\d+-define$/);
    assert.match(next.attempt_id, /^[0-9a-f]{32}$/);
    assert.match(next.brief.prompt, /# Node task \(DEFINE\)/);
    assert.equal(next.execution.line, 'Execution: chat-hosted (review not independently isolated)');
    assert.equal(next.review_isolated, false); assert.match(next.warning, /Review was not independently isolated \(same chat\)/);
    const wrapper = await readJson(path.join(root, '.loop', 'scheduler', 'chat', `${next.node_id}.${next.attempt_id}.brief.json`));
    assert.equal(wrapper.attempt_id, next.attempt_id); assert.equal(wrapper.label, next.label);
    assert.equal((await readJson(path.join(root, '.loop', 'scheduler', 'chat', 'pending.json'))).attempt_id, next.attempt_id);
    assert.equal((await fs.stat(path.join(root, '.loop', 'scheduler', 'chat'))).mode & 0o777, 0o700);
    // Asking again hands out the same waiting attempt.
    const again = await dispatch(root, 'chat_next', {});
    assert.equal(again.node_id, next.node_id); assert.equal(again.attempt_id, next.attempt_id); assert.equal(again.idempotent, true);

    const unknown = await dispatch(root, 'chat_submit', { node_id: 'n-000000000000', attempt_id: next.attempt_id, result: done });
    assert.equal(unknown.error.code, 'CHAT_NODE_UNKNOWN');
    const noAttempt = await dispatch(root, 'chat_submit', { node_id: next.node_id, result: done });
    assert.equal(noAttempt.ok, false, 'attempt_id is required'); assert.ok(noAttempt.error.code);
    const otherAttempt = await dispatch(root, 'chat_submit', { node_id: next.node_id, attempt_id: '0'.repeat(32), result: done });
    assert.equal(otherAttempt.error.code, 'CHAT_NODE_STALE', 'a result for another wait of the same node is refused');
    const invalid = await dispatch(root, 'chat_submit', { node_id: next.node_id, attempt_id: next.attempt_id, result: { schema_version: 1, status: 'PASSED' } });
    assert.equal(invalid.error.code, 'CHAT_RESULT_INVALID', JSON.stringify(invalid));

    // Schema-valid, but the work item was never edited: the out-of-scope
    // section is empty, so the engine fails the gate and the run blocks.
    const fabricated = await dispatch(root, 'chat_submit', { node_id: next.node_id, attempt_id: next.attempt_id, result: done });
    assert.equal(fabricated.ok, true, JSON.stringify(fabricated));
    assert.equal(fabricated.accepted, true);
    assert.ok(await fs.stat(path.join(root, '.loop', 'scheduler', 'chat', `${next.node_id}.${next.attempt_id}.consumed.json`)), 'accepted means the provider took it');
    assert.equal(fabricated.gate.outcome, 'BLOCKED');
    assert.equal(fabricated.gate.host, 'chat');
    assert.ok(fabricated.gate.evidence.some((item) => item.result === 'FAILED'), JSON.stringify(fabricated.gate));
    assert.equal(fabricated.check.run_status, 'BLOCKED');
    assert.equal(fabricated.next_node, null);

    const twice = await dispatch(root, 'chat_submit', { node_id: next.node_id, attempt_id: next.attempt_id, result: done });
    assert.equal(twice.error.code, 'CHAT_NODE_ALREADY_SUBMITTED');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a node that is no longer waiting is refused as stale', { timeout: 120000 }, async () => {
  const root = await fixture();
  try {
    const next = await dispatch(root, 'chat_next', {});
    assert.equal(next.ok, true, JSON.stringify(next));
    // Cancel while the chat node waits: the node ends at once as BLOCKED.
    const cancelled = await dispatch(root, 'cancel', {});
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const status = await settled(root);
    assert.equal(status.state.run_status, 'CANCELLED', JSON.stringify(status.state));
    const late = await dispatch(root, 'chat_submit', { node_id: next.node_id, attempt_id: next.attempt_id, result: done });
    assert.equal(late.error.code, 'CHAT_NODE_STALE', JSON.stringify(late));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('chat-hosted run passes every gate from DEFINE to HANDOVER with the engine as referee', { timeout: 300000 }, async () => {
  const root = await fixture();
  try {
    const phases = [];
    let previous = null; let previousAttempt = null;
    for (let step = 0; step < 12; step += 1) {
      const next = await dispatch(root, 'chat_next', {});
      if (next.ok === false || next.node_id === null) break;
      if (previous) {
        const stale = await dispatch(root, 'chat_submit', { node_id: previous, attempt_id: previousAttempt, result: done });
        assert.equal(stale.error.code, 'CHAT_NODE_ALREADY_SUBMITTED');
      }
      phases.push(next.phase);
      if (next.phase === 'REVIEW') {
        // The referee's challenge travels in the brief exactly as for a CLI reviewer.
        assert.match(next.brief.nonce, /^[0-9a-f]{64}$/);
        assert.ok(next.brief.prompt.includes(`nonce: ${next.brief.nonce}`));
        assert.ok(next.brief.evidence_refs.length > 0);
        assert.equal(next.brief.reviewer_host, 'chat');
      }
      const submitted = await dispatch(root, 'chat_submit', { node_id: next.node_id, attempt_id: next.attempt_id, result: subAgent(root, next.brief) });
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      assert.equal(submitted.gate.outcome, 'PASSED', JSON.stringify(submitted.gate));
      previous = next.node_id; previousAttempt = next.attempt_id;
      if (next.phase === 'HANDOVER') break;
    }
    assert.deepEqual(phases, ['DEFINE', 'DESIGN', 'EXECUTE', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER']);
    const status = await settled(root);
    assert.equal(status.state.run_status, 'WAITING_FOR_HUMAN');
    assert.ok(Object.values(status.state.gates).every((gate) => gate.status === 'PASSED'));
    const review = await readJson(path.join(root, '.loop', 'evidence', `${status.state.gates.REVIEW.evidence_ids[0]}.json`));
    assert.equal(review.producer, 'reference-engine'); assert.equal(review.details.verdict, 'PASS');

    // Provenance: every node names the chat host, and every gate's evidence is
    // covered by a provenance record.
    const evidenceDir = path.join(root, '.loop', 'evidence'); const covered = new Set();
    for (const entry of await fs.readdir(evidenceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(evidenceDir, entry.name, 'provenance.json');
      const record = await readJson(file).catch(() => null); if (!record) continue;
      assert.equal(record.host, 'chat'); assert.equal(record.review_isolated, false);
      record.evidence_ids.forEach((id) => covered.add(id));
    }
    for (const gate of Object.values(status.state.gates)) for (const id of gate.evidence_ids) assert.ok(covered.has(id), `${id} has no provenance`);

    assert.equal(status.host, 'chat');
    const checked = await dispatch(root, 'check', {});
    assert.equal(checked.host, 'chat'); assert.equal(checked.handover_ready, true);
    // Same-chat review is said plainly: in check and status, in the frozen
    // accept decision the person reads before typing ACCEPT, and in the handover notes.
    assert.equal(checked.review_isolated, false); assert.match(checked.review_warning, /Review was not independently isolated \(same chat\)/);
    assert.equal(status.review_isolated, false); assert.match(status.review_warning, /not independently isolated/);
    const accept = await dispatch(root, 'accept', { confirm: 'ACCEPT' });
    assert.equal(accept.pending_confirmation, true, JSON.stringify(accept));
    const frozen = await readJson(path.join(root, '.loop', 'scheduler', 'operation-requests', `${accept.request_id}.json`));
    assert.ok(frozen.summary.some((entry) => entry.value.startsWith('Review was not independently isolated (same chat)')), JSON.stringify(frozen.summary));
    const page = await (await fetch(accept.confirmation_url)).text();
    assert.match(page, /Review was not independently isolated \(same chat\)/);
    assert.match(await fs.readFile(path.join(root, '.loop', 'notes', 'next-steps.md'), 'utf8'), /- Review independence: Review was not independently isolated \(same chat\)/);
    assert.match(await renderDashboard(root, 'n'.repeat(16)), /Execution: chat-hosted \(review not independently isolated\)/);
    const rendered = spawnSync(path.join(repo, 'engine', 'render-dashboard.sh'), ['--root', root, '--output', '-'], { encoding: 'utf8' });
    assert.match(rendered.stdout, /Execution: chat-hosted \(review not independently isolated\)/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('chat_next obeys the same entry checks as run and names a separate reviewer', { timeout: 60000 }, async () => {
  const root = await fixture({ host: 'chat', review_host: 'mock' });
  try {
    const status = await dispatch(root, 'status', {});
    assert.equal(status.execution.line, 'Execution: chat-hosted · review: mock');
    assert.equal(status.execution.review_isolated, true);

    // A withdrawn decision stops chat_next exactly as it stops run.
    const sidecar = path.join(root, '.loop', 'work-items', 'TEST-1.authorization.json');
    await writeJson(sidecar, { schema_version: 1, item_id: 'TEST-1', state: 'PAUSED', authorized_by: 'interactive-tty', authorized_at: '2026-01-01T00:00:00Z' });
    const viaRun = await dispatch(root, 'run', { request_id: 'r1', max_nodes: 1 });
    const viaChat = await dispatch(root, 'chat_next', {});
    assert.equal(viaRun.error.code, 'AUTHORIZATION_REVOKED');
    assert.equal(viaChat.error.code, 'AUTHORIZATION_REVOKED');
    await fs.rm(sidecar);

    const held = await dispatch(root, 'hold', { reason: 'stop' });
    assert.equal(held.ok, true, JSON.stringify(held));
    assert.equal((await dispatch(root, 'chat_next', {})).error.code, 'PROJECT_ON_HOLD');
    assert.equal((await dispatch(root, 'chat_submit', { node_id: 'n-000000000000', attempt_id: '0'.repeat(32), result: done })).error.code, 'PROJECT_ON_HOLD');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('chat_next refuses a project whose configured host is not chat', async () => {
  const root = await fixture({ host: 'mock' });
  try {
    assert.equal((await dispatch(root, 'chat_next', {})).error.code, 'CHAT_HOST_NOT_CONFIGURED');
    assert.equal((await dispatch(root, 'status', {})).execution.line, 'Execution: separate CLI process (mock) · review: mock');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('with host chat the reviewer has to be chosen; nothing defaults to the same chat', async () => {
  const root = await fixture({ host: 'chat' });
  try {
    const refused = await dispatch(root, 'chat_next', {});
    assert.equal(refused.error.code, 'CHAT_REVIEW_HOST_REQUIRED', JSON.stringify(refused));
    assert.deepEqual(refused.error.details?.options ?? refused.error.options, ['chat', 'claude', 'codex']);
    assert.equal((await dispatch(root, 'status', {})).execution.review_host_chosen, false);
    const chosen = await dispatch(root, 'configure', { host: 'chat', review_host: 'chat' });
    assert.equal(chosen.review_host_chosen, true); assert.equal(chosen.review_isolated, false); assert.match(chosen.warning, /not independently isolated/);
    const checked = await dispatch(root, 'check', {});
    assert.equal(checked.review_isolated, false); assert.match(checked.review_warning, /Review was not independently isolated \(same chat\)/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a result the provider never takes is withdrawn and not accepted', { timeout: 120000 }, async () => {
  const root = await fixture();
  const previous = process.env.CHAT_SUBMIT_WAIT_SECONDS;
  let pid = null;
  try {
    const next = await dispatch(root, 'chat_next', {});
    assert.equal(next.ok, true, JSON.stringify(next));
    pid = (await readJson(path.join(root, '.loop', 'scheduler', 'chat', 'pending.json'))).provider_pid;
    // The provider is alive but does not take anything (stopped), so the result
    // lands and is never consumed.
    process.kill(pid, 'SIGSTOP');
    process.env.CHAT_SUBMIT_WAIT_SECONDS = '2';
    const lost = await dispatch(root, 'chat_submit', { node_id: next.node_id, attempt_id: next.attempt_id, result: done });
    assert.equal(lost.ok, false); assert.equal(lost.error.code, 'CHAT_NODE_STALE', JSON.stringify(lost));
    const names = await fs.readdir(path.join(root, '.loop', 'scheduler', 'chat'));
    assert.ok(!names.some((name) => name.endsWith('.result.json') || name.endsWith('.consumed.json')), names.join(' '));
  } finally {
    if (previous === undefined) delete process.env.CHAT_SUBMIT_WAIT_SECONDS; else process.env.CHAT_SUBMIT_WAIT_SECONDS = previous;
    if (pid) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    await dispatch(root, 'cancel', {}); await settled(root).catch(() => null);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a symlinked chat directory is refused', async () => {
  const root = await fixture();
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-elsewhere-'));
  try {
    await fs.mkdir(path.join(root, '.loop', 'scheduler'), { recursive: true });
    await fs.rm(path.join(root, '.loop', 'scheduler', 'chat'), { recursive: true, force: true });
    await fs.symlink(elsewhere, path.join(root, '.loop', 'scheduler', 'chat'));
    assert.equal((await dispatch(root, 'chat_next', {})).error.code, 'UNSAFE_CONTROL_PATH');
    assert.equal((await dispatch(root, 'chat_submit', { node_id: 'n-000000000000', attempt_id: '0'.repeat(32), result: done })).error.code, 'UNSAFE_CONTROL_PATH');
    assert.deepEqual(await fs.readdir(elsewhere), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(elsewhere, { recursive: true, force: true }); }
});

test('work item ids are capped at 64 characters', async () => {
  const root = await fixture({ host: 'mock' });
  try {
    const long = await dispatch(root, 'backlog_add', { id: `W${'x'.repeat(64)}`, title: 'Too long', outcome: 'Refused.' });
    assert.equal(long.ok, false); assert.equal(long.error.code, 'INVALID_INPUT');
    const fits = await dispatch(root, 'backlog_add', { id: `W${'x'.repeat(63)}`, title: 'Fits', outcome: 'Accepted.' });
    assert.equal(fits.ok, true, JSON.stringify(fits));
    const schemas = await import('../control/schemas.mjs');
    assert.equal(schemas.operations.backlog_add.inputSchema.properties.id.maxLength, 64);
    for (const name of ['state', 'evidence', 'node', 'verdict', 'control-job']) {
      const schema = await readJson(path.join(repo, 'spec', 'schemas', `${name}.schema.json`));
      assert.equal(schema.properties.work_item_id.maxLength, 64, name);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
