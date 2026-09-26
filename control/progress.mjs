// Project-wide progress: what is done, what is being worked on now, and what is
// queued. It reads files only, never changes one, and never throws on a missing
// or broken input: such an input is left out, not guessed. Symlinked inputs are
// ignored, as on the dashboard. engine/render-dashboard.sh computes the same
// numbers with jq.
//
// Done    = one entry per `.loop/history/<item>-<timestamp>/` directory.
// Current = the item in `.loop/state.json`, unless it was already accepted.
// Queued  = the entries of `.loop/backlog.json`, in order.
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { validateAuthorization } from './schemas.mjs';

const PHASES = ['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER'];
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const historyPattern = /^([A-Za-z0-9][A-Za-z0-9._-]*)-(\d{8}T\d{6}Z)$/;
const MAX_FILE = 1024 * 1024;
const MAX_ENTRIES = 1000;

// A regular file, not a symlink, not larger than MAX_FILE; otherwise null.
async function readText(file) {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size > MAX_FILE) return null;
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const text = await handle.readFile('utf8');
      return text.length > MAX_FILE ? null : text;
    } finally { await handle.close(); }
  } catch { return null; }
}
async function readObject(file) {
  const text = await readText(file);
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
async function realDirectory(directory) {
  const info = await fs.lstat(directory).catch(() => null);
  return Boolean(info?.isDirectory());
}

const gateStatuses = (state) => Object.fromEntries(PHASES.map((phase) => [phase, typeof state?.gates?.[phase]?.status === 'string' ? state.gates[phase].status : 'PENDING']));
const stampToIso = (stamp) => `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;

// "# WI-001: Title" gives "Title"; otherwise a "Title: …" line.
export function workItemTitle(text, id) {
  if (typeof text !== 'string') return null;
  const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(text)?.[1];
  if (heading) {
    const prefix = `${id}:`;
    const title = heading.startsWith(prefix) ? heading.slice(prefix.length).trim() : heading;
    if (title) return title.slice(0, 200);
  }
  const line = /^Title:[ \t]*(.+?)[ \t]*$/m.exec(text)?.[1];
  return line ? line.slice(0, 200) : null;
}

// READY, PAUSED, INVALID or NONE. An expired READY record is PAUSED: nothing
// starts from it any more.
async function authorizationState(loop, id) {
  const file = path.join(loop, 'work-items', `${id}.authorization.json`);
  const info = await fs.lstat(file).catch(() => null);
  if (!info) return 'NONE';
  const record = await readObject(file);
  if (!record) return 'INVALID';
  try { validateAuthorization(record); } catch { return 'INVALID'; }
  if (record.item_id !== id) return 'INVALID';
  if (record.state !== 'READY') return 'PAUSED';
  const deadline = typeof record.expires_at === 'string' ? Date.parse(record.expires_at) : Number.NaN;
  return Number.isFinite(deadline) && deadline > Date.now() ? 'READY' : 'PAUSED';
}

async function doneItems(loop) {
  const directory = path.join(loop, 'history');
  if (!await realDirectory(directory)) return [];
  const names = (await fs.readdir(directory).catch(() => []))
    .map((name) => ({ name, match: historyPattern.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => a.match[2].localeCompare(b.match[2]) || a.name.localeCompare(b.name))
    .slice(-MAX_ENTRIES);
  const items = [];
  for (const { name, match } of names) {
    const entry = path.join(directory, name);
    if (!await realDirectory(entry)) continue;
    const state = await readObject(path.join(entry, 'state.json'));
    const id = typeof state?.work_item_id === 'string' && idPattern.test(state.work_item_id) ? state.work_item_id : match[1];
    const acceptance = await readObject(path.join(entry, 'acceptance.json'));
    items.push({
      id,
      title: workItemTitle(await readText(path.join(entry, `${id}.md`)), id),
      accepted_at: typeof acceptance?.accepted_at === 'string' ? acceptance.accepted_at : stampToIso(match[2]),
      rounds: Number.isInteger(state?.round) ? state.round : null,
      gates: state ? gateStatuses(state) : null,
    });
  }
  return items;
}

async function inboxCount(loop) {
  const directory = path.join(loop, 'inbox');
  if (!await realDirectory(directory)) return 0;
  const index = await readObject(path.join(directory, 'index.json'));
  if (Array.isArray(index?.items)) return index.items.length;
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).length;
}

export async function projectProgress(root) {
  const loop = path.join(root, '.loop');
  const done = await doneItems(loop).catch(() => []);
  const doneIds = new Set(done.map((item) => item.id));
  const state = await readObject(path.join(loop, 'state.json'));
  let current = null;
  const stateId = typeof state?.work_item_id === 'string' && idPattern.test(state.work_item_id) ? state.work_item_id : null;
  // After the last backlog item is accepted, state.json keeps its id with
  // run_status COMPLETED. That item is done, not in progress.
  if (stateId && !(state.run_status === 'COMPLETED' && doneIds.has(stateId))) {
    current = {
      id: stateId,
      title: workItemTitle(await readText(path.join(loop, 'work-items', `${stateId}.md`)), stateId),
      phase: typeof state.phase === 'string' ? state.phase : null,
      round: Number.isInteger(state.round) ? state.round : null,
      max_rounds: Number.isInteger(state.max_rounds) ? state.max_rounds : null,
      run_status: typeof state.run_status === 'string' ? state.run_status : null,
      gates: gateStatuses(state),
    };
  }
  const backlog = await readObject(path.join(loop, 'backlog.json'));
  const queued = [];
  for (const entry of Array.isArray(backlog?.items) ? backlog.items.slice(0, MAX_ENTRIES) : []) {
    const id = String(entry?.id ?? '');
    if (!idPattern.test(id) || id === current?.id) continue;
    queued.push({ id, title: typeof entry.title === 'string' ? entry.title : null, authorization: await authorizationState(loop, id) });
  }
  const totals = { done: done.length, in_progress: current ? 1 : 0, queued: queued.length };
  totals.total = totals.done + totals.in_progress + totals.queued;
  return {
    schema_version: 1,
    totals,
    percent: totals.total ? Math.round((totals.done * 100) / totals.total) : 0,
    done,
    current,
    queued,
    inbox: await inboxCount(loop).catch(() => 0),
  };
}

// The small form carried by check and status.
export function progressSummary(progress) {
  return {
    done: progress.totals.done,
    in_progress: progress.totals.in_progress,
    queued: progress.totals.queued,
    total: progress.totals.total,
    percent: progress.percent,
    inbox: progress.inbox,
    current: progress.current ? { id: progress.current.id, phase: progress.current.phase, round: progress.current.round } : null,
    done_ids: progress.done.map((item) => item.id),
    queued_ids: progress.queued.map((item) => item.id),
  };
}

export async function progressSummaryFor(root) {
  return progressSummary(await projectProgress(root));
}
