import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { dispatch } from '../control/index.mjs';
import { recordTrustedApproval } from '../control/approval.mjs';
import { elapsedSeconds, leaveRunning } from '../control/common.mjs';

const execFileAsync = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-approval-store-'))); await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

async function temporary() { return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-test-'))); }
async function waitJob(root, jobId, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await dispatch(root, 'status', { job_id: jobId });
    if (!['QUEUED', 'RUNNING', 'STOPPING'].includes(result.job?.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`job ${jobId} did not finish`);
}
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = async (file, value) => fs.writeFile(file, JSON.stringify(value));
const exists = (file) => fs.stat(file).then(() => true, () => false);

async function activatedDemo() {
  const root = await temporary(); const prepared = await dispatch(root, 'demo', { kind: 'python' });
  await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty');
  const activation = await dispatch(root, 'activate', {}); await waitJob(root, activation.job.job_id);
  return root;
}

const task = (extra = {}) => ({ request: 'next', acceptance_criteria: ['a'], out_of_scope: ['b'], allowed_paths: ['src/greet.py'], ...extra });

// --- Provider model per phase -------------------------------------------------

test('configure writes per-phase models into a signed wrapper for the Claude provider', async () => {
  const root = await temporary(); const cli = path.join(root, 'fake-claude'); await fs.writeFile(cli, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = await dispatch(root, 'configure', { host: 'claude', cli_path: cli, models: { default: 'sonnet', REVIEW: 'opus' } });
  assert.equal(result.ok, true); assert.deepEqual(result.models, { default: 'sonnet', REVIEW: 'opus' });
  const config = await readJson(path.join(root, '.loop', 'host.local.json'));
  assert.deepEqual(config.models, { default: 'sonnet', REVIEW: 'opus' }); assert.ok(config.host_signature);
  for (const wrapperPath of [config.provider_path, config.review_provider_path]) {
    const wrapper = await fs.readFile(wrapperPath, 'utf8');
    assert.match(wrapper, /export CLAUDE_MODEL='sonnet'/); assert.match(wrapper, /export CLAUDE_MODEL_REVIEW='opus'/);
  }
  // Only an explicitly given CLI path is pinned, as before: the builder has one, the reviewer uses PATH.
  assert.match(await fs.readFile(config.provider_path, 'utf8'), /export CLAUDE_BIN=/);
  assert.doesNotMatch(await fs.readFile(config.review_provider_path, 'utf8'), /CLAUDE_BIN/);
});

test('configure without models keeps the previous host configuration shape', async () => {
  const root = await temporary(); const cli = path.join(root, 'fake-claude'); await fs.writeFile(cli, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = await dispatch(root, 'configure', { host: 'claude', cli_path: cli });
  assert.equal(result.ok, true); assert.equal(result.models, null);
  assert.equal('models' in await readJson(path.join(root, '.loop', 'host.local.json')), false);
});

test('configure rejects unknown phases and unsafe model names', async () => {
  const root = await temporary();
  const unknown = await dispatch(root, 'configure', { host: 'claude', models: { BUILD: 'sonnet' } });
  assert.equal(unknown.ok, false);
  const unsafe = await dispatch(root, 'configure', { host: 'claude', models: { REVIEW: "opus'; rm -rf /" } });
  assert.equal(unsafe.ok, false);
});

// --- Waiting time is not charged to the wall clock -----------------------------

test('leaving RUNNING records the pause and elapsed time stops while waiting', () => {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const state = { run_status: 'RUNNING', started_epoch: nowEpoch - 100 };
  leaveRunning(state, 'BLOCKED');
  assert.equal(state.run_status, 'BLOCKED'); assert.ok(Math.abs(state.paused_epoch - nowEpoch) <= 1);
  const paused = { run_status: 'BLOCKED', started_epoch: nowEpoch - 5000, paused_epoch: nowEpoch - 4900 };
  assert.equal(elapsedSeconds(paused), 100);
  const again = { ...paused }; leaveRunning(again, 'CANCELLED'); assert.equal(again.paused_epoch, paused.paused_epoch);
  const notStarted = { run_status: 'PAUSED', started_epoch: 0 }; leaveRunning(notStarted, 'CANCELLED'); assert.equal('paused_epoch' in notStarted, false);
});

test('the engine moves started_epoch forward by the waiting time when a run resumes', async () => {
  const dir = await temporary(); const nowEpoch = Math.floor(Date.now() / 1000);
  const base = { schema_version: 1, work_item_id: 'WI-001', phase: 'EXECUTE', step: 'slice-1', round: 1, max_rounds: 40, gate_failures_here: 0, max_gate_failures: 3, max_wall_seconds: 600, autonomy: 'supervised', gates: Object.fromEntries(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER'].map((g) => [g, { status: 'PENDING', evidence_ids: [] }])), last_result: 'x', next_action: 'y', updated_at: '2026-01-01T00:00:00Z' };
  const script = `. "${repo}/engine/common.sh"; loop_apply_pause_accounting "$1" "$2" && loop_validate_state "$1" && jq -c . "$1"`;
  const run = async (next, old) => { await writeJson(path.join(dir, 'new.json'), next); await writeJson(path.join(dir, 'old.json'), old); const { stdout } = await execFileAsync('bash', ['-c', script, 'pause', path.join(dir, 'new.json'), path.join(dir, 'old.json')]); return JSON.parse(stdout); };
  const blocked = await run({ ...base, run_status: 'BLOCKED', started_epoch: nowEpoch - 50 }, { ...base, run_status: 'RUNNING', started_epoch: nowEpoch - 50 });
  assert.ok(Math.abs(blocked.paused_epoch - nowEpoch) <= 1);
  const resumed = await run({ ...base, run_status: 'RUNNING', started_epoch: nowEpoch - 5050, paused_epoch: nowEpoch - 5000 }, { ...base, run_status: 'BLOCKED', started_epoch: nowEpoch - 5050, paused_epoch: nowEpoch - 5000 });
  assert.equal('paused_epoch' in resumed, false); assert.ok(Math.abs(resumed.started_epoch - (nowEpoch - 50)) <= 1);
  const { stdout } = await execFileAsync('bash', ['-c', `. "${repo}/engine/common.sh"; loop_elapsed_seconds "$1"`, 'elapsed', path.join(dir, 'old.json')]);
  assert.equal(Number(stdout.trim()), 50);
});

test('a run that waited longer than its wall-clock budget can still resume', async () => {
  const root = await activatedDemo(); const stateFile = path.join(root, '.loop', 'state.json'); const nowEpoch = Math.floor(Date.now() / 1000);
  const state = await readJson(stateFile);
  Object.assign(state, { run_status: 'BLOCKED', started_epoch: nowEpoch - 100000, paused_epoch: nowEpoch - 99990, max_wall_seconds: 600 }); await writeJson(stateFile, state);
  const resume = await dispatch(root, 'resume', { request_id: 'resume-after-wait', max_nodes: 1 });
  assert.notEqual(resume.error?.code, 'WALL_CAP_REACHED');
  if (resume.ok) await waitJob(root, resume.job.job_id);
  Object.assign(state, { run_status: 'BLOCKED', started_epoch: nowEpoch - 100000, paused_epoch: nowEpoch - 1000 }); await writeJson(stateFile, state);
  const overrun = await dispatch(root, 'resume', { request_id: 'resume-after-overrun', max_nodes: 1 });
  assert.equal(overrun.error?.code, 'WALL_CAP_REACHED');
});

// --- A cancelled work item may start again under its id ------------------------

test('a cancelled work item starts again under the same id with its old records archived', async () => {
  const root = await activatedDemo(); const loop = path.join(root, '.loop');
  const auth = path.join(loop, 'work-items', 'WI-001.authorization.json'); await writeJson(auth, { planted: true });
  assert.equal((await dispatch(root, 'cancel', {})).ok, true);
  assert.equal((await dispatch(root, 'handover', { note: 'cancelled in test' })).ok, true);
  const again = await dispatch(root, 'task', task({ work_item_id: 'WI-001' }));
  assert.equal(again.ok, true); assert.equal(again.work_item_id, 'WI-001');
  const archives = await fs.readdir(path.join(loop, 'control', 'cancelled'));
  assert.equal(archives.length, 1); assert.match(archives[0], /^WI-001-/);
  const archived = path.join(loop, 'control', 'cancelled', archives[0]);
  assert.equal((await readJson(path.join(archived, 'handover.json'))).kind, 'cancellation');
  assert.deepEqual(await readJson(path.join(archived, 'authorization.json')), { planted: true });
  assert.ok(await exists(path.join(archived, 'work-item.md')));
  assert.equal(await exists(auth), false); assert.equal(await exists(path.join(loop, 'control', 'handovers', 'WI-001.json')), false);
  const state = await readJson(path.join(loop, 'state.json'));
  assert.equal(state.work_item_id, 'WI-001'); assert.equal(state.run_status, 'PAUSED'); assert.equal(state.started_epoch, 0); assert.equal('paused_epoch' in state, false);
});

test('a work item that did not end in cancellation keeps its id', async () => {
  const root = await activatedDemo(); const loop = path.join(root, '.loop');
  const stateFile = path.join(loop, 'state.json'); const state = await readJson(stateFile); state.run_status = 'COMPLETED'; await writeJson(stateFile, state);
  await fs.mkdir(path.join(loop, 'control', 'handovers'), { recursive: true });
  await writeJson(path.join(loop, 'control', 'handovers', 'WI-001.json'), { schema_version: 1, work_item_id: 'WI-001', kind: 'completed-work' });
  const again = await dispatch(root, 'task', task({ work_item_id: 'WI-001' }));
  assert.equal(again.ok, false); assert.equal(again.error.code, 'WORK_ITEM_EXISTS');
  const missing = await dispatch(root, 'task', task({ work_item_id: 'WI-001' }));
  assert.equal(missing.error.code, 'WORK_ITEM_EXISTS');
  await fs.rm(path.join(loop, 'control', 'handovers', 'WI-001.json'));
  const noRecord = await dispatch(root, 'task', task({ work_item_id: 'WI-001' }));
  assert.equal(noRecord.error.code, 'WORK_ITEM_EXISTS');
});
