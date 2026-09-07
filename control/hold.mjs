// A project-wide hold. One file, one meaning: nothing automated runs in this
// project until a person takes the hold off again.
//
// Withdrawing an authorization stops one item. That is not enough on its own:
// an agent that can call the control layer can cancel the run, acknowledge the
// handover, write a new work item with a scope it chose itself, and start that
// instead — a new item id, and none of the item's decisions apply to it. The
// hold closes that door. It is placed on the project, not on an item, so every
// automated entry point is refused while it is there, whatever the item is
// called.
//
// Placing a hold is always safe, so any channel may do it. Taking it off is a
// human decision: a word typed at an interactive terminal, or typed on the
// local confirmation page. See control/human-ops.mjs.
//
// The record lives beside the other runner-owned control records in
// .loop/control/hold.json. It is written and removed while no node is running,
// exactly like the authorization sidecar it usually accompanies.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateHold } from './schemas.mjs';
import {
  ControlError, assertControlPath, assertNoEngineLock, atomicJson, exists, now, readJson, sha256, stringValue,
} from './common.mjs';

export const holdFile = (control) => path.join(control, 'hold.json');

// Operations that may not run while the project is on hold. Reading is always
// allowed, and so is stopping: `cancel` and `handover` only stop work or write
// down what happened, and a person needs them to wind a held project down.
export const HELD_OPERATIONS = Object.freeze(['start', 'run', 'resume', 'tick', 'task', 'scout']);

// Only a word typed at a real terminal is a person by itself, exactly as in
// control/jobs.mjs. Everything else is a transport an agent can call.
export const HUMAN_ENTRY_CHANNEL = 'interactive-tty';

// A hold record that cannot be read, or does not validate, is still a hold:
// fail closed. It comes back marked invalid so a person can see it has to be
// written again or released.
export async function readHold(root) {
  const { control } = await assertControlPath(root);
  const file = holdFile(control);
  if (!await exists(file)) return null;
  const raw = await readJson(file, 'project hold').catch((error) => ({ __unreadable: error.message }));
  if (raw.__unreadable) return { invalid: true, schema_version: 1, held_at: null, held_by: null, reason: `the hold record cannot be read: ${raw.__unreadable}`, item_id: null };
  try { return validateHold(raw); }
  catch (error) { return { invalid: true, ...raw, reason: `the hold record is invalid: ${error.message}` }; }
}

// What the hold looks like to check, status and both dashboards.
export async function holdSummary(root) {
  const record = await readHold(root).catch(() => null);
  if (!record) return null;
  return {
    held: true,
    held_at: record.held_at ?? null,
    held_by: record.held_by ?? null,
    reason: typeof record.reason === 'string' ? record.reason : null,
    item_id: record.item_id ?? null,
    invalid: Boolean(record.invalid),
    release: 'A person takes the hold off with `release`: the word RELEASE typed at an interactive terminal, or on the local confirmation page.',
  };
}

// The refusal every automated entry point shares.
export function heldError(record, operation) {
  return new ControlError('PROJECT_ON_HOLD', `this project is on hold, so ${operation} is refused: ${record?.reason || 'no reason recorded'}. A person takes the hold off with release (the word RELEASE at an interactive terminal, or on the local confirmation page); cancel and handover stay available while it is on.`, {
    held_at: record?.held_at ?? null,
    held_by: record?.held_by ?? null,
    item_id: record?.item_id ?? null,
    hold_file: '.loop/control/hold.json',
  });
}

// The guard. A person at a terminal may still work in a held project; every
// other channel is refused.
export async function assertNotHeld(root, channel, operation) {
  if (channel === HUMAN_ENTRY_CHANNEL) return null;
  const record = await readHold(root).catch(() => null);
  if (!record) return null;
  throw heldError(record, operation);
}

// Place the hold. Any channel may do this: stopping is never the dangerous
// direction. A hold that is already there is left exactly as it was, so the
// first reason recorded is the one a person reads.
// The record is written under .loop/control, which the runner owns while a node
// is running: every change there during a node counts as provider tampering. So
// the write waits for the workspace locks to be free, exactly as `deauthorize`
// does, and the atomic rename is the whole operation — no second lock is taken.
export async function placeHold(root, args = {}, channel = 'mcp-user') {
  const { control } = await assertControlPath(root);
  const reason = args.reason === undefined ? 'A person or an agent stopped this project.' : stringValue(args.reason, 'reason', { max: 4000 });
  const itemId = args.item_id === undefined ? null : stringValue(args.item_id, 'item_id', { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ });
  await assertNoEngineLock(root);
  await fs.mkdir(control, { recursive: true });
  const existing = await readHold(root).catch(() => null);
  if (existing && !existing.invalid) return { ok: true, held: true, already_held: true, hold: existing };
  const record = { schema_version: 1, held_at: now(), held_by: channel, reason, item_id: itemId };
  validateHold(record);
  await atomicJson(holdFile(control), record);
  return { ok: true, held: true, already_held: false, hold: record };
}

// The same hold, written without asking again, for the paths that already know
// they are stopping something: deauthorize places one as part of the decision.
export async function holdForDeauthorization(root, itemId, channel) {
  return placeHold(root, {
    item_id: itemId,
    reason: `the authorization for ${itemId} was withdrawn, so this project is on hold until a person releases it`,
  }, channel).catch(() => null);
}

// What a person is releasing: the hold exactly as it stands. A confirmation is
// frozen against this, so a hold placed again for a different reason after the
// page was shown is a different decision.
export async function holdSubject(root) {
  const { control } = await assertControlPath(root);
  const text = await fs.readFile(holdFile(control), 'utf8').catch(() => null);
  if (text === null) throw new ControlError('NOT_ON_HOLD', 'this project is not on hold; there is nothing to release');
  return { hold_sha256: sha256(text) };
}

// Take the hold off. Human-only: `release` reaches this either from a word
// typed at an interactive terminal or from the local confirmation page.
export async function releaseHold(root, args = {}, channel = HUMAN_ENTRY_CHANNEL, subject = null) {
  const { control } = await assertControlPath(root);
  if (args.confirm !== 'RELEASE') throw new ControlError('CONFIRMATION_REQUIRED', 'this is a human decision; repeat it with confirm set to RELEASE');
  await assertNoEngineLock(root);
  const record = await readHold(root).catch(() => null);
  if (!record) throw new ControlError('NOT_ON_HOLD', 'this project is not on hold; there is nothing to release');
  if (subject) {
    const live = await holdSubject(root);
    if (live.hold_sha256 !== subject.hold_sha256) throw new ControlError('CONFIRMATION_STALE', 'the hold changed since this release was confirmed; look at it again');
  }
  await fs.rm(holdFile(control), { force: true });
  return { ok: true, released: true, released_by: channel, released_at: now(), previous_hold: record, assurance: 'local-user-action' };
}
