import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { dispatch } from '../control/index.mjs';
import { approvalSummary, recordTrustedApproval } from '../control/approval.mjs';
import { verifyPlanForApproval } from '../control/setup.mjs';

process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rebind-approval-store-'))); await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

async function temporary() { return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rebind-test-'))); }
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

async function activatedDemo() {
  const root = await temporary(); const prepared = await dispatch(root, 'demo', { kind: 'python' });
  const negative = (await readJson(path.join(root, '.loop', 'candidate', 'setup.plan.json'))).negative_control;
  await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty');
  const activation = await dispatch(root, 'activate', {}); const finished = await waitJob(root, activation.job.job_id);
  assert.equal(finished.job.activation_result.activated, true);
  return { root, negative, setupDigest: prepared.setup_digest };
}

// Simulate a package update: the activation record remembers an older package.
async function ageActivation(root) {
  const file = path.join(root, '.loop', 'control', 'activation.json'); const activation = await readJson(file);
  activation.distribution = { ...activation.distribution, VERSION: '0'.repeat(64), 'control/retired.mjs': '1'.repeat(64) };
  await writeJson(file, activation); return activation;
}

async function snapshot(root) {
  const loop = path.join(root, '.loop'); const items = await fs.readdir(path.join(loop, 'work-items'));
  const files = ['state.json', 'project.adapter.json', 'workflow.json', ...items.map((name) => path.join('work-items', name))];
  return Object.fromEntries(await Promise.all(files.map(async (name) => [name, await fs.readFile(path.join(loop, name), 'utf8')])));
}

test('cancel ends a blocked run with no job in flight, and handover then completes it', async () => {
  const { root } = await activatedDemo(); const stateFile = path.join(root, '.loop', 'state.json');
  const state = await readJson(stateFile); state.run_status = 'BLOCKED'; state.last_result = 'blocked'; state.next_action = 'raise max_rounds or cancel the run'; await writeJson(stateFile, state);
  const pause = await dispatch(root, 'pause', {}); assert.equal(pause.ok, false); assert.equal(pause.error.code, 'NOT_RUNNING');
  const cancel = await dispatch(root, 'cancel', {}); assert.equal(cancel.ok, true);
  const cancelled = await readJson(stateFile); assert.equal(cancelled.run_status, 'CANCELLED'); assert.equal(cancelled.last_result, 'cancelled while not running');
  const again = await dispatch(root, 'cancel', {}); assert.equal(again.ok, false); assert.equal(again.error.code, 'NOT_RUNNING');
  const handover = await dispatch(root, 'handover', { note: 'Cancellation acknowledged in test.' }); assert.equal(handover.ok, true);
  assert.equal((await readJson(stateFile)).run_status, 'COMPLETED');
});

test('cancel also ends a paused run with no job in flight', async () => {
  const { root } = await activatedDemo(); const stateFile = path.join(root, '.loop', 'state.json');
  assert.equal((await readJson(stateFile)).run_status, 'PAUSED');
  const cancel = await dispatch(root, 'cancel', {}); assert.equal(cancel.ok, true); assert.equal((await readJson(stateFile)).run_status, 'CANCELLED');
});

test('rebind re-activates after a package change without touching run state or work items', async () => {
  const { root, negative, setupDigest } = await activatedDemo(); await ageActivation(root);
  const stateFile = path.join(root, '.loop', 'state.json'); const state = await readJson(stateFile); state.run_status = 'BLOCKED'; await writeJson(stateFile, state);
  const refused = await dispatch(root, 'task', { request: 'next', acceptance_criteria: ['a'], out_of_scope: ['b'], allowed_paths: ['src/greet.py'] });
  assert.equal(refused.ok, false); assert.equal(refused.error.code, 'DISTRIBUTION_CHANGED');
  const prepare = await dispatch(root, 'prepare', { request: 'x', acceptance_criteria: ['a'], out_of_scope: ['b'], allowed_paths: ['src'], negative_control: negative });
  assert.equal(prepare.error.code, 'ALREADY_INITIALIZED');
  const before = await snapshot(root);

  const rebind = await dispatch(root, 'rebind', { negative_control: negative });
  assert.equal(rebind.ok, true); assert.equal(rebind.kind, 'rebind'); assert.equal(rebind.status, 'BLOCKED');
  assert.deepEqual(rebind.distribution_changes.changed, ['VERSION']); assert.deepEqual(rebind.distribution_changes.removed, ['control/retired.mjs']); assert.deepEqual(rebind.distribution_changes.added, []);
  const summary = await approvalSummary(root, await verifyPlanForApproval(root));
  assert.equal(summary.kind, 'rebind'); assert.equal(summary.rebind.previous_setup_digest, setupDigest); assert.equal(summary.rebind.run_status, 'BLOCKED'); assert.equal(summary.adapter.adapter_id, 'demo-python');

  const unapproved = await dispatch(root, 'activate', {}); assert.equal(unapproved.ok, false); assert.equal(unapproved.error.code, 'APPROVAL_REQUIRED');
  await recordTrustedApproval(root, rebind.setup_digest, 'interactive-tty');
  const activation = await dispatch(root, 'activate', {}); assert.equal(activation.ok, true);
  const finished = await waitJob(root, activation.job.job_id);
  assert.equal(finished.job.status, 'COMPLETED'); assert.equal(finished.job.activation_result.rebind, true);
  assert.deepEqual(await snapshot(root), before);
  const record = await readJson(path.join(root, '.loop', 'control', 'activation.json'));
  assert.equal(record.setup_digest, rebind.setup_digest); assert.equal(record.rebound_from, setupDigest);
  const evidence = await readJson(path.join(root, '.loop', 'control', 'setup-evidence', `${rebind.setup_digest}.json`));
  assert.equal(evidence.status, 'PASSED'); assert.equal(evidence.negative.passed, true);
  const status = await dispatch(root, 'status', {}); assert.equal(status.activation.valid, true);
  assert.equal((await dispatch(root, 'cancel', {})).ok, true);
  assert.equal((await dispatch(root, 'handover', { note: 'done' })).ok, true);
  const next = await dispatch(root, 'task', { request: 'next', acceptance_criteria: ['a'], out_of_scope: ['b'], allowed_paths: ['src/greet.py'], work_item_id: 'WI-002' });
  assert.equal(next.ok, true);
});

test('rebind refuses when nothing changed, while a run is active, and without an initialized project', async () => {
  const fresh = await temporary(); await dispatch(fresh, 'demo', { kind: 'python' });
  const negativeFresh = (await readJson(path.join(fresh, '.loop', 'candidate', 'setup.plan.json'))).negative_control;
  assert.equal((await dispatch(fresh, 'rebind', { negative_control: negativeFresh })).error.code, 'NOT_INITIALIZED');
  const { root, negative } = await activatedDemo();
  assert.equal((await dispatch(root, 'rebind', { negative_control: negative })).error.code, 'DISTRIBUTION_UNCHANGED');
  await ageActivation(root); const stateFile = path.join(root, '.loop', 'state.json'); const state = await readJson(stateFile); state.run_status = 'RUNNING'; await writeJson(stateFile, state);
  assert.equal((await dispatch(root, 'rebind', { negative_control: negative })).error.code, 'RUN_ACTIVE');
});

test('a rebind approval is void once the source changes, and a failing negative control keeps the old activation', async () => {
  const { root, negative } = await activatedDemo(); const aged = await ageActivation(root);
  const rebind = await dispatch(root, 'rebind', { negative_control: negative }); await recordTrustedApproval(root, rebind.setup_digest, 'interactive-tty');
  await fs.appendFile(path.join(root, 'src', 'greet.py'), '\n# changed after approval\n');
  const changed = await dispatch(root, 'activate', {}); assert.equal(changed.ok, false); assert.equal(changed.error.code, 'SETUP_CHANGED');

  const weak = { ...negative, expected_exit_code: 7 };
  const second = await dispatch(root, 'rebind', { negative_control: weak }); await recordTrustedApproval(root, second.setup_digest, 'interactive-tty');
  const activation = await dispatch(root, 'activate', {}); const finished = await waitJob(root, activation.job.job_id);
  assert.equal(finished.job.status, 'FAILED');
  assert.deepEqual(await readJson(path.join(root, '.loop', 'control', 'activation.json')), aged);
});
