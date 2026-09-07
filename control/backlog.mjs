// Ordered backlog, per-item authorization records, and human acceptance.
// Nothing here starts a run. Acceptance and authorization are human decisions;
// this module only records them and moves finished work into local history.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateKind } from './loop-options.mjs';
import { validateAuthorization } from './schemas.mjs';
import {
  ControlError, acquireDirLock, assertControlPath, assertNoEngineLock, atomicJson, atomicText,
  exists, now, readJson, safeRelativeArray, sha256, stringValue,
} from './common.mjs';
import { holdForDeauthorization } from './hold.mjs';
import { bundleRoot } from './setup.mjs';
import { readNextSteps } from './notes.mjs';

const PHASES = ['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER'];
const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60;
const itemIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const blankGates = () => Object.fromEntries(PHASES.map((phase) => [phase, { status: 'PENDING', evidence_ids: [] }]));
const oneLine = (value) => value.replace(/[\r\n]+/g, ' ').trim();
const quoteBlock = (value) => value.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
// Directory-safe UTC stamp, for example 20260907T101530Z.
const stamp = () => now().replace(/[-:]/g, '');

export const workItemFile = (loop, id) => path.join(loop, 'work-items', `${id}.md`);
export const authorizationFile = (loop, id) => path.join(loop, 'work-items', `${id}.authorization.json`);
export const backlogFile = (loop) => path.join(loop, 'backlog.json');

export async function readBacklog(loop) {
  const file = backlogFile(loop);
  if (!await exists(file)) return { schema_version: 1, items: [] };
  const backlog = await readJson(file, 'backlog');
  if (backlog.schema_version !== 1 || !Array.isArray(backlog.items)) throw new ControlError('INVALID_BACKLOG', 'backlog.json must be a version 1 record with an items array');
  for (const item of backlog.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !itemIdPattern.test(String(item.id))) throw new ControlError('INVALID_BACKLOG', 'backlog.json contains an entry without a usable id');
  }
  return backlog;
}

// A record that cannot be read or does not validate is not "no authorization":
// it is a broken one. It comes back as an invalid marker so that every consumer
// treats it as "not READY" and a person can see that it has to be written again.
export async function readAuthorization(loop, id) {
  if (!id || !itemIdPattern.test(id)) return null;
  const file = authorizationFile(loop, id);
  if (!await exists(file)) return null;
  const raw = await readJson(file, 'authorization').catch((error) => ({ __unreadable: error.message }));
  if (raw.__unreadable) return { invalid: true, item_id: id, state: 'INVALID', reason: raw.__unreadable };
  try {
    const record = validateAuthorization(raw);
    // A decision names the item it is about. A record whose item_id is not the
    // item whose sidecar it is authorizes that other item and nothing here, so
    // copying one item's decision into another item's sidecar leaves a broken
    // record rather than a second READY item.
    if (record.item_id !== id) {
      return { invalid: true, item_id: id, state: 'INVALID', reason: `the record names item_id ${record.item_id}, but it is the authorization sidecar of ${id}; a decision only ever applies to the item it names` };
    }
    return record;
  } catch (error) { return { invalid: true, item_id: id, state: 'INVALID', reason: error.message }; }
}

// Only a READY record can expire. A READY record without a usable expiry has
// already lost its meaning, so it counts as expired rather than as unlimited.
export function authorizationExpired(record, at = Date.now()) {
  if (!record || record.invalid) return Boolean(record?.invalid);
  if (record.state !== 'READY') return false;
  if (typeof record.expires_at !== 'string') return true;
  const deadline = Date.parse(record.expires_at);
  return !Number.isFinite(deadline) || deadline <= at;
}

// Summary shared by status, check, backlog_list and the Bash orchestrator view.
export async function backlogSummary(loop) {
  const backlog = await readBacklog(loop);
  const items = [];
  for (const entry of backlog.items) {
    const record = await readAuthorization(loop, entry.id).catch(() => null);
    const expired = authorizationExpired(record);
    items.push({
      id: entry.id,
      title: typeof entry.title === 'string' ? entry.title : null,
      work_kind: typeof entry.work_kind === 'string' ? entry.work_kind : null,
      added_at: typeof entry.added_at === 'string' ? entry.added_at : null,
      authorization_state: record?.state === 'READY' && !expired ? 'READY' : 'PAUSED',
      authorization_expired: Boolean(record?.state === 'READY' && expired),
      authorization_invalid: Boolean(record?.invalid),
    });
  }
  return {
    ready: items.filter((item) => item.authorization_state === 'READY').length,
    paused: items.filter((item) => item.authorization_state === 'PAUSED').length,
    items,
  };
}

// The inbox index is the record of what is waiting for a person. Loose files
// are only counted while no index exists yet.
export async function inboxCount(loop) {
  const directory = path.join(loop, 'inbox');
  if (!await exists(directory)) return 0;
  const index = await readJson(path.join(directory, 'index.json'), 'inbox index').catch(() => null);
  if (Array.isArray(index?.items)) return index.items.length;
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).length;
}

export async function activeJob(root) {
  const control = path.join(root, '.loop', 'control');
  const currentFile = path.join(control, 'current-job.json');
  if (!await exists(currentFile)) return null;
  const current = await readJson(currentFile, 'current job').catch(() => null);
  if (!current?.job_id || !itemIdPattern.test(String(current.job_id))) return null;
  const job = await readJson(path.join(control, 'jobs', `${current.job_id}.json`), 'job').catch(() => null);
  return job && ['QUEUED', 'RUNNING', 'STOPPING'].includes(job.status) ? job : null;
}

async function nextItemId(loop) {
  const directory = path.join(loop, 'work-items');
  const names = await fs.readdir(directory).catch(() => []);
  const backlog = await readBacklog(loop);
  const used = [...names.map((name) => /^WI-(\d+)\.md$/.exec(name)?.[1]).filter(Boolean).map(Number),
    ...backlog.items.map((item) => /^WI-(\d+)$/.exec(item.id)?.[1]).filter(Boolean).map(Number)];
  return `WI-${String((used.length ? Math.max(...used) : 0) + 1).padStart(3, '0')}`;
}

// The work item file is produced from the shipped template so that a backlog
// item and a prepared task carry the same sections.
async function renderFromTemplate(id, title, kind, outcome) {
  const template = await fs.readFile(path.join(bundleRoot, 'template', 'work-items', 'WI-001-template.md'), 'utf8');
  return template
    .replace(/^# .*$/m, `# ${id}: ${oneLine(title).slice(0, 200)}`)
    .replace(/^Kind: .*$/m, `Kind: ${kind}`)
    .replace(/^## Outcome$/m, `## Outcome\n\n${quoteBlock(outcome)}`);
}

export async function backlogAdd(root, args) {
  const { loop } = await assertControlPath(root);
  await assertNoEngineLock(root);
  stringValue(args.title, 'title', { max: 200 });
  stringValue(args.outcome, 'outcome', { max: 20000 });
  const kind = validateKind(args.work_kind);
  await fs.mkdir(path.join(loop, 'work-items'), { recursive: true });
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'backlog-add' });
  let id;
  try {
    id = args.id ? stringValue(args.id, 'id', { pattern: itemIdPattern }) : await nextItemId(loop);
    const backlog = await readBacklog(loop);
    if (backlog.items.some((item) => item.id === id)) throw new ControlError('BACKLOG_ITEM_EXISTS', `backlog already contains ${id}`);
    if (await exists(workItemFile(loop, id))) throw new ControlError('WORK_ITEM_EXISTS', `work item already exists: ${id}`);
    await atomicText(workItemFile(loop, id), await renderFromTemplate(id, args.title, kind, args.outcome));
    backlog.items.push({ id, title: oneLine(args.title).slice(0, 200), added_at: now(), work_kind: kind });
    await atomicJson(backlogFile(loop), backlog);
  } finally { await release(); }
  return { ok: true, item_id: id, work_kind: kind, work_item: `.loop/work-items/${id}.md`, started: false, next: 'authorize when a person decides it may run' };
}

export async function backlogList(root) {
  const { loop } = await assertControlPath(root);
  return { ok: true, backlog: await backlogSummary(loop) };
}

export async function backlogRemove(root, args) {
  const { loop } = await assertControlPath(root);
  await assertNoEngineLock(root);
  stringValue(args.id, 'id', { pattern: itemIdPattern });
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'backlog-remove' });
  try {
    const backlog = await readBacklog(loop);
    const remaining = backlog.items.filter((item) => item.id !== args.id);
    if (remaining.length === backlog.items.length) throw new ControlError('BACKLOG_ITEM_NOT_FOUND', `backlog does not contain ${args.id}`);
    backlog.items = remaining;
    await atomicJson(backlogFile(loop), backlog);
  } finally { await release(); }
  return { ok: true, item_id: args.id, removed: true, work_item_retained: true };
}

function requireConfirmation(args, word) {
  if (args.confirm !== word) throw new ControlError('CONFIRMATION_REQUIRED', `this is a human decision; repeat it with confirm set to ${word}`);
}

// The record a person is agreeing to, fully resolved: the item, every argument
// including the defaults it inherits, the expiry and the budget. Building it is
// separate from writing it, so a confirmation can freeze exactly this record and
// the page can display it before anybody agrees to anything.
export async function authorizationRecord(loop, args, channel) {
  const id = args.item_id || await currentOrFirstBacklogItem(loop);
  stringValue(id, 'item_id', { pattern: itemIdPattern });
  if (!await exists(workItemFile(loop, id))) throw new ControlError('WORK_ITEM_NOT_FOUND', `no work item file exists for ${id}`);
  const previous = await readAuthorization(loop, id).catch(() => null);
  if (previous?.invalid) throw new ControlError('INVALID_AUTHORIZATION', `the authorization record for ${id} is invalid: ${previous.reason}`);
  const allowedPaths = args.allowed_paths ? safeRelativeArray(args.allowed_paths, 'allowed_paths', 1) : previous?.scope?.allowed_paths;
  if (!allowedPaths?.length) throw new ControlError('MISSING_INPUT', 'allowed_paths is required the first time an item is authorized', { missing_inputs: ['allowed_paths'] });
  const expirySeconds = args.expires_in_seconds ?? DEFAULT_EXPIRY_SECONDS;
  const record = {
    schema_version: 1,
    item_id: id,
    state: 'READY',
    scope: { allowed_paths: allowedPaths },
    budget: {
      max_rounds: args.max_rounds ?? previous?.budget?.max_rounds ?? 40,
      max_wall_seconds: args.max_wall_seconds ?? previous?.budget?.max_wall_seconds ?? 14400,
    },
    expires_at: new Date(Date.now() + expirySeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    stop_on_first_failure: args.stop_on_first_failure ?? true,
    authorized_by: channel,
    // A word typed at this machine's terminal, or on the local confirmation
    // page. Both mean the same thing: somebody with access to this machine did
    // it. It is not proof of who that was.
    assurance: 'local-user-action',
    authorized_at: now(),
    ...(args.note ? { note: args.note } : {}),
  };
  validateAuthorization(record);
  return record;
}

// What the item looked like when the record was frozen: the exact text of the
// work item a person read, and the authorization that was in force at that
// moment (or none). A confirmation is about this item as it stood, so both are
// checked again before the confirmed record is written.
export async function authorizationSubject(loop, itemId) {
  const item = await fs.readFile(workItemFile(loop, itemId), 'utf8').catch(() => null);
  if (item === null) throw new ControlError('WORK_ITEM_NOT_FOUND', `no work item file exists for ${itemId}`);
  const existing = await fs.readFile(authorizationFile(loop, itemId), 'utf8').catch(() => null);
  return {
    item_id: itemId,
    work_item_sha256: sha256(item),
    authorization_sha256: existing === null ? null : sha256(existing),
  };
}

export async function authorize(root, args, channel) {
  const { loop } = await assertControlPath(root);
  await assertNoEngineLock(root);
  requireConfirmation(args, 'AUTHORIZE');
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'authorize' });
  let record;
  try {
    record = await authorizationRecord(loop, args, channel);
    await atomicJson(authorizationFile(loop, record.item_id), record);
  } finally { await release(); }
  return { ok: true, item_id: record.item_id, authorization: record, assurance: record.assurance, started: false };
}

// Write exactly the record a person confirmed. Nothing is recomputed from the
// current arguments or the current sidecar: the frozen record is the decision.
// Only the preconditions are checked again, under the lock that writes it.
export async function authorizeFrozen(root, record, subject = null) {
  const { loop } = await assertControlPath(root);
  await assertNoEngineLock(root);
  validateAuthorization(record);
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'authorize-confirmed' });
  try {
    if (!await exists(workItemFile(loop, record.item_id))) throw new ControlError('CONFIRMATION_STALE', `the work item file for ${record.item_id} no longer exists`);
    const previous = await readAuthorization(loop, record.item_id).catch(() => null);
    if (previous?.invalid) throw new ControlError('CONFIRMATION_STALE', `the authorization record for ${record.item_id} became invalid: ${previous.reason}`);
    // The item has to be the one the person read, and no other authorization may
    // have been written in between: an item rewritten after the page was shown,
    // or a record somebody else changed meanwhile, is a different decision.
    if (subject) {
      const live = await authorizationSubject(loop, record.item_id);
      if (subject.item_id !== record.item_id || live.work_item_sha256 !== subject.work_item_sha256) {
        throw new ControlError('CONFIRMATION_STALE', `the work item ${record.item_id} changed since this authorization was confirmed; read it again and authorize the current text`);
      }
      if (live.authorization_sha256 !== (subject.authorization_sha256 ?? null)) {
        throw new ControlError('CONFIRMATION_STALE', `the authorization record for ${record.item_id} changed since this decision was confirmed; look at it again`);
      }
    }
    await atomicJson(authorizationFile(loop, record.item_id), record);
  } finally { await release(); }
  return { ok: true, item_id: record.item_id, authorization: record, assurance: record.assurance, started: false };
}

export async function deauthorize(root, args, channel) {
  const { loop } = await assertControlPath(root);
  await assertNoEngineLock(root);
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'deauthorize' });
  let record;
  try {
    const id = args.item_id || await currentOrFirstBacklogItem(loop);
    stringValue(id, 'item_id', { pattern: itemIdPattern });
    if (!await exists(workItemFile(loop, id))) throw new ControlError('WORK_ITEM_NOT_FOUND', `no work item file exists for ${id}`);
    const previous = await readAuthorization(loop, id).catch(() => null);
    record = { ...(previous?.invalid ? {} : previous || {}), schema_version: 1, item_id: id, state: 'PAUSED', authorized_by: channel, authorized_at: now() };
    delete record.expires_at;
    // Assurance describes how a decision was obtained. Pausing an item takes
    // nothing away from anybody, so it carries no assurance of its own.
    delete record.assurance;
    validateAuthorization(record);
    await atomicJson(authorizationFile(loop, id), record);
  } finally { await release(); }
  // Withdrawing a decision stops one item. On its own that is not enough: an
  // agent could cancel the run, acknowledge the handover, write a new work item
  // with a scope of its own choosing and start that instead, under a new item
  // id that no withdrawn decision mentions. So the whole project is put on hold
  // as well, and only a person takes that off again. The hold is written after
  // the sidecar and outside the lock, because it lives under .loop/control.
  const hold = await holdForDeauthorization(root, record.item_id, channel);
  return { ok: true, item_id: record.item_id, authorization: record, hold: hold?.hold ?? null, project_on_hold: Boolean(hold?.held), next: 'Nothing automated runs in this project until a person releases the hold with the word RELEASE.' };
}

export async function currentOrFirstBacklogItem(loop) {
  const state = await readJson(path.join(loop, 'state.json'), 'state').catch(() => null);
  if (state?.work_item_id) return state.work_item_id;
  const backlog = await readBacklog(loop);
  if (!backlog.items.length) throw new ControlError('MISSING_INPUT', 'item_id is required when no current work item exists', { missing_inputs: ['item_id'] });
  return backlog.items[0].id;
}

async function evidenceRecords(loop, workItemId) {
  const directory = path.join(loop, 'evidence');
  const names = await fs.readdir(directory).catch(() => []);
  const records = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const record = await readJson(path.join(directory, name), 'evidence').catch(() => null);
    if (!record || (record.work_item_id && record.work_item_id !== workItemId)) continue;
    records.push({ evidence_id: record.evidence_id ?? name.replace(/\.json$/, ''), phase: record.phase ?? null, evidence_type: record.evidence_type ?? null, result: record.result ?? null, captured_at: record.captured_at ?? null, file: `.loop/evidence/${name}` });
  }
  return records;
}

// What a person is accepting, resolved: which run, and the exact HANDOVER
// evidence that made it acceptable. A confirmation freezes this, and acceptance
// refuses if the live run is no longer the one that was shown.
export async function acceptanceSubject(loop) {
  const state = await readJson(path.join(loop, 'state.json'), 'state');
  if (state.run_status !== 'WAITING_FOR_HUMAN' || state.gates?.HANDOVER?.status !== 'PASSED') {
    throw new ControlError('HANDOVER_NOT_READY', 'accept requires run_status WAITING_FOR_HUMAN with a passed HANDOVER gate');
  }
  const ids = Array.isArray(state.gates.HANDOVER.evidence_ids) ? [...state.gates.HANDOVER.evidence_ids].map(String).sort() : [];
  return { work_item_id: state.work_item_id, round: state.round, handover_evidence_ids: ids };
}

export async function accept(root, args, channel, frozen = null) {
  const { loop } = await assertControlPath(root);
  await assertNoEngineLock(root);
  requireConfirmation(args, 'ACCEPT');
  const active = await activeJob(root);
  if (active) throw new ControlError('JOB_ACTIVE', `job ${active.job_id} is still active; stop it before accepting`, { job_id: active.job_id });
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'accept' });
  let result;
  try {
    if (await activeJob(root)) throw new ControlError('JOB_ACTIVE', 'a managed job became active while accepting');
    const state = await readJson(path.join(loop, 'state.json'), 'state');
    if (state.run_status !== 'WAITING_FOR_HUMAN' || state.gates?.HANDOVER?.status !== 'PASSED') {
      throw new ControlError('HANDOVER_NOT_READY', 'accept requires run_status WAITING_FOR_HUMAN with a passed HANDOVER gate');
    }
    // The run has to be the one the person looked at, still resting on the same
    // handover evidence. Anything else is a different decision.
    if (frozen) {
      const live = await acceptanceSubject(loop);
      if (live.work_item_id !== frozen.work_item_id || live.round !== frozen.round
          || live.handover_evidence_ids.join(' ') !== [...(frozen.handover_evidence_ids ?? [])].join(' ')) {
        throw new ControlError('CONFIRMATION_STALE', 'the run changed since this acceptance was confirmed; look at it again and accept the current run');
      }
    }
    const archived = state.work_item_id;
    const historyDirectory = path.join(loop, 'history', `${archived}-${stamp()}`);
    if (await exists(historyDirectory)) throw new ControlError('HISTORY_ENTRY_EXISTS', 'a history entry with this name already exists');
    await fs.mkdir(historyDirectory, { recursive: true });
    await atomicJson(path.join(historyDirectory, 'state.json'), state);
    const workItem = await fs.readFile(workItemFile(loop, archived), 'utf8').catch(() => null);
    if (workItem !== null) await atomicText(path.join(historyDirectory, `${archived}.md`), workItem);
    const authorization = await readAuthorization(loop, archived).catch(() => null);
    if (authorization && !authorization.invalid) await atomicJson(path.join(historyDirectory, 'authorization.json'), authorization);
    await atomicJson(path.join(historyDirectory, 'evidence-records.json'), { schema_version: 1, work_item_id: archived, records: await evidenceRecords(loop, archived) });
    // The advisory note the run left at HANDOVER is copied into history as it
    // stands. The live note stays where it is: it belongs to the project, and
    // the next DEFINE brief reads it. Only a run that never wrote one falls
    // back to a short record of the acceptance itself.
    const notes = await readNextSteps(root);
    await atomicText(path.join(historyDirectory, 'next-steps.md'), notes ?? `# Next steps after ${archived}\n\nNo next-steps note was written for this run.\n${args.note ? `\nNote recorded at acceptance: ${oneLine(args.note)}\n` : ''}`);
    await atomicJson(path.join(historyDirectory, 'acceptance.json'), { schema_version: 1, work_item_id: archived, accepted_by: channel, accepted_at: now(), ...(args.note ? { note: args.note } : {}), external_action_performed: false });

    const backlog = await readBacklog(loop);
    const next = backlog.items[0] ?? null;
    const base = {
      schema_version: 1,
      max_rounds: state.max_rounds,
      max_gate_failures: state.max_gate_failures,
      max_wall_seconds: state.max_wall_seconds ?? 14400,
      autonomy: state.autonomy,
    };
    if (next) {
      if (!await exists(workItemFile(loop, next.id))) throw new ControlError('WORK_ITEM_NOT_FOUND', `backlog item ${next.id} has no work item file`);
      const promoted = {
        ...base,
        work_item_id: next.id,
        phase: 'DEFINE',
        run_status: 'PAUSED',
        step: 'backlog-promoted',
        round: 0,
        gate_failures_here: 0,
        started_epoch: 0,
        gates: blankGates(),
        last_result: `Accepted ${archived} and promoted the next backlog item.`,
        next_action: 'Review the work item, then start it as a human action.',
        updated_at: now(),
      };
      await atomicJson(path.join(loop, 'state.json'), promoted);
      backlog.items = backlog.items.slice(1);
      await atomicJson(backlogFile(loop), backlog);
      result = { ok: true, accepted_work_item_id: archived, archived_to: path.relative(root, historyDirectory), promoted_work_item_id: next.id, run_status: 'PAUSED', backlog_remaining: backlog.items.length, external_action_performed: false };
    } else {
      const completed = {
        ...base,
        work_item_id: archived,
        phase: state.phase,
        run_status: 'COMPLETED',
        step: 'accepted',
        round: state.round,
        gate_failures_here: state.gate_failures_here,
        started_epoch: 0,
        gates: state.gates,
        last_result: `Accepted ${archived}; the backlog is empty.`,
        next_action: 'Add a backlog item or prepare the next task.',
        updated_at: now(),
      };
      await atomicJson(path.join(loop, 'state.json'), completed);
      result = { ok: true, accepted_work_item_id: archived, archived_to: path.relative(root, historyDirectory), promoted_work_item_id: null, run_status: 'COMPLETED', backlog_remaining: 0, external_action_performed: false };
    }
  } finally { await release(); }
  return result;
}
