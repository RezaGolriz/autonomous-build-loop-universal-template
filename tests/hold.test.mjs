// A project-wide hold. Withdrawing an authorization stops one item; the hold
// stops the project. The bypass this suite exists for is the obvious one: an
// agent whose item was deauthorized cancels the run, acknowledges the handover,
// writes a new work item with a scope of its own choosing, and starts that.
// The new item has a new id, so no withdrawn decision mentions it — but the
// hold is on the project, and every automated entry point is refused while it
// is there.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { dispatch, operations } from '../control/index.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hold-approval-store-')));
await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

const typed = { channel: 'interactive-tty' };
const agent = { channel: 'mcp-user' };
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async (file) => fs.stat(file).then(() => true, () => false);
const holdFile = (root) => path.join(root, '.loop', 'control', 'hold.json');

async function project(overrides = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hold-test-')));
  await fs.mkdir(path.join(root, '.loop', 'work-items'), { recursive: true });
  const state = { ...JSON.parse(await fs.readFile(path.join(repo, 'template', '.loop', 'state.example.json'), 'utf8')), ...overrides };
  await fs.writeFile(path.join(root, '.loop', 'state.json'), JSON.stringify(state));
  await fs.copyFile(path.join(repo, 'template', '.loop', 'workflow.json'), path.join(root, '.loop', 'workflow.json'));
  await fs.copyFile(path.join(repo, 'template', 'work-items', 'WI-001-template.md'), path.join(root, '.loop', 'work-items', `${state.work_item_id}.md`));
  return { root, state };
}

function authorization(id, overrides = {}) {
  return {
    schema_version: 1, item_id: id, state: 'READY',
    scope: { allowed_paths: ['docs/guide.md'] }, budget: { max_rounds: 9, max_wall_seconds: 600 },
    expires_at: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    stop_on_first_failure: true, authorized_by: 'interactive-tty', authorized_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

async function authorized(overrides = {}) {
  const { root, state } = await project(overrides);
  await fs.writeFile(path.join(root, '.loop', 'work-items', `${state.work_item_id}.authorization.json`), JSON.stringify(authorization(state.work_item_id)));
  return { root, state };
}

const taskArgs = (id) => ({
  work_item_id: id, request: 'Write a short note.', acceptance_criteria: ['The note exists.'],
  out_of_scope: ['Anything else.'], allowed_paths: ['docs/**'],
});

test('hold and release are offered with strict schemas', () => {
  assert.ok(operations.hold);
  assert.ok(operations.release);
  assert.equal(operations.hold.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(operations.hold.inputSchema.properties), ['reason', 'item_id']);
  assert.deepEqual(operations.release.inputSchema.required, ['confirm']);
  assert.equal(operations.release.inputSchema.properties.confirm.const, 'RELEASE');
});

test('deauthorize places a project-wide hold and every automated entry point is refused', async () => {
  const { root, state } = await authorized({ run_status: 'RUNNING', phase: 'EXECUTE' });
  const withdrawn = await dispatch(root, 'deauthorize', { item_id: state.work_item_id }, agent);
  assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
  assert.equal(withdrawn.project_on_hold, true);

  const record = await readJson(holdFile(root));
  assert.equal(record.schema_version, 1);
  assert.equal(record.item_id, state.work_item_id);
  assert.equal(record.held_by, 'mcp-user');
  assert.match(record.held_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(typeof record.reason, 'string');

  for (const [operation, args] of [
    ['start', { request_id: 'held-start', max_nodes: 1 }],
    ['run', { request_id: 'held-run', max_nodes: 1 }],
    ['resume', { request_id: 'held-resume', max_nodes: 1 }],
    ['tick', {}],
    ['task', taskArgs('WI-900')],
    ['scout', {}],
  ]) {
    const refused = await dispatch(root, operation, args, agent);
    assert.equal(refused.ok, false, `${operation}: ${JSON.stringify(refused)}`);
    assert.equal(refused.error.code, 'PROJECT_ON_HOLD', operation);
    assert.equal(refused.error.details.hold_file, '.loop/control/hold.json');
  }
  // Nothing was launched and no new work item was written.
  assert.equal(await exists(path.join(root, '.loop', 'control', 'current-job.json')), false);
  assert.equal(await exists(path.join(root, '.loop', 'work-items', 'WI-900.md')), false);
});

test('the cancel, handover, task, start sequence does not escape a hold', async () => {
  // The bypass an independent review found: after a deauthorize, stop the run,
  // acknowledge the handover, and start a brand new item under a scope the
  // agent chose itself. Every step that could run something is refused.
  const { root, state } = await authorized({ run_status: 'RUNNING', phase: 'EXECUTE' });
  await dispatch(root, 'deauthorize', { item_id: state.work_item_id }, agent);

  // Stopping is allowed: a hold is about not starting, never about not stopping.
  const cancelled = await dispatch(root, 'cancel', {}, agent);
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  const handed = await dispatch(root, 'handover', { note: 'Cancelled by the agent.' }, agent);
  assert.equal(handed.ok, true, JSON.stringify(handed));
  assert.equal((await readJson(path.join(root, '.loop', 'state.json'))).run_status, 'COMPLETED');

  // The new item with its self-chosen scope is refused before it is written.
  const task = await dispatch(root, 'task', taskArgs('WI-777'), agent);
  assert.equal(task.ok, false, JSON.stringify(task));
  assert.equal(task.error.code, 'PROJECT_ON_HOLD');
  assert.equal(await exists(path.join(root, '.loop', 'work-items', 'WI-777.md')), false);

  // And so is starting anything at all, under whatever item id.
  const started = await dispatch(root, 'start', { request_id: 'bypass-start', max_nodes: 1 }, agent);
  assert.equal(started.ok, false, JSON.stringify(started));
  assert.equal(started.error.code, 'PROJECT_ON_HOLD');
  assert.equal(await exists(path.join(root, '.loop', 'control', 'current-job.json')), false);
});

test('a person at an interactive terminal may still work in a held project', async () => {
  const { root } = await authorized();
  await dispatch(root, 'hold', { reason: 'Stopping to look at something.' }, agent);
  // No activation receipt and no provider, so the start cannot succeed; what
  // matters is that it was not refused because of the hold.
  const started = await dispatch(root, 'start', { request_id: 'typed-start', max_nodes: 1 }, typed);
  assert.equal(started.ok, false, JSON.stringify(started));
  assert.notEqual(started.error.code, 'PROJECT_ON_HOLD');
  const ticked = await dispatch(root, 'tick', {}, typed);
  assert.notEqual(ticked.error?.code, 'PROJECT_ON_HOLD');
});

test('any channel may place a hold, and the first recorded reason stands', async () => {
  const { root } = await project();
  const placed = await dispatch(root, 'hold', { reason: 'The build machine is being replaced.' }, agent);
  assert.equal(placed.ok, true, JSON.stringify(placed));
  assert.equal(placed.already_held, false);
  assert.equal(placed.hold.reason, 'The build machine is being replaced.');
  const again = await dispatch(root, 'hold', { reason: 'Something else.' }, typed);
  assert.equal(again.already_held, true);
  assert.equal((await readJson(holdFile(root))).reason, 'The build machine is being replaced.');
});

test('release takes the hold off from a terminal and asks for a confirmation from a chat tool call', async () => {
  const { root } = await project();
  await dispatch(root, 'hold', { reason: 'Stop everything.' }, agent);

  // A chat tool call never completes the decision: it gets a pending request
  // and a link to the local confirmation page, and the hold stays on.
  const pending = await dispatch(root, 'release', { confirm: 'RELEASE' }, agent);
  assert.equal(pending.ok, true, JSON.stringify(pending));
  assert.equal(pending.pending_confirmation, true);
  assert.equal(pending.completed, false);
  assert.equal(pending.confirmation_word, 'RELEASE');
  assert.ok(pending.confirmation_url.startsWith('http://'));
  assert.equal(await exists(holdFile(root)), true);

  // A word typed at an interactive terminal completes it.
  const released = await dispatch(root, 'release', { confirm: 'RELEASE' }, typed);
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.equal(released.released, true);
  assert.equal(await exists(holdFile(root)), false);

  // And then the automated entry points work again.
  const ticked = await dispatch(root, 'tick', {}, agent);
  assert.equal(ticked.ok, true, JSON.stringify(ticked));
  assert.equal(ticked.action, 'nothing');

  const nothingToRelease = await dispatch(root, 'release', { confirm: 'RELEASE' }, typed);
  assert.equal(nothingToRelease.ok, false);
  assert.equal(nothingToRelease.error.code, 'NOT_ON_HOLD');
});

test('a hold record that cannot be read still holds', async () => {
  const { root } = await project();
  await fs.mkdir(path.join(root, '.loop', 'control'), { recursive: true });
  await fs.writeFile(holdFile(root), 'this is not a hold record');
  const refused = await dispatch(root, 'tick', {}, agent);
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.error.code, 'PROJECT_ON_HOLD');
});

test('check and status show the hold prominently', async () => {
  const { root, state } = await authorized();
  await dispatch(root, 'deauthorize', { item_id: state.work_item_id }, typed);
  const checked = await dispatch(root, 'check', {}, agent);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.equal(checked.hold.held, true);
  assert.equal(checked.hold.item_id, state.work_item_id);
  assert.equal(checked.hold.held_by, 'interactive-tty');
  assert.match(checked.next_action, /on hold/);
  const reported = await dispatch(root, 'status', {}, agent);
  assert.equal(reported.hold.held, true);
  assert.equal(typeof reported.hold.reason, 'string');
});
