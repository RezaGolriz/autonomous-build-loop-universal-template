import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { dispatch, operations } from '../control/index.mjs';
import { checkExitCode } from '../control/check.mjs';
import { signHostConfiguration } from '../control/approval-store.mjs';
import { recordTrustedApproval } from '../control/approval.mjs';
import { recordConfirmation } from '../control/confirm.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'backlog-approval-store-')));
await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

async function temporary() { return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'backlog-test-'))); }

// A hand-built project: the durable state file plus a work item, without an
// activation receipt. Enough for lifecycle operations that never run a node.
async function project(overrides = {}) {
  const root = await temporary();
  await fs.mkdir(path.join(root, '.loop', 'work-items'), { recursive: true });
  const state = { ...JSON.parse(await fs.readFile(path.join(repo, 'template', '.loop', 'state.example.json'), 'utf8')), ...overrides };
  await fs.writeFile(path.join(root, '.loop', 'state.json'), JSON.stringify(state));
  await fs.copyFile(path.join(repo, 'template', '.loop', 'workflow.json'), path.join(root, '.loop', 'workflow.json'));
  await fs.copyFile(path.join(repo, 'template', 'work-items', 'WI-001-template.md'), path.join(root, '.loop', 'work-items', `${state.work_item_id}.md`));
  return { root, state };
}

function passedGates(passed) {
  return Object.fromEntries(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER']
    .map((phase) => [phase, { status: passed.includes(phase) ? 'PASSED' : 'PENDING', evidence_ids: [] }]));
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
// A word typed at an interactive terminal. Every other transport has to ask for
// a local confirmation instead, which the confirmation tests below cover.
const typed = { channel: 'interactive-tty' };

test('every new lifecycle operation is offered with a description and an object schema', () => {
  for (const name of ['check', 'backlog_add', 'backlog_list', 'backlog_remove', 'accept', 'authorize', 'deauthorize']) {
    assert.ok(operations[name], name);
    assert.equal(typeof operations[name].description, 'string');
    assert.equal(operations[name].inputSchema.type, 'object');
    assert.equal(operations[name].inputSchema.additionalProperties, false);
  }
});

test('backlog_add creates the backlog file and a work item without starting anything', async () => {
  const { root } = await project();
  const added = await dispatch(root, 'backlog_add', { title: 'Explain the retry rules', work_kind: 'documentation', outcome: 'A reader can tell when a retry is allowed.' });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.started, false);
  assert.equal(added.item_id, 'WI-002');
  const backlog = await readJson(path.join(root, '.loop', 'backlog.json'));
  assert.equal(backlog.schema_version, 1);
  assert.equal(backlog.items.length, 1);
  assert.equal(backlog.items[0].id, 'WI-002');
  assert.equal(backlog.items[0].work_kind, 'documentation');
  assert.ok(backlog.items[0].added_at);
  const work = await fs.readFile(path.join(root, '.loop', 'work-items', 'WI-002.md'), 'utf8');
  assert.match(work, /^# WI-002: Explain the retry rules$/m);
  assert.match(work, /^Kind: documentation$/m);
  assert.match(work, /> A reader can tell when a retry is allowed\./);
  // The run itself is untouched.
  assert.equal((await readJson(path.join(root, '.loop', 'state.json'))).run_status, 'PAUSED');

  const listed = await dispatch(root, 'backlog_list', {});
  assert.deepEqual(listed.backlog.items.map((item) => [item.id, item.authorization_state]), [['WI-002', 'PAUSED']]);
  assert.equal(listed.backlog.ready, 0);
  assert.equal(listed.backlog.paused, 1);

  const duplicate = await dispatch(root, 'backlog_add', { id: 'WI-002', title: 'Again', outcome: 'Again.' });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, 'BACKLOG_ITEM_EXISTS');
});

test('authorize writes a READY record with a one-day expiry and stop on first failure', async () => {
  const { root } = await project();
  await dispatch(root, 'backlog_add', { id: 'WI-010', title: 'Bounded change', outcome: 'A bounded change lands.' });
  const refused = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-010' }, typed);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'MISSING_INPUT');

  const before = Date.now();
  const authorized = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-010', allowed_paths: ['docs/guide.md'], note: 'Agreed in review.' }, typed);
  assert.equal(authorized.ok, true, JSON.stringify(authorized));
  assert.equal(authorized.started, false);
  const record = await readJson(path.join(root, '.loop', 'work-items', 'WI-010.authorization.json'));
  assert.equal(record.schema_version, 1);
  assert.equal(record.state, 'READY');
  assert.equal(record.item_id, 'WI-010');
  assert.equal(record.stop_on_first_failure, true);
  assert.deepEqual(record.scope.allowed_paths, ['docs/guide.md']);
  assert.equal(record.budget.max_rounds, 40);
  assert.equal(record.budget.max_wall_seconds, 14400);
  // The default expiry is 24 hours from the decision.
  const expiry = Date.parse(record.expires_at) - before;
  assert.ok(expiry > 23 * 3600 * 1000 && expiry <= 24 * 3600 * 1000 + 5000, record.expires_at);
  // The word was typed at an interactive terminal, and that is what is recorded.
  assert.equal(record.authorized_by, 'interactive-tty');

  assert.equal((await dispatch(root, 'backlog_list', {})).backlog.ready, 1);

  const unconfirmed = await dispatch(root, 'authorize', { item_id: 'WI-010', allowed_paths: ['docs/guide.md'] }, typed);
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.error.code, 'MISSING_INPUT');

  const deauthorized = await dispatch(root, 'deauthorize', { item_id: 'WI-010' });
  assert.equal(deauthorized.ok, true);
  assert.equal(deauthorized.authorization.state, 'PAUSED');
  const paused = await readJson(path.join(root, '.loop', 'work-items', 'WI-010.authorization.json'));
  assert.equal(paused.state, 'PAUSED');
  assert.equal(paused.expires_at, undefined);
  assert.equal((await dispatch(root, 'backlog_list', {})).backlog.ready, 0);
});

test('check reports the situation with distinct exit codes and never writes', async () => {
  const paused = await project();
  const pausedResult = await dispatch(paused.root, 'check', {});
  assert.equal(pausedResult.ok, true);
  assert.equal(pausedResult.run_status, 'PAUSED');
  assert.equal(pausedResult.phase, 'DEFINE');
  assert.equal(pausedResult.handover_ready, false);
  assert.equal(pausedResult.judge_verdict, null);
  assert.deepEqual(pausedResult.backlog, { ready: 0, paused: 0 });
  assert.equal(pausedResult.inbox, 0);
  assert.equal(pausedResult.open_blockers, 0);
  assert.equal(checkExitCode(pausedResult), 3);

  const blocked = await project({ run_status: 'BLOCKED', phase: 'DESIGN' });
  await fs.writeFile(path.join(blocked.root, '.loop', 'blockers.md'), '# Blockers\n\n- [ ] DESIGN run-1: Choose A or B\n');
  const blockedResult = await dispatch(blocked.root, 'check', {});
  assert.equal(blockedResult.run_status, 'BLOCKED');
  assert.equal(blockedResult.open_blockers, 1);
  assert.equal(checkExitCode(blockedResult), 4);

  const ready = await project({ run_status: 'WAITING_FOR_HUMAN', phase: 'HANDOVER', gates: passedGates(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER']) });
  const state = await readJson(path.join(ready.root, '.loop', 'state.json'));
  state.gates.REVIEW.evidence_ids = ['review-run-1'];
  await fs.writeFile(path.join(ready.root, '.loop', 'state.json'), JSON.stringify(state));
  await fs.mkdir(path.join(ready.root, '.loop', 'evidence'), { recursive: true });
  await fs.writeFile(path.join(ready.root, '.loop', 'evidence', 'review-run-1.json'), JSON.stringify({ schema_version: 1, evidence_id: 'review-run-1', work_item_id: state.work_item_id, phase: 'REVIEW', evidence_type: 'independent-review', result: 'PASSED', details: { verdict: 'PASS' } }));
  const before = await fs.readFile(path.join(ready.root, '.loop', 'state.json'), 'utf8');
  const readyResult = await dispatch(ready.root, 'check', {});
  assert.equal(readyResult.handover_ready, true);
  assert.equal(readyResult.judge_verdict, 'PASS');
  assert.equal(checkExitCode(readyResult), 0);
  assert.match(readyResult.verified_success_requires, /handover_ready alone/);
  assert.equal(await fs.readFile(path.join(ready.root, '.loop', 'state.json'), 'utf8'), before);

  assert.equal(checkExitCode({ ok: false, error: { code: 'INVALID_ROOT', message: 'no' } }), 2);
});

test('accept refuses an unfinished run, then archives and promotes the next backlog item', async () => {
  const unfinished = await project({ run_status: 'RUNNING', phase: 'EXECUTE' });
  const refused = await dispatch(unfinished.root, 'accept', { confirm: 'ACCEPT' }, typed);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'HANDOVER_NOT_READY');

  const { root } = await project({ run_status: 'WAITING_FOR_HUMAN', phase: 'HANDOVER', max_rounds: 12, max_gate_failures: 2, max_wall_seconds: 900, autonomy: 'guarded', gates: passedGates(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER']) });
  await fs.mkdir(path.join(root, '.loop', 'evidence'), { recursive: true });
  await fs.writeFile(path.join(root, '.loop', 'evidence', 'validate-run-1.json'), JSON.stringify({ schema_version: 1, evidence_id: 'validate-run-1', work_item_id: 'WI-001', phase: 'VALIDATE', evidence_type: 'command', result: 'PASSED', captured_at: '2026-01-01T00:00:00Z' }));
  await dispatch(root, 'backlog_add', { id: 'WI-002', title: 'Next bounded item', outcome: 'The next item is defined.' });
  await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-001', allowed_paths: ['docs/guide.md'] }, typed);

  const unconfirmed = await dispatch(root, 'accept', {}, typed);
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.error.code, 'MISSING_INPUT');

  const accepted = await dispatch(root, 'accept', { confirm: 'ACCEPT', note: 'Reviewed the evidence.' }, typed);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.accepted_work_item_id, 'WI-001');
  assert.equal(accepted.promoted_work_item_id, 'WI-002');
  assert.equal(accepted.external_action_performed, false);
  assert.match(accepted.archived_to, /^\.loop\/history\/WI-001-\d{8}T\d{6}Z$/);

  const history = path.join(root, accepted.archived_to);
  assert.deepEqual((await fs.readdir(history)).sort(), ['WI-001.md', 'acceptance.json', 'authorization.json', 'evidence-records.json', 'next-steps.md', 'state.json']);
  assert.equal((await readJson(path.join(history, 'state.json'))).work_item_id, 'WI-001');
  assert.deepEqual((await readJson(path.join(history, 'evidence-records.json'))).records.map((item) => item.evidence_id), ['validate-run-1']);
  assert.equal((await readJson(path.join(history, 'acceptance.json'))).accepted_by, 'interactive-tty');

  const promoted = await readJson(path.join(root, '.loop', 'state.json'));
  assert.equal(promoted.work_item_id, 'WI-002');
  assert.equal(promoted.run_status, 'PAUSED');
  assert.equal(promoted.phase, 'DEFINE');
  assert.equal(promoted.round, 0);
  assert.ok(Object.values(promoted.gates).every((gate) => gate.status === 'PENDING'));
  // The adapter caps of the accepted run are carried over unchanged.
  assert.equal(promoted.max_rounds, 12);
  assert.equal(promoted.max_gate_failures, 2);
  assert.equal(promoted.max_wall_seconds, 900);
  assert.equal(promoted.autonomy, 'guarded');
  assert.deepEqual((await readJson(path.join(root, '.loop', 'backlog.json'))).items, []);
});

test('accept with an empty backlog completes the accepted item', async () => {
  const { root } = await project({ run_status: 'WAITING_FOR_HUMAN', phase: 'HANDOVER', gates: passedGates(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER']) });
  const accepted = await dispatch(root, 'accept', { confirm: 'ACCEPT' }, typed);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.promoted_work_item_id, null);
  assert.equal(accepted.run_status, 'COMPLETED');
  const state = await readJson(path.join(root, '.loop', 'state.json'));
  assert.equal(state.run_status, 'COMPLETED');
  assert.equal(state.work_item_id, 'WI-001');
  const followUp = await dispatch(root, 'check', {});
  assert.equal(followUp.run_status, 'COMPLETED');
  assert.equal(checkExitCode(followUp), 0);
});

test('accept refuses while a managed job is still active', async () => {
  const { root } = await project({ run_status: 'WAITING_FOR_HUMAN', phase: 'HANDOVER', gates: passedGates(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER']) });
  const control = path.join(root, '.loop', 'control', 'jobs');
  await fs.mkdir(control, { recursive: true });
  await fs.writeFile(path.join(control, 'job-active.json'), JSON.stringify({ schema_version: 1, job_id: 'job-active', status: 'RUNNING' }));
  await fs.writeFile(path.join(root, '.loop', 'control', 'current-job.json'), JSON.stringify({ schema_version: 1, job_id: 'job-active' }));
  const refused = await dispatch(root, 'accept', { confirm: 'ACCEPT' }, typed);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'JOB_ACTIVE');
  assert.equal((await readJson(path.join(root, '.loop', 'state.json'))).run_status, 'WAITING_FOR_HUMAN');
});

test('status reports authorization, backlog and inbox alongside the run', async () => {
  const { root } = await project();
  await dispatch(root, 'backlog_add', { id: 'WI-002', title: 'Queued item', outcome: 'Queued.' });
  await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-001', allowed_paths: ['docs/guide.md'] }, typed);
  await fs.mkdir(path.join(root, '.loop', 'inbox'), { recursive: true });
  await fs.writeFile(path.join(root, '.loop', 'inbox', 'proposal-1.md'), '# Proposal\n');
  const result = await dispatch(root, 'status', {});
  assert.equal(result.ok, true);
  assert.equal(result.authorization.state, 'READY');
  assert.equal(result.authorization.item_id, 'WI-001');
  assert.deepEqual(result.backlog.items.map((item) => item.id), ['WI-002']);
  assert.equal(result.backlog.ready, 0);
  assert.equal(result.backlog.paused, 1);
  assert.equal(result.inbox, 1);
});

test('start copies the authorized budget into state and records the authorization reference', async () => {
  const root = await temporary();
  const prepared = await dispatch(root, 'demo', { kind: 'docs' });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty');
  const activation = await dispatch(root, 'activate', {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await dispatch(root, 'status', { job_id: activation.job.job_id });
    if (!['QUEUED', 'RUNNING', 'STOPPING'].includes(result.job?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const configFile = path.join(root, '.loop', 'host.local.json');
  const config = await readJson(configFile);
  delete config.host_signature;
  config.host_signature = await signHostConfiguration(root, config);
  await fs.writeFile(configFile, JSON.stringify(config));

  const current = await readJson(path.join(root, '.loop', 'state.json'));
  const authorized = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: current.work_item_id, allowed_paths: ['docs/guide.md'], max_rounds: 11, max_wall_seconds: 1800 }, typed);
  assert.equal(authorized.ok, true, JSON.stringify(authorized));
  const started = await dispatch(root, 'start', { request_id: 'authorized-start', max_nodes: 1 });
  assert.equal(started.ok, true, JSON.stringify(started));
  const state = await readJson(path.join(root, '.loop', 'state.json'));
  assert.equal(state.max_rounds, 11);
  assert.equal(state.max_wall_seconds, 1800);
  const job = await readJson(path.join(root, '.loop', 'control', 'current-job.json'));
  assert.equal(job.authorization_ref.item_id, current.work_item_id);
  assert.equal(job.authorization_ref.stop_on_first_failure, true);
});

test('start refuses an expired READY authorization', async () => {
  const { root } = await project();
  const expired = {
    schema_version: 1, item_id: 'WI-001', state: 'READY',
    scope: { allowed_paths: ['docs/guide.md'] }, budget: { max_rounds: 9, max_wall_seconds: 600 },
    expires_at: '2000-01-01T00:00:00Z', stop_on_first_failure: true,
    authorized_by: 'interactive-tty', authorized_at: '2000-01-01T00:00:00Z',
  };
  await fs.writeFile(path.join(root, '.loop', 'work-items', 'WI-001.authorization.json'), JSON.stringify(expired));
  const refused = await dispatch(root, 'start', { request_id: 'expired-authorization', max_nodes: 1 });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'AUTHORIZATION_EXPIRED');
  assert.equal((await readJson(path.join(root, '.loop', 'state.json'))).max_rounds, 40);
  assert.equal(await fs.stat(path.join(root, '.loop', 'control', 'job.lock')).then(() => true, () => false), false);
});

test('a decision from a chat tool call returns a confirmation link and changes nothing', async () => {
  const { root } = await project();
  await dispatch(root, 'backlog_add', { id: 'WI-020', title: 'Bounded change', outcome: 'A bounded change lands.' });
  const requested = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-020', allowed_paths: ['docs/guide.md'] });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  assert.equal(requested.pending_confirmation, true);
  assert.equal(requested.completed, false);
  assert.equal(requested.item_id, 'WI-020');
  assert.match(requested.confirmation_url, /^http:\/\/127\.0\.0\.1:\d+\/confirm\?token=/);
  // Nothing was authorized: the sidecar does not exist yet.
  assert.equal(await fs.stat(path.join(root, '.loop', 'work-items', 'WI-020.authorization.json')).then(() => true, () => false), false);
  assert.equal((await dispatch(root, 'backlog_list', {})).backlog.ready, 0);

  // The same call again hands out the same link rather than a second one.
  const again = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-020', allowed_paths: ['docs/guide.md'] });
  assert.equal(again.request_id, requested.request_id);
  assert.equal(again.idempotent, true);

  // The page displays the frozen decision, defaults and expiry included.
  const page = await fetch(requested.confirmation_url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Confirm a human decision/);
  assert.match(html, /WI-020/);
  assert.match(html, /40 rounds, 14400 seconds of wall clock/);
  assert.match(html, /local-user-action/);
  assert.ok(html.includes(requested.decision.record.expires_at));
  const origin = new URL(requested.confirmation_url).origin;
  // The page carries the digest of the decision it displays back with the form.
  assert.ok(html.includes(`name="request_digest" value="${requested.request_digest}"`));
  const post = (body) => fetch(requested.confirmation_url, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });

  // Pressing the button without typing the word records nothing at all.
  const empty = await post(`decision=&request_digest=${requested.request_digest}`);
  assert.equal(empty.status, 400);
  const wrong = await post(`decision=ACCEPT&request_digest=${requested.request_digest}`);
  assert.equal(wrong.status, 400);
  // A form that does not carry the digest of the displayed decision, or carries
  // a different one, confirms nothing: the word alone is not the decision.
  assert.equal((await post('decision=AUTHORIZE')).status, 409);
  assert.equal((await post(`decision=AUTHORIZE&request_digest=${'0'.repeat(64)}`)).status, 409);
  assert.equal(await fs.stat(path.join(root, '.loop', 'work-items', 'WI-020.authorization.json')).then(() => true, () => false), false);

  const posted = await post(`decision=AUTHORIZE&request_digest=${requested.request_digest}`);
  assert.equal(posted.status, 200, await posted.text());

  const record = await readJson(path.join(root, '.loop', 'work-items', 'WI-020.authorization.json'));
  // Exactly the record that was frozen and displayed is the record on disk.
  assert.deepEqual(record, requested.decision.record);
  assert.equal(record.state, 'READY');
  assert.equal(record.authorized_by, 'local-http-user');
  assert.equal(record.assurance, 'local-user-action');
  assert.deepEqual(record.scope.allowed_paths, ['docs/guide.md']);
  const receipt = await readJson(path.join(root, '.loop', 'scheduler', 'operation-approvals', `${requested.request_id}.json`));
  assert.equal(receipt.operation, 'authorize');
  assert.equal(receipt.request_id, requested.request_id);
  assert.equal(receipt.request_digest, requested.request_digest);
  assert.equal(receipt.assurance, 'local-user-action');
});

test('accept from an input file becomes a pending request, and a recorded confirmation is settled by the next call', async () => {
  const { root } = await project({ run_status: 'WAITING_FOR_HUMAN', phase: 'HANDOVER', gates: passedGates(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER']) });
  const requested = await dispatch(root, 'accept', { confirm: 'ACCEPT' }, { channel: 'cli-input' });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  assert.equal(requested.pending_confirmation, true);
  assert.equal(requested.item_id, 'WI-001');
  assert.equal((await readJson(path.join(root, '.loop', 'state.json'))).run_status, 'WAITING_FOR_HUMAN');

  // The confirmation is recorded, but the server does not get to run it: the
  // next human-decision call settles the receipt it left behind.
  await recordConfirmation(root, requested.request_id, 'ACCEPT');
  const settled = await dispatch(root, 'accept', { confirm: 'ACCEPT' }, { channel: 'cli-input' });
  // The confirmed acceptance ran first, so this second call has nothing left
  // to accept and says so instead of asking for another confirmation.
  assert.equal(settled.ok, false, JSON.stringify(settled));
  assert.equal(settled.error.code, 'HANDOVER_NOT_READY');
  assert.equal((await readJson(path.join(root, '.loop', 'state.json'))).run_status, 'COMPLETED');
  const result = await readJson(path.join(root, '.loop', 'scheduler', 'operation-results', `${requested.request_id}.json`));
  assert.equal(result.result.ok, true);
  assert.equal(result.result.accepted_work_item_id, 'WI-001');
});

test('an authorization with an unusable expiry is invalid, never READY', async () => {
  const { root } = await project();
  await fs.writeFile(path.join(root, '.loop', 'work-items', 'WI-001.authorization.json'), JSON.stringify({
    schema_version: 1, item_id: 'WI-001', state: 'READY',
    scope: { allowed_paths: ['docs/guide.md'] }, budget: { max_rounds: 9, max_wall_seconds: 600 },
    expires_at: 'whenever', stop_on_first_failure: true,
    authorized_by: 'interactive-tty', authorized_at: '2026-01-01T00:00:00Z',
  }));
  const status = await dispatch(root, 'status', {});
  assert.equal(status.authorization.invalid, true);
  assert.equal(status.authorization.state, 'INVALID');
  const started = await dispatch(root, 'tick', {});
  assert.equal(started.action, 'nothing');
  assert.equal(started.reason, 'authorization-invalid');
  // A record that does not validate is refused rather than half-read.
  const written = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-001' }, typed);
  assert.equal(written.ok, false);
  assert.equal(written.error.code, 'INVALID_AUTHORIZATION');
});

// A project that is activated, configured and paused, ready to be started.
async function activatedProject() {
  const root = await temporary();
  const prepared = await dispatch(root, 'demo', { kind: 'docs' });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty');
  const activation = await dispatch(root, 'activate', {});
  await settle(root, activation.job.job_id);
  const configFile = path.join(root, '.loop', 'host.local.json');
  const config = await readJson(configFile);
  delete config.host_signature;
  config.host_signature = await signHostConfiguration(root, config);
  await fs.writeFile(configFile, JSON.stringify(config));
  return root;
}

async function settle(root, jobId) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const result = await dispatch(root, 'status', { job_id: jobId });
    if (!['QUEUED', 'RUNNING', 'STOPPING'].includes(result.job?.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`job ${jobId} did not finish in time`);
}

test('continuing a running item takes the smaller of the current and the authorized caps', { timeout: 180000 }, async () => {
  const root = await activatedProject();
  const current = await readJson(path.join(root, '.loop', 'state.json'));
  const item = current.work_item_id;
  await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: item, allowed_paths: ['docs/guide.md'], max_rounds: 11, max_wall_seconds: 1800 }, typed);
  const started = await dispatch(root, 'start', { request_id: 'caps-start', max_nodes: 1 });
  assert.equal(started.ok, true, JSON.stringify(started));
  await settle(root, started.job.job_id);
  const running = await readJson(path.join(root, '.loop', 'state.json'));
  assert.equal(running.run_status, 'RUNNING');
  assert.equal(running.max_rounds, 11);
  assert.ok(running.round >= 1);
  assert.ok(running.started_epoch > 0);

  // A wider authorization may not widen a run that is already going.
  await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: item, allowed_paths: ['docs/guide.md'], max_rounds: 400, max_wall_seconds: 604800 }, typed);
  const wider = await dispatch(root, 'run', { request_id: 'caps-wider', max_nodes: 1 });
  assert.equal(wider.ok, true, JSON.stringify(wider));
  await settle(root, wider.job.job_id);
  const afterWider = await readJson(path.join(root, '.loop', 'state.json'));
  assert.equal(afterWider.max_rounds, 11);
  assert.equal(afterWider.max_wall_seconds, 1800);
  // Consumed rounds and the original start time survive untouched.
  assert.ok(afterWider.round >= running.round);
  assert.equal(afterWider.started_epoch, running.started_epoch);

  // A narrower one does apply.
  await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: item, allowed_paths: ['docs/guide.md'], max_rounds: 9, max_wall_seconds: 900 }, typed);
  const narrower = await dispatch(root, 'run', { request_id: 'caps-narrower', max_nodes: 1 });
  assert.equal(narrower.ok, true, JSON.stringify(narrower));
  await settle(root, narrower.job.job_id);
  const afterNarrower = await readJson(path.join(root, '.loop', 'state.json'));
  assert.equal(afterNarrower.max_rounds, 9);
  assert.equal(afterNarrower.max_wall_seconds, 900);
  assert.equal(afterNarrower.started_epoch, running.started_epoch);
});

test('a broken authorization sidecar stops every operation that would start or continue a run', async () => {
  const { root } = await project({ run_status: 'RUNNING', phase: 'EXECUTE' });
  await fs.writeFile(path.join(root, '.loop', 'work-items', 'WI-001.authorization.json'), JSON.stringify({
    schema_version: 1, item_id: 'WI-001', state: 'READY',
    scope: { allowed_paths: ['docs/guide.md'] }, budget: { max_rounds: 9, max_wall_seconds: 600 },
    expires_at: 'whenever', stop_on_first_failure: true,
    authorized_by: 'interactive-tty', authorized_at: '2026-01-01T00:00:00Z',
  }));
  for (const [operation, requestId] of [['run', 'broken-run'], ['resume', 'broken-resume'], ['start', 'broken-start']]) {
    const refused = await dispatch(root, operation, { request_id: requestId, max_nodes: 1 });
    assert.equal(refused.ok, false, `${operation}: ${JSON.stringify(refused)}`);
    assert.equal(refused.error.code, 'AUTHORIZATION_INVALID', operation);
    assert.match(refused.error.message, /Fix or delete \.loop\/work-items\/WI-001\.authorization\.json/);
  }
  assert.equal(await fs.stat(path.join(root, '.loop', 'control', 'job.lock')).then(() => true, () => false), false);
  // The cadence refuses for the same reason.
  const ticked = await dispatch(root, 'tick', {});
  assert.equal(ticked.reason, 'authorization-invalid');
});

// The authorization fixtures under tests/fixtures/authorization are read by this
// suite and by tests/run-orchestrator.sh. Both layers have to come to the same
// answer for every one of them: a record that only one of them accepts is a hole
// somebody can drive an unauthorized run through.
const authorizationFixtures = path.join(repo, 'tests', 'fixtures', 'authorization');

// A fixture expiry is written as @+SECONDS or @-SECONDS (with an optional
// fraction) so that a decision meant to be live is still live when the test runs.
function resolveFixtureStamp(value) {
  const match = /^@([+-])(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return value;
  const at = Date.now() + (match[1] === '-' ? -1 : 1) * Number(match[2]) * 1000;
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, match[3] ? `.${match[3]}Z` : 'Z');
}

async function authorizationCases() {
  const expected = JSON.parse(await fs.readFile(path.join(authorizationFixtures, 'expected.json'), 'utf8'));
  const cases = [];
  for (const entry of expected.cases) {
    const record = JSON.parse(await fs.readFile(path.join(authorizationFixtures, `${entry.case}.json`), 'utf8'));
    for (const key of ['expires_at', 'authorized_at']) {
      if (Object.hasOwn(record, key)) record[key] = resolveFixtureStamp(record[key]);
    }
    cases.push({ ...entry, record });
  }
  return cases;
}

test('a PAUSED record is validated in full, and neither kind starts a run by itself', async () => {
  const { root } = await project();
  const file = path.join(root, '.loop', 'work-items', 'WI-001.authorization.json');
  const record = {
    schema_version: 1, item_id: 'WI-001', state: 'PAUSED',
    scope: { allowed_paths: ['docs/guide.md'] }, budget: { max_rounds: 9, max_wall_seconds: 600 },
    expires_at: '2030-01-01T00:00:00Z', stop_on_first_failure: true,
    authorized_by: 'interactive-tty', authorized_at: '2026-01-01T00:00:00Z',
  };
  await fs.writeFile(file, JSON.stringify(record));
  const inert = await dispatch(root, 'status', {});
  assert.equal(inert.authorization.state, 'PAUSED');
  assert.equal(inert.authorization.invalid, undefined);
  // A withdrawn decision is not "no decision": an automated caller is refused,
  // and told what a person can do about it.
  const revoked = await dispatch(root, 'start', { request_id: 'paused-inert', max_nodes: 1 });
  assert.equal(revoked.ok, false, JSON.stringify(revoked));
  assert.equal(revoked.error.code, 'AUTHORIZATION_REVOKED');

  // A PAUSED record goes through exactly the same structural rules as a READY
  // one: a field the schema does not describe is a record somebody got wrong,
  // and a broken record is refused for everybody until a person repairs it.
  await fs.writeFile(file, JSON.stringify({ ...record, surprise: 'extra' }));
  const broken = await dispatch(root, 'status', {});
  assert.equal(broken.authorization.invalid, true);
  assert.equal(broken.authorization.state, 'INVALID');
  for (const channel of ['mcp-user', 'interactive-tty']) {
    const refused = await dispatch(root, 'start', { request_id: `paused-broken-${channel}`, max_nodes: 1 }, { channel });
    assert.equal(refused.ok, false, `${channel}: ${JSON.stringify(refused)}`);
    assert.equal(refused.error.code, 'AUTHORIZATION_INVALID', channel);
  }
  assert.equal(await fs.stat(path.join(root, '.loop', 'control', 'job.lock')).then(() => true, () => false), false);
});

test('every shared authorization fixture is read the way the expectation file says', async () => {
  const { root } = await project();
  const cases = await authorizationCases();
  const items = [];
  for (const entry of cases) {
    await fs.copyFile(path.join(repo, 'template', 'work-items', 'WI-001-template.md'), path.join(root, '.loop', 'work-items', `${entry.case}.md`));
    await fs.writeFile(path.join(root, '.loop', 'work-items', `${entry.case}.authorization.json`), JSON.stringify(entry.record));
    items.push({ id: entry.case, title: entry.why, added_at: '2026-01-01T00:00:00Z', work_kind: 'feature' });
  }
  await fs.writeFile(path.join(root, '.loop', 'backlog.json'), JSON.stringify({ schema_version: 1, items }));
  const listed = await dispatch(root, 'backlog_list', {});
  const seen = Object.fromEntries(listed.backlog.items.map((item) => [item.id, item.authorization_state]));
  for (const entry of cases) assert.equal(seen[entry.case], entry.expected, `${entry.case}: ${entry.why}`);
  assert.equal(listed.backlog.ready, cases.filter((entry) => entry.expected === 'READY').length);
  assert.equal(listed.backlog.paused, cases.filter((entry) => entry.expected === 'PAUSED').length);
});

test('an authorization copied from another item authorizes nothing here', async () => {
  const { root } = await project();
  await fs.copyFile(path.join(repo, 'template', 'work-items', 'WI-001-template.md'), path.join(root, '.loop', 'work-items', 'WI-002.md'));
  await fs.writeFile(path.join(root, '.loop', 'backlog.json'), JSON.stringify({
    schema_version: 1, items: [{ id: 'WI-002', title: 'Second item', added_at: '2026-01-01T00:00:00Z', work_kind: 'feature' }],
  }));
  // A real, live decision about WI-001 — and then the same bytes dropped into
  // the sidecar of WI-002 and of the current item.
  const authorized = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-001', allowed_paths: ['docs/guide.md'] }, typed);
  assert.equal(authorized.ok, true, JSON.stringify(authorized));
  const record = await readJson(path.join(root, '.loop', 'work-items', 'WI-001.authorization.json'));
  await fs.writeFile(path.join(root, '.loop', 'work-items', 'WI-002.authorization.json'), JSON.stringify(record));
  const listed = await dispatch(root, 'backlog_list', {});
  assert.deepEqual(listed.backlog.items.map((item) => [item.id, item.authorization_state, item.authorization_invalid]), [['WI-002', 'PAUSED', true]]);
  assert.equal(listed.backlog.ready, 0);

  // The same swap on the item a run would actually use is a broken record, so
  // nothing may be started under it.
  await fs.writeFile(path.join(root, '.loop', 'work-items', 'WI-001.authorization.json'), JSON.stringify({ ...record, item_id: 'WI-002' }));
  const status = await dispatch(root, 'status', {});
  assert.equal(status.authorization.invalid, true);
  assert.equal(status.authorization.state, 'INVALID');
  assert.match(status.authorization.reason, /it is the authorization sidecar of WI-001/);
  const ticked = await dispatch(root, 'tick', {});
  assert.equal(ticked.action, 'nothing');
  assert.equal(ticked.reason, 'authorization-invalid');
});
