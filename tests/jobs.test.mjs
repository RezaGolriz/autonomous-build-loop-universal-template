// Execution is bounded by the same human boundary as a decision. A work item
// whose authorization sidecar says PAUSED — withdrawn, or never given — may not
// be started, run or resumed by anything automated, whichever entry point the
// call arrives through. A person at their own terminal may still do it, and
// then the record's own scope and budget are the boundary of that run.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { dispatch } from '../control/index.mjs';
import { managedEnvironment } from '../control/jobs.mjs';
import { signHostConfiguration } from '../control/approval-store.mjs';
import { recordTrustedApproval } from '../control/approval.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-approval-store-')));
await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

async function temporary() { return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-test-'))); }
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async (file) => fs.stat(file).then(() => true, () => false);
// A word typed at a real terminal. Every other transport is something an agent
// can call, and the two are exactly what this suite tells apart.
const typed = { channel: 'interactive-tty' };

// A hand-built project: durable state plus a work item, with no activation
// receipt. Enough for every refusal, which happens before anything is launched.
async function project(overrides = {}) {
  const root = await temporary();
  await fs.mkdir(path.join(root, '.loop', 'work-items'), { recursive: true });
  const state = { ...JSON.parse(await fs.readFile(path.join(repo, 'template', '.loop', 'state.example.json'), 'utf8')), ...overrides };
  await fs.writeFile(path.join(root, '.loop', 'state.json'), JSON.stringify(state));
  await fs.copyFile(path.join(repo, 'template', '.loop', 'workflow.json'), path.join(root, '.loop', 'workflow.json'));
  await fs.copyFile(path.join(repo, 'template', 'work-items', 'WI-001-template.md'), path.join(root, '.loop', 'work-items', `${state.work_item_id}.md`));
  return { root, state };
}

async function settle(root, jobId) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const result = await dispatch(root, 'status', { job_id: jobId });
    if (!['QUEUED', 'RUNNING', 'STOPPING'].includes(result.job?.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`job ${jobId} did not finish in time`);
}

// A project that is activated, configured and paused, ready to be started.
async function activatedProject() {
  const root = await temporary();
  const prepared = await dispatch(root, 'demo', { kind: 'docs' });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty');
  const activation = await dispatch(root, 'activate', {});
  assert.equal(activation.ok, true, JSON.stringify(activation));
  await settle(root, activation.job.job_id);
  const configFile = path.join(root, '.loop', 'host.local.json');
  const config = await readJson(configFile);
  delete config.host_signature;
  config.host_signature = await signHostConfiguration(root, config);
  await fs.writeFile(configFile, JSON.stringify(config));
  return root;
}

const pausedRecord = (id) => ({
  schema_version: 1, item_id: id, state: 'PAUSED',
  scope: { allowed_paths: ['docs/guide.md'] }, budget: { max_rounds: 5, max_wall_seconds: 900 },
  expires_at: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  stop_on_first_failure: true, authorized_by: 'interactive-tty', authorized_at: '2026-01-01T00:00:00Z',
});

test('a withdrawn authorization refuses start, run and resume from every automated channel', async () => {
  const { root } = await project({ run_status: 'RUNNING', phase: 'EXECUTE' });
  await fs.writeFile(path.join(root, '.loop', 'work-items', 'WI-001.authorization.json'), JSON.stringify(pausedRecord('WI-001')));
  const before = await fs.readFile(path.join(root, '.loop', 'state.json'), 'utf8');
  for (const channel of ['mcp-user', 'cli-input']) {
    for (const operation of ['start', 'run', 'resume']) {
      const refused = await dispatch(root, operation, { request_id: `${channel}-${operation}`, max_nodes: 1 }, { channel });
      assert.equal(refused.ok, false, `${channel} ${operation}: ${JSON.stringify(refused)}`);
      assert.equal(refused.error.code, 'AUTHORIZATION_REVOKED', `${channel} ${operation}`);
      assert.match(refused.error.message, /authorize the item again, or start it from an interactive terminal/);
    }
  }
  // Nothing was launched and nothing was written.
  assert.equal(await exists(path.join(root, '.loop', 'control', 'job.lock')), false);
  assert.equal(await exists(path.join(root, '.loop', 'control', 'current-job.json')), false);
  assert.equal(await fs.readFile(path.join(root, '.loop', 'state.json'), 'utf8'), before);
});

test('an item with no authorization sidecar at all is a manual item and is not refused', async () => {
  const { root } = await project();
  // No sidecar, no activation receipt and no provider, so the launch itself
  // cannot succeed; what matters is the reason it does not.
  const result = await dispatch(root, 'start', { request_id: 'manual-start', max_nodes: 1 }, { channel: 'mcp-user' });
  assert.equal(result.ok, false);
  assert.notEqual(result.error.code, 'AUTHORIZATION_REVOKED');
});

test('the environment a managed job passes down never carries the human terminal override', () => {
  process.env.BUILD_LOOP_HUMAN_TTY = '1';
  try {
    const environment = managedEnvironment({ LOOP_JOB_ID: 'job-1' });
    assert.equal(Object.hasOwn(environment, 'BUILD_LOOP_HUMAN_TTY'), false);
    assert.equal(environment.LOOP_JOB_ID, 'job-1');
  } finally { delete process.env.BUILD_LOOP_HUMAN_TTY; }
});

test('a person at a terminal may start a withdrawn item, still inside its recorded scope', { timeout: 300000 }, async () => {
  const root = await activatedProject();
  const current = await readJson(path.join(root, '.loop', 'state.json'));
  const item = current.work_item_id;
  assert.ok(current.max_rounds > 5, `the demo has to start wider than the withdrawn budget, got ${current.max_rounds}`);
  // A real decision, then withdrawn: the sidecar keeps the scope and budget the
  // person once agreed to, and its state says a person has to act.
  // The scope is deliberately narrower than the item's own execution slice, so
  // that the run has something to be stopped by.
  await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: item, allowed_paths: ['docs/reference.md'], max_rounds: 5, max_wall_seconds: 900 }, typed);
  const withdrawn = await dispatch(root, 'deauthorize', { item_id: item }, typed);
  assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
  assert.equal((await readJson(path.join(root, '.loop', 'work-items', `${item}.authorization.json`))).state, 'PAUSED');

  // Withdrawing the decision put the whole project on hold as well, so an
  // automated start is refused for that reason first.
  const held = await dispatch(root, 'start', { request_id: 'held-start', max_nodes: 1 }, { channel: 'mcp-user' });
  assert.equal(held.ok, false, JSON.stringify(held));
  assert.equal(held.error.code, 'PROJECT_ON_HOLD');
  const released = await dispatch(root, 'release', { confirm: 'RELEASE' }, typed);
  assert.equal(released.ok, true, JSON.stringify(released));
  const refused = await dispatch(root, 'start', { request_id: 'automated-start', max_nodes: 1 }, { channel: 'mcp-user' });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.error.code, 'AUTHORIZATION_REVOKED');

  const started = await dispatch(root, 'start', { request_id: 'typed-start', max_nodes: 3 }, typed);
  assert.equal(started.ok, true, JSON.stringify(started));
  const job = await readJson(path.join(root, '.loop', 'control', 'current-job.json'));
  // The run is not authorized; it is a person's own run, and it is recorded as
  // exactly that, so the Bash orchestrator sees the same thing.
  assert.equal(job.authorization_ref, undefined);
  assert.equal(job.human_entry.channel, 'interactive-tty');
  assert.equal(job.human_entry.item_id, item);
  // The withdrawn budget still narrows the run.
  assert.equal((await readJson(path.join(root, '.loop', 'state.json'))).max_rounds, 5);

  await settle(root, started.job.job_id);
  // And the withdrawn scope is still the outer boundary: the item's execution
  // slice reaches outside it, so the DESIGN gate fails and the run stops for a
  // person instead of working outside what was ever agreed.
  const state = await readJson(path.join(root, '.loop', 'state.json'));
  assert.equal(state.run_status, 'BLOCKED', JSON.stringify(state.gates));
  assert.equal(state.gates.DESIGN.status, 'PENDING');
  assert.match(await fs.readFile(path.join(root, '.loop', 'blockers.md'), 'utf8'), /DESIGN .*slice path outside authorized scope: docs\/guide\.md/);
});
