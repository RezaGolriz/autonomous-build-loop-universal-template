import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { dispatch, operations } from '../control/index.mjs';
import { sameEntry, tickExitCode } from '../control/tick.mjs';
import { gateFailed } from '../control/jobs.mjs';
import { signHostConfiguration } from '../control/approval-store.mjs';
import { recordTrustedApproval } from '../control/approval.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tick-approval-store-')));
await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

async function temporary() { return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tick-test-'))); }

// A hand-built project: durable state plus a work item, without an activation
// receipt. Enough for every tick decision that does not actually run a node.
async function project(overrides = {}) {
  const root = await temporary();
  await fs.mkdir(path.join(root, '.loop', 'work-items'), { recursive: true });
  const state = { ...JSON.parse(await fs.readFile(path.join(repo, 'template', '.loop', 'state.example.json'), 'utf8')), ...overrides };
  await fs.writeFile(path.join(root, '.loop', 'state.json'), JSON.stringify(state));
  await fs.copyFile(path.join(repo, 'template', '.loop', 'workflow.json'), path.join(root, '.loop', 'workflow.json'));
  await fs.copyFile(path.join(repo, 'template', 'work-items', 'WI-001-template.md'), path.join(root, '.loop', 'work-items', `${state.work_item_id}.md`));
  return { root, state };
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const passedGates = (passed) => Object.fromEntries(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER']
  .map((phase) => [phase, { status: passed.includes(phase) ? 'PASSED' : 'PENDING', evidence_ids: [] }]));
const typed = { channel: 'interactive-tty' };
const tickLog = async (root) => (await fs.readFile(path.join(root, '.loop', 'scheduler', 'tick.log'), 'utf8')).trim().split('\n');

function authorization(id, overrides = {}) {
  return {
    schema_version: 1, item_id: id, state: 'READY',
    scope: { allowed_paths: ['docs/guide.md'] }, budget: { max_rounds: 9, max_wall_seconds: 600 },
    expires_at: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    stop_on_first_failure: true, authorized_by: 'interactive-tty', authorized_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

async function writeAuthorization(root, id, overrides = {}) {
  await fs.writeFile(path.join(root, '.loop', 'work-items', `${id}.authorization.json`), JSON.stringify(authorization(id, overrides)));
}

test('tick is offered with a description and a strict object schema', () => {
  assert.ok(operations.tick);
  assert.equal(typeof operations.tick.description, 'string');
  assert.equal(operations.tick.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(operations.tick.inputSchema.properties), ['max_nodes']);
  assert.deepEqual(operations.tick.inputSchema.required, []);
});

test('tick does nothing on a paused project without a READY authorization', async () => {
  const { root } = await project();
  const before = await fs.readFile(path.join(root, '.loop', 'state.json'), 'utf8');
  const result = await dispatch(root, 'tick', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.action, 'nothing');
  assert.equal(result.reason, 'no-ready-authorization');
  // The full check output travels with every tick.
  assert.equal(result.run_status, 'PAUSED');
  assert.equal(result.phase, 'DEFINE');
  assert.equal(result.handover_ready, false);
  assert.equal(result.judge_verdict, null);
  assert.deepEqual(result.backlog, { ready: 0, paused: 0 });
  assert.equal(typeof result.next_action, 'string');
  assert.equal(tickExitCode(result), 0);
  // Nothing was started and nothing was written to the run.
  assert.equal(await fs.readFile(path.join(root, '.loop', 'state.json'), 'utf8'), before);
  assert.equal(await fs.stat(path.join(root, '.loop', 'control', 'current-job.json')).then(() => true, () => false), false);
  assert.match((await tickLog(root))[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z action=nothing reason=no-ready-authorization item=WI-001 phase=DEFINE run_status=PAUSED$/);
  // The lock is not left behind.
  assert.equal(await fs.stat(path.join(root, '.loop', 'scheduler', 'tick.lock')).then(() => true, () => false), false);
});

test('tick reports a blocked run and a run waiting for a human', async () => {
  const blocked = await project({ run_status: 'BLOCKED', phase: 'DESIGN' });
  await fs.writeFile(path.join(blocked.root, '.loop', 'blockers.md'), '# Blockers\n\n- [ ] DESIGN run-1: Choose A or B\n');
  const blockedResult = await dispatch(blocked.root, 'tick', {});
  assert.equal(blockedResult.action, 'reported');
  assert.equal(blockedResult.reason, 'blocked');
  assert.equal(blockedResult.run_status, 'BLOCKED');
  assert.equal(blockedResult.open_blockers, 1);

  // A passed HANDOVER gate is the state that waits for a person to accept.
  const waiting = await project({ run_status: 'WAITING_FOR_HUMAN', phase: 'HANDOVER', gates: passedGates(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER']) });
  const waitingResult = await dispatch(waiting.root, 'tick', {});
  assert.equal(waitingResult.action, 'reported');
  assert.equal(waitingResult.reason, 'waiting-for-human');
  assert.equal(waitingResult.run_status, 'WAITING_FOR_HUMAN');
  assert.equal(tickExitCode(waitingResult), 0);
});

test('tick reports instead of starting a second job while one is active', async () => {
  const { root } = await project({ run_status: 'RUNNING', phase: 'EXECUTE' });
  const jobs = path.join(root, '.loop', 'control', 'jobs');
  await fs.mkdir(jobs, { recursive: true });
  await fs.writeFile(path.join(jobs, 'job-active.json'), JSON.stringify({ schema_version: 1, job_id: 'job-active', status: 'RUNNING' }));
  await fs.writeFile(path.join(root, '.loop', 'control', 'current-job.json'), JSON.stringify({ schema_version: 1, job_id: 'job-active' }));
  const result = await dispatch(root, 'tick', {});
  assert.equal(result.action, 'reported');
  assert.equal(result.reason, 'job-active');
  assert.equal(result.job_id, 'job-active');
});

test('tick refuses to start an expired READY authorization', async () => {
  const { root } = await project();
  await writeAuthorization(root, 'WI-001', { expires_at: '2000-01-01T00:00:00Z' });
  const result = await dispatch(root, 'tick', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.action, 'nothing');
  assert.equal(result.reason, 'authorization-expired');
  assert.equal((await readJson(path.join(root, '.loop', 'state.json'))).run_status, 'PAUSED');
  assert.equal(await fs.stat(path.join(root, '.loop', 'control', 'job.lock')).then(() => true, () => false), false);
});

test('a second concurrent tick reports tick-in-progress and leaves the lock alone', async () => {
  const { root } = await project();
  await writeAuthorization(root, 'WI-001');
  const scheduler = path.join(root, '.loop', 'scheduler');
  const control = path.join(root, '.loop', 'control');
  await fs.mkdir(scheduler, { recursive: true });
  const held = { schema_version: 1, lock_id: 'held-lock-id', pid: process.pid, created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), operation: 'tick' };
  await fs.writeFile(path.join(scheduler, 'tick.lock'), JSON.stringify(held));
  const result = await dispatch(root, 'tick', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.action, 'reported');
  assert.equal(result.reason, 'tick-in-progress');
  // The other tick still owns its lock, and nothing was started.
  assert.deepEqual(await readJson(path.join(scheduler, 'tick.lock')), held);
  assert.equal(await fs.stat(path.join(control, 'current-job.json')).then(() => true, () => false), false);
  assert.match((await tickLog(root)).at(-1), /action=reported reason=tick-in-progress/);
});

test('tick replaces a stale tick lock and records the replacement', async () => {
  const { root } = await project({ max_wall_seconds: 600 });
  const scheduler = path.join(root, '.loop', 'scheduler');
  await fs.mkdir(scheduler, { recursive: true });
  // A dead owner and a timestamp far outside the wall-clock budget of the run.
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.ok(Number.isInteger(dead) && dead > 0);
  await fs.writeFile(path.join(scheduler, 'tick.lock'), JSON.stringify({ schema_version: 1, lock_id: 'stale-lock-id', pid: dead, created_at: '2000-01-01T00:00:00Z', operation: 'tick' }));
  const result = await dispatch(root, 'tick', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.action, 'nothing');
  assert.equal(result.reason, 'no-ready-authorization');
  const log = await tickLog(root);
  assert.match(log[0], /action=replaced-stale-lock reason=tick-lock-owner-is-gone/);
  assert.match(log.at(-1), /action=nothing reason=no-ready-authorization/);
  // The tick released the lock it took over.
  assert.equal(await fs.stat(path.join(scheduler, 'tick.lock')).then(() => true, () => false), false);
});

test('stop_on_first_failure blocks the run instead of retrying it', async () => {
  const { root } = await project({ run_status: 'RUNNING', phase: 'EXECUTE', gate_failures_here: 1 });
  await writeAuthorization(root, 'WI-001', { stop_on_first_failure: true });
  const result = await dispatch(root, 'tick', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.action, 'reported');
  assert.equal(result.reason, 'stopped-on-first-failure');
  assert.equal(result.run_status, 'BLOCKED');
  const state = await readJson(path.join(root, '.loop', 'state.json'));
  assert.equal(state.run_status, 'BLOCKED');
  assert.match(state.next_action, /resume or deauthorize/);
  // No job was launched for the failed gate.
  assert.equal(await fs.stat(path.join(root, '.loop', 'control', 'current-job.json')).then(() => true, () => false), false);

  // The next tick keeps it blocked and does not retry either.
  const again = await dispatch(root, 'tick', {});
  assert.equal(again.action, 'reported');
  assert.equal(again.reason, 'stopped-on-first-failure');
  assert.equal(again.run_status, 'BLOCKED');
});

test('tick does nothing after a completed run while no backlog item is authorized', async () => {
  const { root } = await project({ run_status: 'COMPLETED', phase: 'HANDOVER' });
  await dispatch(root, 'backlog_add', { id: 'WI-002', title: 'Queued item', outcome: 'Queued.' });
  const result = await dispatch(root, 'tick', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.action, 'nothing');
  assert.equal(result.reason, 'no-ready-authorization');
  // A paused backlog item stays in the backlog and nothing is promoted.
  assert.deepEqual((await readJson(path.join(root, '.loop', 'backlog.json'))).items.map((item) => item.id), ['WI-002']);
  assert.equal((await readJson(path.join(root, '.loop', 'state.json'))).work_item_id, 'WI-001');
});

test('tick starts and advances an authorized item, then reports while its job runs', { timeout: 120000 }, async () => {
  const root = await temporary();
  const prepared = await dispatch(root, 'demo', { kind: 'docs' });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty');
  const activation = await dispatch(root, 'activate', {});
  assert.equal(activation.ok, true, JSON.stringify(activation));
  await finished(root, activation.job.job_id);
  // The demo configures a mock provider whose signature binds the project root.
  const configFile = path.join(root, '.loop', 'host.local.json');
  const config = await readJson(configFile);
  delete config.host_signature;
  config.host_signature = await signHostConfiguration(root, config);
  await fs.writeFile(configFile, JSON.stringify(config));

  const current = await readJson(path.join(root, '.loop', 'state.json'));
  assert.equal(current.run_status, 'PAUSED');
  const authorized = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: current.work_item_id, allowed_paths: ['docs/guide.md'], max_rounds: 11, max_wall_seconds: 1800 }, typed);
  assert.equal(authorized.ok, true, JSON.stringify(authorized));

  const started = await dispatch(root, 'tick', {});
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.action, 'started');
  assert.equal(started.reason, 'started-authorized-item');
  assert.equal(started.max_nodes, 1);
  assert.ok(started.job_id);
  // The start went through the same path as start: the authorized budget is in
  // state.json and the job records which decision it runs under.
  const job = await readJson(path.join(root, '.loop', 'control', 'current-job.json'));
  assert.equal(job.authorization_ref.item_id, current.work_item_id);
  assert.equal(job.authorization_ref.stop_on_first_failure, true);
  const state = await readJson(path.join(root, '.loop', 'state.json'));
  assert.equal(state.max_rounds, 11);
  assert.equal(state.max_wall_seconds, 1800);

  const status = await finished(root, started.job_id);
  assert.equal(status.job.status, 'COMPLETED', JSON.stringify(status.job));
  assert.equal(status.job.nodes_completed, 1);
  assert.equal(status.state.run_status, 'RUNNING');

  // A tick on the running item advances exactly one more node.
  const advanced = await dispatch(root, 'tick', { max_nodes: 1 });
  assert.equal(advanced.ok, true, JSON.stringify(advanced));
  assert.equal(advanced.action, 'ran-node');
  assert.equal(advanced.reason, 'advanced-the-running-item');
  const second = await finished(root, advanced.job_id);
  assert.equal(second.job.nodes_completed, 1);
  assert.match((await tickLog(root)).join('\n'), /action=started reason=started-authorized-item/);
});

// Wait until a durable job leaves its active states.
async function finished(root, jobId) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const result = await dispatch(root, 'status', { job_id: jobId });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!['QUEUED', 'RUNNING', 'STOPPING'].includes(result.job.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${jobId} did not finish in time`);
}

test('a run started under a decision stops when the decision is withdrawn', async () => {
  const { root } = await project({ run_status: 'RUNNING', phase: 'EXECUTE' });
  await writeAuthorization(root, 'WI-001');
  // Withdrawing the decision also puts the whole project on hold, so the
  // cadence stops before it looks at the item at all.
  await dispatch(root, 'deauthorize', { item_id: 'WI-001' });
  const held = await dispatch(root, 'tick', {});
  assert.equal(held.ok, false, JSON.stringify(held));
  assert.equal(held.error.code, 'PROJECT_ON_HOLD');
  // With the hold released by a person, the withdrawn decision alone still
  // stops the run: the sidecar says PAUSED.
  const released = await dispatch(root, 'release', { confirm: 'RELEASE' }, typed);
  assert.equal(released.ok, true, JSON.stringify(released));
  const result = await dispatch(root, 'tick', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.action, 'reported');
  assert.equal(result.reason, 'authorization-revoked');
  assert.equal(await fs.stat(path.join(root, '.loop', 'control', 'current-job.json')).then(() => true, () => false), false);

  // An expired decision stops the cadence in the same way.
  await writeAuthorization(root, 'WI-001', { expires_at: '2000-01-01T00:00:00Z' });
  const expired = await dispatch(root, 'tick', {});
  assert.equal(expired.action, 'reported');
  assert.equal(expired.reason, 'authorization-expired');
});

test('a run with no authorization sidecar at all may continue: a person started it', async () => {
  const { root } = await project({ run_status: 'RUNNING', phase: 'EXECUTE' });
  // No sidecar, no activation receipt and no provider, so the launch itself
  // fails; what matters here is that the tick did not refuse on authorization.
  const result = await dispatch(root, 'tick', {});
  assert.notEqual(result.reason, 'authorization-revoked');
  assert.notEqual(result.reason, 'authorization-expired');
});

test('a pending HANDOVER node is work, not a wait', async () => {
  const { root } = await project({ run_status: 'WAITING_FOR_HUMAN', phase: 'HANDOVER', gates: passedGates(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE']) });
  await writeAuthorization(root, 'WI-001');
  const result = await dispatch(root, 'tick', {});
  // The launch cannot succeed in this hand-built project, but the decision the
  // tick took is the one under test: it treated the pending gate as a node.
  assert.notEqual(result.reason, 'waiting-for-human');
  assert.equal((await dispatch(root, 'check', {})).handover_ready, false);
});

test('an unreadable tick lock is not treated as dead while it is young', async () => {
  const { root } = await project({ max_wall_seconds: 600 });
  const scheduler = path.join(root, '.loop', 'scheduler');
  await fs.mkdir(scheduler, { recursive: true });
  await fs.writeFile(path.join(scheduler, 'tick.lock'), '');
  const result = await dispatch(root, 'tick', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.reason, 'tick-in-progress');
  // The live owner's lock is still there, untouched.
  assert.equal(await fs.readFile(path.join(scheduler, 'tick.lock'), 'utf8'), '');

  // Older than the wall-clock budget of the run, it may be reclaimed.
  const old = new Date(Date.now() - 3600_000);
  await fs.utimes(path.join(scheduler, 'tick.lock'), old, old);
  const second = await dispatch(root, 'tick', {});
  assert.equal(second.reason, 'no-ready-authorization');
  assert.match((await tickLog(root)).join('\n'), /action=replaced-stale-lock reason=tick-lock-unreadable-and-older-than-wall-budget/);
});

test('a job under stop_on_first_failure recognises a gate that failed in this node', () => {
  const gates = (statuses) => Object.fromEntries(Object.entries(statuses).map(([phase, status]) => [phase, { status, evidence_ids: [] }]));
  const before = { gate_failures_here: 0, gates: gates({ EXECUTE: 'PASSED', REVIEW: 'PENDING' }) };
  assert.equal(gateFailed(before, { gate_failures_here: 0, gates: gates({ EXECUTE: 'PASSED', REVIEW: 'PASSED' }) }), false);
  assert.equal(gateFailed(before, { gate_failures_here: 1, gates: gates({ EXECUTE: 'PASSED', REVIEW: 'PENDING' }) }), true);
  assert.equal(gateFailed(before, { gate_failures_here: 0, gates: gates({ EXECUTE: 'PASSED', REVIEW: 'FAILED' }) }), true);
  // A gate that already failed before this node is not counted a second time.
  const already = { gate_failures_here: 1, gates: gates({ EXECUTE: 'PASSED', REVIEW: 'FAILED' }) };
  assert.equal(gateFailed(already, { gate_failures_here: 1, gates: gates({ EXECUTE: 'PASSED', REVIEW: 'FAILED' }) }), false);
});

test('a held recovery guard stops a second reclaimer from touching a lock at all', async () => {
  const { root } = await project({ max_wall_seconds: 600 });
  const scheduler = path.join(root, '.loop', 'scheduler');
  await fs.mkdir(scheduler, { recursive: true });
  // A lock whose owner is provably gone, so a tick would normally reclaim it.
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const stale = { schema_version: 1, lock_id: 'stale-lock-id', pid: dead, created_at: '2000-01-01T00:00:00Z', operation: 'tick' };
  await fs.writeFile(path.join(scheduler, 'tick.lock'), JSON.stringify(stale));
  // Another reclaimer is already inside the inspect-remove-acquire sequence.
  await fs.mkdir(path.join(scheduler, 'tick.reclaim.lock.d'));
  const result = await dispatch(root, 'tick', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.reason, 'tick-in-progress');
  assert.deepEqual(await readJson(path.join(scheduler, 'tick.lock')), stale);

  // A guard older than a minute belonged to a process that died holding it.
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(path.join(scheduler, 'tick.reclaim.lock.d'), old, old);
  const second = await dispatch(root, 'tick', {});
  assert.equal(second.reason, 'no-ready-authorization');
  assert.match((await tickLog(root)).join('\n'), /action=replaced-stale-lock reason=tick-lock-owner-is-gone/);
  // Both the reclaimed lock and the guard are released again.
  assert.equal(await fs.stat(path.join(scheduler, 'tick.lock')).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(scheduler, 'tick.reclaim.lock.d')).then(() => true, () => false), false);
});

test('a stale recovery guard is renamed out of the way before it is removed', async () => {
  const { root } = await project({ max_wall_seconds: 600 });
  const scheduler = path.join(root, '.loop', 'scheduler');
  await fs.mkdir(scheduler, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  await fs.writeFile(path.join(scheduler, 'tick.lock'), JSON.stringify({ schema_version: 1, lock_id: 'stale-lock-id', pid: dead, created_at: '2000-01-01T00:00:00Z', operation: 'tick' }));
  // A guard left behind by a process that died inside the sequence. It is taken
  // by renaming it to a private name — the rename is the claim, so a second
  // reclaimer can never delete the replacement guard somebody else created.
  const guard = path.join(scheduler, 'tick.reclaim.lock.d');
  await fs.mkdir(guard);
  await fs.writeFile(path.join(guard, 'left-behind.json'), '{}');
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(guard, old, old);

  const result = await dispatch(root, 'tick', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.reason, 'no-ready-authorization');
  assert.match((await tickLog(root)).join('\n'), /action=replaced-stale-lock reason=tick-lock-owner-is-gone/);
  // The claimed copy is cleaned up with everything in it, and nothing is left
  // lying around under the scheduler directory.
  const entries = await fs.readdir(scheduler);
  assert.deepEqual(entries.filter((name) => name.startsWith('tick.reclaim.lock.d')), []);
});

test('a reporting tick during an active job changes nothing the supervisor protects', async () => {
  const { root } = await project({ run_status: 'RUNNING', phase: 'EXECUTE' });
  const control = path.join(root, '.loop', 'control');
  await fs.mkdir(path.join(control, 'jobs'), { recursive: true });
  await fs.mkdir(path.join(root, '.loop', 'evidence'), { recursive: true });
  await fs.writeFile(path.join(control, 'jobs', 'job-active.json'), JSON.stringify({ schema_version: 1, job_id: 'job-active', status: 'RUNNING' }));
  await fs.writeFile(path.join(control, 'current-job.json'), JSON.stringify({ schema_version: 1, job_id: 'job-active' }));

  // Exactly what the orchestrator compares before and after a provider node.
  const engine = path.join(repo, 'engine', 'reference-engine.sh');
  const snapshot = async (name) => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'tick-snapshot-')), name);
    const done = spawnSync('bash', [engine, 'protected-snapshot', '--root', root, '--output', file], { encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
    return fs.readFile(file, 'utf8');
  };
  const before = await snapshot('before.json');
  const reported = await dispatch(root, 'tick', {});
  assert.equal(reported.action, 'reported');
  assert.equal(reported.reason, 'job-active');
  // The tick recorded its line, and none of it landed in the protected set.
  assert.match((await tickLog(root)).at(-1), /action=reported reason=job-active/);
  assert.equal(await snapshot('after.json'), before);
});

test('a live recovery guard is never moved and a reclaimed one is never put back', async () => {
  const { root } = await project({ max_wall_seconds: 600 });
  const scheduler = path.join(root, '.loop', 'scheduler');
  await fs.mkdir(scheduler, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const stale = { schema_version: 1, lock_id: 'stale-lock-id', pid: dead, created_at: '2000-01-01T00:00:00Z', operation: 'tick' };
  await fs.writeFile(path.join(scheduler, 'tick.lock'), JSON.stringify(stale));
  const guard = path.join(scheduler, 'tick.reclaim.lock.d');
  await fs.mkdir(guard);
  const before = await fs.lstat(guard);

  // Somebody else holds the guard. A guard younger than the stale age is not
  // inspected, not renamed and not removed: this tick reports and leaves.
  const first = await dispatch(root, 'tick', {});
  assert.equal(first.reason, 'tick-in-progress');
  assert.equal((await fs.lstat(guard)).ino, before.ino);
  assert.deepEqual((await fs.readdir(scheduler)).filter((name) => name.endsWith('.stale')), []);
  assert.deepEqual(await readJson(path.join(scheduler, 'tick.lock')), stale);

  // Once the guard is old enough to be the leftover of a process that died, the
  // reclaimer moves it aside and drops it. Nothing is ever moved back: the copy
  // it claimed is gone and the guard it then took for itself is released.
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(guard, old, old);
  const second = await dispatch(root, 'tick', {});
  assert.equal(second.reason, 'no-ready-authorization');
  const entries = await fs.readdir(scheduler);
  assert.deepEqual(entries.filter((name) => name.startsWith('tick.reclaim.lock.d')), []);
  assert.equal(await fs.stat(path.join(scheduler, 'tick.lock')).then(() => true, () => false), false);
});

test('a recovery guard is only ever claimed while it is still the one that was inspected', async () => {
  const { root } = await project({ max_wall_seconds: 600 });
  const scheduler = path.join(root, '.loop', 'scheduler');
  await fs.mkdir(scheduler, { recursive: true });
  const guard = path.join(scheduler, 'tick.reclaim.lock.d');
  await fs.mkdir(guard);
  const inspected = await fs.lstat(guard);
  // The identity of a directory entry is its inode together with its
  // modification time. Either one changing means the guard that is there now is
  // not the guard that was looked at, and nothing may be moved or removed.
  assert.equal(sameEntry(inspected, await fs.lstat(guard)), true);
  assert.equal(sameEntry(inspected, { ...inspected, ino: inspected.ino + 1 }), false);
  assert.equal(sameEntry(inspected, { ...inspected, mtimeMs: inspected.mtimeMs + 1 }), false);
  assert.equal(sameEntry(inspected, null), false);

  // A stale-looking guard that is written to again while a reclaimer is looking
  // at it is a live guard: it stays exactly where it is, with its contents.
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const stale = { schema_version: 1, lock_id: 'stale-lock-id', pid: dead, created_at: '2000-01-01T00:00:00Z', operation: 'tick' };
  await fs.writeFile(path.join(scheduler, 'tick.lock'), JSON.stringify(stale));
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(guard, old, old);
  await fs.writeFile(path.join(guard, 'owner.json'), '{}');
  const result = await dispatch(root, 'tick', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.reason, 'tick-in-progress');
  assert.equal((await fs.lstat(guard)).ino, inspected.ino);
  assert.deepEqual(await fs.readdir(guard), ['owner.json']);
  assert.deepEqual((await fs.readdir(scheduler)).filter((name) => name.endsWith('.stale')), []);
  assert.deepEqual(await readJson(path.join(scheduler, 'tick.lock')), stale);
});
