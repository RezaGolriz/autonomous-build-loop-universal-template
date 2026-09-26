// Human confirmation: what is frozen, what is bound to it, and what refuses.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { dispatch } from '../control/index.mjs';
import { recordConfirmation, requestDigest, settleConfirmations } from '../control/confirm.mjs';
import { settleHumanDecisions } from '../control/human-ops.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'confirm-approval-store-')));
await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = async (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2));
const passedGates = (passed) => Object.fromEntries(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER']
  .map((phase) => [phase, { status: passed.includes(phase) ? 'PASSED' : 'PENDING', evidence_ids: [] }]));

async function project(overrides = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'confirm-test-')));
  await fs.mkdir(path.join(root, '.loop', 'work-items'), { recursive: true });
  const state = { ...JSON.parse(await fs.readFile(path.join(repo, 'template', '.loop', 'state.example.json'), 'utf8')), ...overrides };
  await fs.writeFile(path.join(root, '.loop', 'state.json'), JSON.stringify(state));
  await fs.copyFile(path.join(repo, 'template', '.loop', 'workflow.json'), path.join(root, '.loop', 'workflow.json'));
  await fs.copyFile(path.join(repo, 'template', 'work-items', 'WI-001-template.md'), path.join(root, '.loop', 'work-items', `${state.work_item_id}.md`));
  return root;
}

const requestPath = (root, id) => path.join(root, '.loop', 'scheduler', 'operation-requests', `${id}.json`);
const receiptPath = (root, id) => path.join(root, '.loop', 'scheduler', 'operation-approvals', `${id}.json`);
const resultPath = (root, id) => path.join(root, '.loop', 'scheduler', 'operation-results', `${id}.json`);

async function pendingAuthorize(root, item = 'WI-030', extra = {}) {
  await dispatch(root, 'backlog_add', { id: item, title: 'Bounded change', outcome: 'A bounded change lands.' });
  const requested = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: item, allowed_paths: ['docs/guide.md'], ...extra });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  return requested;
}

test('the frozen decision carries the resolved record, and the receipt binds its digest', async () => {
  const root = await project();
  const requested = await pendingAuthorize(root);
  const frozen = await readJson(requestPath(root, requested.request_id));
  assert.equal(frozen.decision.kind, 'authorize');
  assert.equal(frozen.decision.record.item_id, 'WI-030');
  // Defaults are resolved at request time, not left to be recomputed later.
  assert.equal(frozen.decision.record.budget.max_rounds, 40);
  assert.ok(frozen.decision.record.expires_at);
  assert.equal(requested.request_digest, requestDigest(frozen));

  const receipt = await recordConfirmation(root, requested.request_id, 'AUTHORIZE');
  assert.equal(receipt.request_digest, requested.request_digest);
  assert.equal(receipt.assurance, 'local-user-action');
});

test('a wrong or missing confirmation word records nothing', async () => {
  const root = await project();
  const requested = await pendingAuthorize(root);
  await assert.rejects(() => recordConfirmation(root, requested.request_id, 'ACCEPT'), /CONFIRMATION_MISMATCH|type AUTHORIZE/);
  await assert.rejects(() => recordConfirmation(root, requested.request_id, ''), /type AUTHORIZE/);
  assert.equal(await fs.stat(receiptPath(root, requested.request_id)).then(() => true, () => false), false);
});

test('a frozen decision that changed on disk is discarded instead of carried out', async () => {
  const root = await project();
  const requested = await pendingAuthorize(root);
  await recordConfirmation(root, requested.request_id, 'AUTHORIZE');
  // Somebody widens the decision after it was confirmed. The digest no longer
  // matches the receipt, so the request is thrown away, not executed.
  const frozen = await readJson(requestPath(root, requested.request_id));
  frozen.decision.record.scope.allowed_paths = ['src/**'];
  await writeJson(requestPath(root, requested.request_id), frozen);
  const settled = await settleHumanDecisions(root);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].result.ok, false);
  assert.equal(settled[0].result.error.code, 'CONFIRMATION_STALE');
  assert.equal(await fs.stat(path.join(root, '.loop', 'work-items', 'WI-030.authorization.json')).then(() => true, () => false), false);
  assert.equal(await fs.stat(requestPath(root, requested.request_id)).then(() => true, () => false), false);
});

test('a receipt cannot be replayed against another request', async () => {
  const root = await project();
  const first = await pendingAuthorize(root, 'WI-031');
  const second = await pendingAuthorize(root, 'WI-032');
  await recordConfirmation(root, first.request_id, 'AUTHORIZE');
  // The signed receipt of one decision is copied on top of another one.
  const copied = await readJson(receiptPath(root, first.request_id));
  await writeJson(receiptPath(root, second.request_id), copied);
  const settled = await settleHumanDecisions(root);
  const replayed = settled.find((entry) => entry.request_id === second.request_id);
  assert.equal(replayed.result.ok, false);
  assert.equal(replayed.result.error.code, 'CONFIRMATION_STALE');
  assert.equal(await fs.stat(path.join(root, '.loop', 'work-items', 'WI-032.authorization.json')).then(() => true, () => false), false);
  // The decision the receipt really belongs to still went through.
  assert.equal((await readJson(path.join(root, '.loop', 'work-items', 'WI-031.authorization.json'))).state, 'READY');
});

test('concurrent settlement carries one confirmed decision out exactly once', async () => {
  const root = await project();
  const requested = await pendingAuthorize(root, 'WI-033');
  await recordConfirmation(root, requested.request_id, 'AUTHORIZE');
  let runs = 0;
  const runner = async () => { runs += 1; await new Promise((resolve) => setTimeout(resolve, 60)); return { ok: true, runs }; };
  const results = await Promise.all([
    settleConfirmations(root, { authorize: runner }),
    settleConfirmations(root, { authorize: runner }),
    settleConfirmations(root, { authorize: runner }),
  ]);
  assert.equal(runs, 1);
  assert.equal(results.flat().length, 1);
  assert.equal((await readJson(resultPath(root, requested.request_id))).result.ok, true);
});

test('an acceptance confirmed for one run refuses a different one', async () => {
  const root = await project({ run_status: 'WAITING_FOR_HUMAN', phase: 'HANDOVER', gates: passedGates(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER']) });
  const requested = await dispatch(root, 'accept', { confirm: 'ACCEPT' }, { channel: 'cli-input' });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  assert.equal(requested.decision.subject.work_item_id, 'WI-001');
  await recordConfirmation(root, requested.request_id, 'ACCEPT');
  // Another round finished in between: the same handover gate, a different run.
  const state = await readJson(path.join(root, '.loop', 'state.json'));
  state.round += 1;
  await writeJson(path.join(root, '.loop', 'state.json'), state);
  const settled = await settleHumanDecisions(root);
  assert.equal(settled[0].result.ok, false);
  assert.equal(settled[0].result.error.code, 'CONFIRMATION_STALE');
  assert.equal((await readJson(path.join(root, '.loop', 'state.json'))).run_status, 'WAITING_FOR_HUMAN');
});

test('a promotion confirmed for one proposal text refuses a changed one', async () => {
  const root = await project();
  const inbox = path.join(root, '.loop', 'inbox');
  await fs.mkdir(inbox, { recursive: true });
  const id = 'P-20260101T000000Z-1';
  const template = await fs.readFile(path.join(repo, 'template', 'work-items', 'WI-001-template.md'), 'utf8');
  await fs.writeFile(path.join(inbox, `${id}.md`), template.replace(/^## Outcome$/m, '## Outcome\n\n> Fix the greeting helper.'));
  await writeJson(path.join(inbox, 'index.json'), { schema_version: 1, items: [{ id, title: 'Fix the greeting helper', created_at: '2026-01-01T00:00:00Z', provider: 'mock', file: `.loop/inbox/${id}.md` }] });

  const requested = await dispatch(root, 'promote', { proposal_id: id });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  assert.match(requested.decision.subject.proposal_sha256, /^[0-9a-f]{64}$/);
  await recordConfirmation(root, requested.request_id, 'PROMOTE');
  // The proposal text is rewritten after the person read and confirmed it.
  await fs.writeFile(path.join(inbox, `${id}.md`), template.replace(/^## Outcome$/m, '## Outcome\n\n> Rewrite the whole module.'));
  const settled = await settleHumanDecisions(root);
  assert.equal(settled[0].result.ok, false);
  assert.equal(settled[0].result.error.code, 'CONFIRMATION_STALE');
  assert.equal(await fs.stat(path.join(root, '.loop', 'backlog.json')).then(() => true, () => false), false);
});

test('the page confirms only the decision it displayed, even when the record changed underneath', async () => {
  const root = await project();
  const requested = await pendingAuthorize(root, 'WI-034');
  const origin = new URL(requested.confirmation_url).origin;
  const html = await (await fetch(requested.confirmation_url)).text();
  assert.ok(html.includes(`name="request_digest" value="${requested.request_digest}"`));
  // The frozen record is widened on disk after the person looked at the page.
  const frozen = await readJson(requestPath(root, requested.request_id));
  frozen.decision.record.scope.allowed_paths = ['src/**'];
  await writeJson(requestPath(root, requested.request_id), frozen);
  const posted = await fetch(requested.confirmation_url, {
    method: 'POST', redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: `decision=AUTHORIZE&request_digest=${requested.request_digest}`,
  });
  assert.equal(posted.status, 409);
  // Nothing was recorded, so nothing can be settled either.
  assert.equal(await fs.stat(receiptPath(root, requested.request_id)).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(root, '.loop', 'work-items', 'WI-034.authorization.json')).then(() => true, () => false), false);
});

test('recording refuses a digest that is not the one on disk', async () => {
  const root = await project();
  const requested = await pendingAuthorize(root, 'WI-035');
  await assert.rejects(() => recordConfirmation(root, requested.request_id, 'AUTHORIZE', 'a'.repeat(64)), /CONFIRMATION_STALE|changed after this page/);
  assert.equal(await fs.stat(receiptPath(root, requested.request_id)).then(() => true, () => false), false);
  const receipt = await recordConfirmation(root, requested.request_id, 'AUTHORIZE', requested.request_digest);
  assert.equal(receipt.request_digest, requested.request_digest);
});

test('an authorization confirmed for one work item text refuses a rewritten one', async () => {
  const root = await project();
  const requested = await pendingAuthorize(root, 'WI-036');
  assert.match(requested.decision.subject.work_item_sha256, /^[0-9a-f]{64}$/);
  assert.equal(requested.decision.subject.authorization_sha256, null);
  await recordConfirmation(root, requested.request_id, 'AUTHORIZE');
  // The item is rewritten after the person read it: a different decision.
  await fs.appendFile(path.join(root, '.loop', 'work-items', 'WI-036.md'), '\nAlso rewrite the payment module.\n');
  const settled = await settleHumanDecisions(root);
  assert.equal(settled[0].result.ok, false);
  assert.equal(settled[0].result.error.code, 'CONFIRMATION_STALE');
  assert.equal(await fs.stat(path.join(root, '.loop', 'work-items', 'WI-036.authorization.json')).then(() => true, () => false), false);
});

test('an authorization confirmed against one record refuses one written in between', async () => {
  const root = await project();
  const requested = await pendingAuthorize(root, 'WI-037');
  await recordConfirmation(root, requested.request_id, 'AUTHORIZE');
  // Somebody else authorized or paused the same item in the meantime.
  await dispatch(root, 'deauthorize', { item_id: 'WI-037' });
  const settled = await settleHumanDecisions(root);
  assert.equal(settled[0].result.ok, false);
  assert.equal(settled[0].result.error.code, 'CONFIRMATION_STALE');
  assert.equal((await readJson(path.join(root, '.loop', 'work-items', 'WI-037.authorization.json'))).state, 'PAUSED');
});

test('a pending page request is discarded, never settled, once the project is tty-only', async () => {
  const root = await project();
  const requested = await pendingAuthorize(root, 'WI-038');
  await recordConfirmation(root, requested.request_id, 'AUTHORIZE');
  await fs.mkdir(path.join(root, '.loop', 'control'), { recursive: true });
  await writeJson(path.join(root, '.loop', 'control', 'policy.json'), { schema_version: 1, human_confirmation: 'tty-only' });
  const settled = await settleHumanDecisions(root);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].result.error.code, 'CONFIRMATION_TTY_ONLY');
  assert.equal(await fs.stat(requestPath(root, requested.request_id)).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(root, '.loop', 'work-items', 'WI-038.authorization.json')).then(() => true, () => false), false);
  // A later call still refuses and still carries nothing out.
  const refused = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-038', allowed_paths: ['docs/guide.md'] }, { channel: 'cli-input' });
  assert.equal(refused.error.code, 'CONFIRMATION_TTY_ONLY');
  assert.equal(await fs.stat(path.join(root, '.loop', 'work-items', 'WI-038.authorization.json')).then(() => true, () => false), false);
});

test('a tty-only project refuses every confirmation that is not typed at a terminal', async () => {
  const root = await project();
  await dispatch(root, 'backlog_add', { id: 'WI-040', title: 'Bounded change', outcome: 'A bounded change lands.' });
  await fs.mkdir(path.join(root, '.loop', 'control'), { recursive: true });
  await writeJson(path.join(root, '.loop', 'control', 'policy.json'), { schema_version: 1, human_confirmation: 'tty-only' });

  for (const channel of [undefined, { channel: 'cli-input' }]) {
    const refused = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-040', allowed_paths: ['docs/guide.md'] }, channel);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.error.code, 'CONFIRMATION_TTY_ONLY');
    // The command hands the whole decision over, so the person does not have to
    // reconstruct it and nothing quietly falls back to the current item.
    assert.equal(refused.error.details.command, `build-loop authorize --root '${root}' --input '{"item_id":"WI-040","allowed_paths":["docs/guide.md"]}'`);
  }
  // Nothing was written and no confirmation page was started.
  assert.equal(await fs.stat(path.join(root, '.loop', 'work-items', 'WI-040.authorization.json')).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(root, '.loop', 'scheduler', 'operation-requests')).then(() => true, () => false), false);

  // The typed word at an interactive terminal still decides.
  const authorized = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-040', allowed_paths: ['docs/guide.md'] }, { channel: 'interactive-tty' });
  assert.equal(authorized.ok, true, JSON.stringify(authorized));
  assert.equal(authorized.authorization.assurance, 'local-user-action');

  // status and check report the mode so a person can see it.
  assert.equal((await dispatch(root, 'status', {})).human_confirmation.mode, 'tty-only');
  assert.equal((await dispatch(root, 'check', {})).human_confirmation, 'tty-only');
});

test('an unusable confirmation policy is refused rather than ignored', async () => {
  const root = await project();
  await fs.mkdir(path.join(root, '.loop', 'control'), { recursive: true });
  const policy = path.join(root, '.loop', 'control', 'policy.json');
  // A misspelled key, a null value or a wrong version must never fall back to
  // the permissive default: each one is an error the person has to fix.
  for (const record of [
    { schema_version: 1, human_confirmation: 'anything-goes' },
    { schema_version: 1, human_confirmaton: 'tty-only' },
    { schema_version: 1, human_confirmation: null },
    { schema_version: 2, human_confirmation: 'tty-only' },
  ]) {
    await writeJson(policy, record);
    const refused = await dispatch(root, 'accept', { confirm: 'ACCEPT' }, { channel: 'cli-input' });
    assert.equal(refused.ok, false, JSON.stringify(record));
    assert.equal(refused.error.code, 'INVALID_POLICY', JSON.stringify(record));
    assert.equal(await fs.stat(path.join(root, '.loop', 'scheduler', 'operation-requests')).then(() => true, () => false), false);
  }
  // Only the file the schema describes is accepted.
  await writeJson(policy, { schema_version: 1 });
  assert.equal((await dispatch(root, 'check', {})).human_confirmation, 'tty-or-local-page');
});

test('the tty-only fallback command carries every argument of the asked-for decision', async () => {
  const root = await project();
  await fs.mkdir(path.join(root, '.loop', 'control'), { recursive: true });
  await writeJson(path.join(root, '.loop', 'control', 'policy.json'), { schema_version: 1, human_confirmation: 'tty-only' });
  const inbox = path.join(root, '.loop', 'inbox');
  await fs.mkdir(inbox, { recursive: true });
  const id = 'P-20260101T000000Z-2';
  await fs.writeFile(path.join(inbox, `${id}.md`), '# Proposal\n\n## Outcome\n\n> Fix the greeting helper.\n');
  await writeJson(path.join(inbox, 'index.json'), { schema_version: 1, items: [{ id, title: 'Fix the greeting helper', created_at: '2026-01-01T00:00:00Z', provider: 'mock', file: `.loop/inbox/${id}.md` }] });

  const refused = await dispatch(root, 'promote', { proposal_id: id, work_kind: 'defect' });
  assert.equal(refused.error.code, 'CONFIRMATION_TTY_ONLY');
  assert.equal(refused.error.details.command, `build-loop promote --root '${root}' --input '{"proposal_id":"${id}","work_kind":"defect"}'`);

  // With no item named, the item the decision resolved to is written into the
  // command, so running it cannot target a different one.
  await dispatch(root, 'backlog_add', { id: 'WI-041', title: 'Bounded change', outcome: 'A bounded change lands.' });
  const authorizeRefused = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', allowed_paths: ['docs/guide.md'] });
  assert.equal(authorizeRefused.error.code, 'CONFIRMATION_TTY_ONLY');
  assert.match(authorizeRefused.error.details.command, /--input '\{"allowed_paths":\["docs\/guide.md"\],"item_id":"WI-001"\}'/);
});

test('an unusable confirmation policy is reported and leaves only the terminal deciding', async () => {
  const root = await project();
  await fs.mkdir(path.join(root, '.loop', 'control'), { recursive: true });
  await writeJson(path.join(root, '.loop', 'control', 'policy.json'), { schema_version: 1, human_confirmaton: 'tty-only' });

  // check and status name the problem instead of showing the permissive default.
  const checked = await dispatch(root, 'check', {});
  assert.equal(checked.human_confirmation, 'tty-only');
  assert.equal(checked.policy.mode, 'tty-only');
  assert.equal(checked.policy.source, 'invalid-policy');
  assert.equal(checked.policy.error.code, 'INVALID_POLICY');
  assert.match(checked.policy.error.message, /unknown field\(s\): human_confirmaton/);
  const status = await dispatch(root, 'status', {});
  assert.equal(status.policy.error.code, 'INVALID_POLICY');
  assert.equal(status.human_confirmation.mode, 'tty-only');
  assert.equal(status.human_confirmation.error.code, 'INVALID_POLICY');

  // Every other transport is refused, and the refusal says what to repair and
  // which command a person can run at their own terminal instead.
  const refused = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-001', allowed_paths: ['docs/guide.md'] }, { channel: 'cli-input' });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.error.code, 'INVALID_POLICY');
  assert.equal(refused.error.details.human_confirmation, 'tty-only');
  assert.match(refused.error.details.command, /build-loop authorize --root/);
  assert.equal(await fs.stat(path.join(root, '.loop', 'scheduler', 'operation-requests')).then(() => true, () => false), false);

  // A person at their own terminal can still decide, which is how the project
  // is repaired without anybody having to widen the rule first.
  const typed = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-001', allowed_paths: ['docs/guide.md'] }, { channel: 'interactive-tty' });
  assert.equal(typed.ok, true, JSON.stringify(typed));

  // A repaired file is read as what it says again.
  await writeJson(path.join(root, '.loop', 'control', 'policy.json'), { schema_version: 1, human_confirmation: 'tty-or-local-page' });
  const repaired = await dispatch(root, 'check', {});
  assert.equal(repaired.policy.error, null);
  assert.equal(repaired.policy.source, 'policy-file');
  assert.equal(repaired.human_confirmation, 'tty-or-local-page');
});

// A review done by the chat that built the change is named in the frozen accept
// decision, so the person accepts knowing it; an isolated review adds nothing.
test('the frozen accept decision says when the review was not independently isolated', async () => {
  const provenance = async (root, isolated) => {
    const dir = path.join(root, '.loop', 'evidence', 'run-WI-001-4-review');
    await fs.mkdir(dir, { recursive: true });
    await writeJson(path.join(dir, 'provenance.json'), { schema_version: 1, run_id: 'run-WI-001-4-review', work_item_id: 'WI-001', phase: 'REVIEW', round: 4, slice: null, host: isolated ? 'claude' : 'chat', builder_host: 'chat', review_host: isolated ? 'claude' : 'chat', review_isolated: isolated, outcome: 'PASSED', evidence_ids: [], recorded_at: '2026-01-01T00:00:00Z' });
  };
  const waiting = { run_status: 'WAITING_FOR_HUMAN', phase: 'HANDOVER', gates: passedGates(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER']) };
  const same = await project(waiting);
  await provenance(same, false);
  const requested = await dispatch(same, 'accept', { confirm: 'ACCEPT' }, { channel: 'cli-input' });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  const frozen = await readJson(requestPath(same, requested.request_id));
  const line = frozen.summary.find((entry) => entry.label === 'Review independence');
  assert.ok(line && line.value.startsWith('Review was not independently isolated (same chat)'), JSON.stringify(frozen.summary));
  assert.equal(requested.request_digest, requestDigest(frozen), 'the warning is part of what the receipt binds');
  const html = await (await fetch(requested.confirmation_url)).text();
  assert.match(html, /Review was not independently isolated \(same chat\)/);

  const isolated = await project(waiting);
  await provenance(isolated, true);
  const clean = await dispatch(isolated, 'accept', { confirm: 'ACCEPT' }, { channel: 'cli-input' });
  assert.ok(!(await readJson(requestPath(isolated, clean.request_id))).summary.some((entry) => entry.label === 'Review independence'));
});
