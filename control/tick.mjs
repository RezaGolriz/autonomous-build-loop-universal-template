// One cadence step. A tick is what a timer, a cron line, or a chat client calls
// when it wants the loop to move on by itself. It is deliberately thin: it looks
// at the recorded situation, does at most one thing, and reports.
//
// A tick never grants approval. It only ever starts work that a person already
// authorized as READY, within the scope, budget and expiry of that decision, and
// it refuses an expired one. Everything else it can do is reporting.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ControlError, acquireDirLock, assertControlPath, atomicJson, exists, intValue, leaveRunning, nonce, now, readJson,
} from './common.mjs';
import { authorizationExpired, backlogFile, readAuthorization, readBacklog, workItemFile } from './backlog.mjs';
import { check } from './check.mjs';
import { settleHumanDecisions } from './human-ops.mjs';
import { handoverNodePending, launchJob } from './jobs.mjs';
import { assertNotHeld } from './hold.mjs';
import { autostartControlPage } from './control-page.mjs';

const PHASES = ['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER'];
const DEFAULT_STALE_SECONDS = 14400;

const RECLAIM_GUARD_STALE_MS = 60_000;

const blankGates = () => Object.fromEntries(PHASES.map((phase) => [phase, { status: 'PENDING', evidence_ids: [] }]));
// Scheduler state lives under .loop/scheduler, never under .loop/control: a
// reporting tick writes its log line while a node may be running, and every
// change under .loop/control during a node is treated as provider tampering.
const tickLockFile = (scheduler) => path.join(scheduler, 'tick.lock');
const tickLogFile = (scheduler) => path.join(scheduler, 'tick.log');
const reclaimGuardDir = (scheduler) => path.join(scheduler, 'tick.reclaim.lock.d');
const requestId = () => `tick-${Date.now()}-${nonce(6)}`;

// One line per tick, in UTC, so a cron redirect and the scheduler directory tell
// the same story: when it ran, what it did, and on which item.
function logLine(fields) {
  return `${now()} ${Object.entries(fields).map(([key, value]) => `${key}=${value === undefined || value === null || value === '' ? '-' : String(value).replace(/\s+/g, '_')}`).join(' ')}`;
}

async function appendLog(scheduler, line) {
  await fs.mkdir(scheduler, { recursive: true });
  await fs.appendFile(tickLogFile(scheduler), `${line}\n`, { mode: 0o600 });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// The lock file is complete before it is visible: it is written to a private
// temporary name and then hard-linked into place, which fails with EEXIST when
// somebody else got there first. No other tick can ever read a half-written one.
async function writeTickLock(scheduler) {
  const record = { schema_version: 1, lock_id: nonce(24), pid: process.pid, created_at: now(), operation: 'tick' };
  await fs.mkdir(scheduler, { recursive: true });
  const temporary = path.join(scheduler, `tick.lock.${process.pid}.${nonce(8)}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { await fs.link(temporary, tickLockFile(scheduler)); return record; }
  finally { await fs.rm(temporary, { force: true }); }
}

// Reclaiming a lock is inspect-then-remove, and two reclaimers must never do it
// at the same time: one could examine the old file while the other has already
// replaced it, and then unlink the live replacement. An exclusive guard
// directory serialises the whole inspect-remove-acquire sequence. A guard
// younger than a minute is somebody's live guard and is never touched at all. A
// guard older than that belonged to a process that died holding it: it is moved
// aside under a private name and dropped there, never removed where it stands.
//
// The move is the only claim anybody makes on it, and nothing is ever put back.
// A reclaimer may only touch the very directory it inspected, and it checks that
// twice. Immediately before the rename it stats the guard again and compares
// inode and modification time with what it inspected, so a guard replaced in the
// meantime is left where it stands. After the rename it stats the moved
// directory and compares the inode again; on any mismatch the move is treated as
// lost and nothing is deleted, because a directory whose inode is not the one
// that was inspected is somebody else's live guard. Renaming such a directory
// back could overwrite yet another new guard, so it is left under its private
// name and this reclaimer starts its acquisition again from the top.
// Two stat results describe the same directory entry only when the inode and
// the modification time both match. A directory that was replaced between two
// looks is a different entry even when it happens to reuse the inode number.
export function sameEntry(a, b) {
  return Boolean(a && b && a.ino === b.ino && a.mtimeMs === b.mtimeMs);
}

async function acquireReclaimGuard(scheduler) {
  const directory = reclaimGuardDir(scheduler);
  await fs.mkdir(scheduler, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(directory, { recursive: false });
      return async () => { await fs.rmdir(directory).catch(() => {}); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(directory).catch(() => null);
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ControlError('UNSAFE_CONTROL_PATH', 'refusing an unsafe .loop/scheduler/tick.reclaim.lock.d');
      if (Date.now() - stat.mtimeMs <= RECLAIM_GUARD_STALE_MS) return null;
      // Last look before the claim: a guard that is no longer the one that was
      // inspected is not stale evidence but somebody's live guard, and it stays
      // exactly where it is.
      const again = await fs.lstat(directory).catch(() => null);
      if (!again?.isDirectory() || again.isSymbolicLink() || !sameEntry(again, stat)) continue;
      const claimed = `${directory}.${process.pid}.${nonce(8)}.stale`;
      try { await fs.rename(directory, claimed); }
      catch { continue; }
      const moved = await fs.lstat(claimed).catch(() => null);
      // Nothing is ever deleted whose inode was not the inspected one: a
      // mismatch means the move took a directory this reclaimer never looked
      // at, so it is left under its private name and the attempt starts again.
      if (!moved || moved.ino !== stat.ino) continue;
      await fs.rm(claimed, { recursive: true, force: true }).catch(() => {});
    }
  }
  return null;
}

// A lock is only reclaimed when it is provably not protecting anything: its
// recorded owner process is gone, or nothing readable was ever written and the
// file is older than the wall-clock budget of the run. An unreadable lock is
// never assumed dead on its own, and elapsed time never overrides a live owner.
// The file is removed only while it is byte-for-byte the one that was examined.
async function reclaimTickLock(file, seen) {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) return false;
  const bytes = await fs.readFile(file).catch(() => null);
  if (bytes === null || bytes.toString('utf8') !== seen.text || stat.ino !== seen.ino) return false;
  await fs.rm(file, { force: true });
  return true;
}

async function acquireTickLock(scheduler, staleSeconds) {
  const file = tickLockFile(scheduler);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return { record: await writeTickLock(scheduler) }; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Everything from here to the replacement runs under the recovery guard, so
    // no second reclaimer can inspect the old file and unlink a replacement.
    const releaseGuard = await acquireReclaimGuard(scheduler);
    if (!releaseGuard) return { busy: await readJson(file, 'tick lock').catch(() => null) };
    let reason = null;
    try {
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ControlError('UNSAFE_CONTROL_PATH', 'refusing an unsafe .loop/scheduler/tick.lock');
      const text = await fs.readFile(file, 'utf8').catch(() => null);
      if (text === null) return { busy: null };
      let existing = null;
      try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed; } catch { existing = null; }
      const age = (Date.now() - stat.mtimeMs) / 1000;
      reason = existing
        ? (processAlive(existing.pid) ? null : 'tick-lock-owner-is-gone')
        : (age > staleSeconds ? 'tick-lock-unreadable-and-older-than-wall-budget' : null);
      if (!reason) return { busy: existing };
      if (!await reclaimTickLock(file, { text, ino: stat.ino })) { reason = null; continue; }
      // Still under the guard: take the free name before anybody else can.
      const record = await writeTickLock(scheduler).catch(() => null);
      if (record) { await appendLog(scheduler, logLine({ action: 'replaced-stale-lock', reason, item: null, phase: null, run_status: null })); return { record }; }
    } finally { await releaseGuard(); }
    if (reason) await appendLog(scheduler, logLine({ action: 'replaced-stale-lock', reason, item: null, phase: null, run_status: null }));
  }
  return { busy: await readJson(file, 'tick lock').catch(() => null) };
}

async function releaseTickLock(scheduler, lockId) {
  const owner = await readJson(tickLockFile(scheduler), 'tick lock').catch(() => null);
  if (owner?.lock_id !== lockId) return false;
  await fs.rm(tickLockFile(scheduler), { force: true });
  return true;
}

async function activeJob(root) {
  const control = path.join(root, '.loop', 'control');
  const currentFile = path.join(control, 'current-job.json');
  if (!await exists(currentFile)) return null;
  const current = await readJson(currentFile, 'current job').catch(() => null);
  if (!current?.job_id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(current.job_id))) return null;
  const job = await readJson(path.join(control, 'jobs', `${current.job_id}.json`), 'job').catch(() => null);
  return job && ['QUEUED', 'RUNNING', 'STOPPING'].includes(job.status) ? job : null;
}

async function report(root, scheduler, action, reason, extra = {}) {
  const result = await check(root);
  await appendLog(scheduler, logLine({ action, reason, item: result.work_item_id, phase: result.phase, run_status: result.run_status }));
  return { action, reason, ...result, ...extra };
}

// stop_on_first_failure is the person's instruction not to let the loop retry a
// failed gate on its own. The run is put into BLOCKED so a human sees it.
async function blockRun(loop) {
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'tick-stop-on-first-failure' });
  try {
    const state = await readJson(path.join(loop, 'state.json'), 'state');
    if (state.run_status === 'BLOCKED') return;
    leaveRunning(state, 'BLOCKED');
    state.last_result = 'A gate failed and the authorization says stop on the first failure.';
    state.next_action = 'Read the evidence, decide what should happen, then resume or deauthorize the item.';
    state.updated_at = now();
    await atomicJson(path.join(loop, 'state.json'), state);
  } finally { await release(); }
}

async function firstReadyBacklogItem(loop) {
  const backlog = await readBacklog(loop);
  for (const entry of backlog.items) {
    const record = await readAuthorization(loop, entry.id).catch(() => null);
    if (record?.state !== 'READY' || authorizationExpired(record)) continue;
    if (!await exists(workItemFile(loop, entry.id))) continue;
    return entry;
  }
  return null;
}

// The same promotion accept performs for the next item, used when the current
// item is COMPLETED and the person already authorized the next one. Nothing is
// archived here: a COMPLETED run has already had its handover or acceptance.
async function promoteBacklogItem(loop, entry) {
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'tick-promote' });
  try {
    const state = await readJson(path.join(loop, 'state.json'), 'state');
    if (state.run_status !== 'COMPLETED') throw new ControlError('INVALID_STATE', 'only a completed run may be replaced by the next authorized backlog item');
    if (!await exists(workItemFile(loop, entry.id))) throw new ControlError('WORK_ITEM_NOT_FOUND', `backlog item ${entry.id} has no work item file`);
    await atomicJson(path.join(loop, 'state.json'), {
      schema_version: 1,
      max_rounds: state.max_rounds,
      max_gate_failures: state.max_gate_failures,
      max_wall_seconds: state.max_wall_seconds ?? DEFAULT_STALE_SECONDS,
      autonomy: state.autonomy,
      work_item_id: entry.id,
      phase: 'DEFINE',
      run_status: 'PAUSED',
      step: 'backlog-promoted',
      round: 0,
      gate_failures_here: 0,
      started_epoch: 0,
      gates: blankGates(),
      last_result: `Promoted the authorized backlog item ${entry.id} after ${state.work_item_id} completed.`,
      next_action: 'Run the authorized item within its recorded budget.',
      updated_at: now(),
    });
    const backlog = await readBacklog(loop);
    backlog.items = backlog.items.filter((item) => item.id !== entry.id);
    await atomicJson(backlogFile(loop), backlog);
  } finally { await release(); }
}

async function decide(root, loop, scheduler, maxNodes, channel) {
  const stateFile = path.join(loop, 'state.json');
  if (!await exists(stateFile)) return report(root, scheduler, 'nothing', 'not-initialized');
  for (const name of ['engine.lock', 'orchestrator.lock']) {
    if (await exists(path.join(loop, name))) return report(root, scheduler, 'reported', 'workspace-locked');
  }
  const running = await activeJob(root);
  if (running) return report(root, scheduler, 'reported', 'job-active', { job_id: running.job_id });

  const state = await readJson(stateFile, 'state');
  const authorization = await readAuthorization(loop, state.work_item_id).catch(() => null);
  const invalid = Boolean(authorization?.invalid);
  const expired = !invalid && authorizationExpired(authorization);
  const ready = authorization?.state === 'READY' && !expired;
  const stopOnFirstFailure = ready && authorization.stop_on_first_failure !== false;

  if (['RUNNING', 'BLOCKED'].includes(state.run_status) && stopOnFirstFailure
      && (Number(state.gate_failures_here) > 0 || state.run_status === 'BLOCKED')) {
    await blockRun(loop);
    return report(root, scheduler, 'reported', 'stopped-on-first-failure');
  }

  // WAITING_FOR_HUMAN with a pending HANDOVER gate means the handover node has
  // not been written yet, so it is still work, not a wait. Only a passed
  // HANDOVER gate is "waiting for a person to accept".
  const pendingHandover = handoverNodePending(state);
  if (state.run_status === 'RUNNING' || pendingHandover) {
    // A run that was started under a decision may only continue under one. A
    // sidecar that is no longer READY, or has expired, stops the cadence; a run
    // a person started by hand has no sidecar and may continue.
    if (authorization && !ready) return report(root, scheduler, 'reported', invalid ? 'authorization-invalid' : expired ? 'authorization-expired' : 'authorization-revoked');
    const launched = await launchJob(root, 'run', { max_nodes: maxNodes, request_id: requestId(), require_authorization: Boolean(authorization) }, channel);
    return report(root, scheduler, 'ran-node', pendingHandover ? 'ran-the-pending-handover-node' : 'advanced-the-running-item', { job_id: launched.job?.job_id ?? null, max_nodes: maxNodes });
  }
  if (state.run_status === 'BLOCKED') return report(root, scheduler, 'reported', 'blocked');
  if (state.run_status === 'WAITING_FOR_HUMAN') return report(root, scheduler, 'reported', 'waiting-for-human');

  if (state.run_status === 'PAUSED') {
    if (invalid) return report(root, scheduler, 'nothing', 'authorization-invalid');
    if (expired) return report(root, scheduler, 'nothing', 'authorization-expired');
    if (!ready) return report(root, scheduler, 'nothing', 'no-ready-authorization');
    const launched = await launchJob(root, 'start', { max_nodes: maxNodes, request_id: requestId(), require_authorization: true }, channel);
    return report(root, scheduler, 'started', 'started-authorized-item', { job_id: launched.job?.job_id ?? null, max_nodes: maxNodes });
  }

  if (state.run_status === 'COMPLETED') {
    const next = await firstReadyBacklogItem(loop);
    if (!next) return report(root, scheduler, 'nothing', invalid ? 'authorization-invalid' : expired ? 'authorization-expired' : 'no-ready-authorization');
    await promoteBacklogItem(loop, next);
    const launched = await launchJob(root, 'start', { max_nodes: maxNodes, request_id: requestId(), require_authorization: true }, channel);
    return report(root, scheduler, 'started', 'started-authorized-item', { job_id: launched.job?.job_id ?? null, max_nodes: maxNodes, promoted_work_item_id: next.id });
  }

  return report(root, scheduler, 'nothing', 'nothing-to-do');
}

export async function tick(root, args = {}, channel = 'mcp-user') {
  const { loop, scheduler } = await assertControlPath(root);
  // First, before the hold and the lock: bring the control page back when the
  // policy asks for autostart. Cheap when it is running, and it never throws.
  // This is what brings the page back after a reboot, with no service installed.
  await autostartControlPage(root, { reason: 'tick' });
  // A held project does not tick. The cadence is the entry point a hold exists
  // for: it is the one thing that would otherwise keep going on its own.
  await assertNotHeld(root, channel, 'tick');
  const maxNodes = args.max_nodes === undefined ? 1 : intValue(args.max_nodes, 'max_nodes', 1, 500);
  const state = await readJson(path.join(loop, 'state.json'), 'state').catch(() => null);
  const staleSeconds = Number.isInteger(state?.max_wall_seconds) ? state.max_wall_seconds : DEFAULT_STALE_SECONDS;
  const lock = await acquireTickLock(scheduler, staleSeconds);
  if (!lock.record) return report(root, scheduler, 'reported', 'tick-in-progress');
  // Anything a person confirmed on the local page is carried out before the
  // cadence looks at the situation, so a tick never acts on a stale picture.
  await settleHumanDecisions(root).catch(() => []);
  try { return await decide(root, loop, scheduler, maxNodes, channel); }
  finally { await releaseTickLock(scheduler, lock.record.lock_id); }
}

// The command line reports a tick as success unless the operation itself failed.
// What the loop is doing is in the action, the reason, and the check fields.
export function tickExitCode(result) { return result?.ok === false ? 2 : 0; }
