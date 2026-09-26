// Project-wide progress: done items come from .loop/history, the current item
// from state.json, the queued ones from backlog.json. Reading only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectProgress, progressSummary, workItemTitle } from '../control/progress.mjs';

const iso = (seconds) => new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const write = async (root, relative, text) => {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), typeof text === 'string' ? text : JSON.stringify(text));
};
async function emptyRoot(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'progress-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.loop'), { recursive: true });
  return root;
}
const passedGates = Object.fromEntries(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER'].map((phase) => [phase, { status: 'PASSED', evidence_ids: [] }]));

// Two accepted items, one current item, two queued items.
async function progressFixture(root) {
  // Written out of order on purpose: the list follows the timestamps.
  await write(root, '.loop/history/WI-002-20260903T120000Z/state.json', { work_item_id: 'WI-002', round: 9, run_status: 'WAITING_FOR_HUMAN', phase: 'HANDOVER', gates: passedGates });
  await write(root, '.loop/history/WI-002-20260903T120000Z/WI-002.md', '# WI-002: Second <thing>\n\nKind: feature\n');
  await write(root, '.loop/history/WI-001-20260901T080000Z/state.json', { work_item_id: 'WI-001', round: 6, run_status: 'WAITING_FOR_HUMAN', phase: 'HANDOVER', gates: passedGates });
  await write(root, '.loop/history/WI-001-20260901T080000Z/WI-001.md', 'Kind: defect\nTitle: First fix\n');
  await write(root, '.loop/history/WI-001-20260901T080000Z/acceptance.json', { schema_version: 1, work_item_id: 'WI-001', accepted_at: '2026-09-01T08:00:05Z' });
  await write(root, '.loop/state.json', {
    schema_version: 1, work_item_id: 'WI-003', phase: 'EXECUTE', run_status: 'RUNNING', round: 3, max_rounds: 40,
    gates: { DEFINE: { status: 'PASSED' }, DESIGN: { status: 'PASSED' }, EXECUTE: { status: 'PENDING' } },
  });
  await write(root, '.loop/work-items/WI-003.md', '# WI-003: Current work\n');
  await write(root, '.loop/backlog.json', {
    schema_version: 1,
    items: [
      { id: 'WI-004', title: 'Ready one', added_at: '2026-09-01T00:00:00Z', work_kind: 'feature' },
      { id: 'WI-005', title: 'Waiting one', added_at: '2026-09-01T00:00:00Z', work_kind: 'docs' },
    ],
  });
  await write(root, '.loop/work-items/WI-004.authorization.json', {
    schema_version: 1, item_id: 'WI-004', state: 'READY', scope: { allowed_paths: ['src/'] },
    budget: { max_rounds: 12, max_wall_seconds: 900 }, expires_at: iso(3600), stop_on_first_failure: true,
    authorized_by: 'interactive-tty', assurance: 'local-user-action', authorized_at: '2026-09-01T00:00:00Z',
  });
  await write(root, '.loop/inbox/index.json', { schema_version: 1, items: [{ id: 'P-1' }] });
}

test('two done, one current and two queued items give counts, percent and order', async (t) => {
  const root = await emptyRoot(t);
  await progressFixture(root);
  const progress = await projectProgress(root);
  assert.deepEqual(progress.totals, { done: 2, in_progress: 1, queued: 2, total: 5 });
  assert.equal(progress.percent, 40);
  assert.deepEqual(progress.done.map((item) => item.id), ['WI-001', 'WI-002']);
  assert.equal(progress.done[0].title, 'First fix');
  assert.equal(progress.done[0].accepted_at, '2026-09-01T08:00:05Z');
  assert.equal(progress.done[0].rounds, 6);
  assert.equal(progress.done[1].title, 'Second <thing>');
  assert.equal(progress.done[1].accepted_at, '2026-09-03T12:00:00Z');
  assert.equal(progress.done[1].gates.VALIDATE, 'PASSED');
  assert.deepEqual({ id: progress.current.id, phase: progress.current.phase, round: progress.current.round, title: progress.current.title }, { id: 'WI-003', phase: 'EXECUTE', round: 3, title: 'Current work' });
  assert.equal(progress.current.gates.HANDOVER, 'PENDING');
  assert.deepEqual(progress.queued.map((item) => [item.id, item.authorization]), [['WI-004', 'READY'], ['WI-005', 'NONE']]);
  assert.equal(progress.inbox, 1);
  assert.deepEqual(progressSummary(progress), {
    done: 2, in_progress: 1, queued: 2, total: 5, percent: 40, inbox: 1,
    current: { id: 'WI-003', phase: 'EXECUTE', round: 3 },
    done_ids: ['WI-001', 'WI-002'], queued_ids: ['WI-004', 'WI-005'],
  });
});

test('an empty project gives zeros, never a division by zero', async (t) => {
  const root = await emptyRoot(t);
  const progress = await projectProgress(root);
  assert.deepEqual(progress.totals, { done: 0, in_progress: 0, queued: 0, total: 0 });
  assert.equal(progress.percent, 0);
  assert.equal(progress.current, null);
  assert.deepEqual(progress.done, []);
  assert.deepEqual(progress.queued, []);
});

test('the last accepted item is done, not in progress; broken inputs are left out', async (t) => {
  const root = await emptyRoot(t);
  await write(root, '.loop/history/WI-001-20260901T080000Z/state.json', { work_item_id: 'WI-001', round: 2 });
  await write(root, '.loop/history/not-a-history-entry/state.json', { work_item_id: 'X' });
  await write(root, '.loop/state.json', { work_item_id: 'WI-001', run_status: 'COMPLETED', phase: 'HANDOVER', round: 2 });
  await write(root, '.loop/backlog.json', 'not json');
  await write(root, '.loop/work-items/WI-009.authorization.json', 'broken');
  const progress = await projectProgress(root);
  assert.deepEqual(progress.totals, { done: 1, in_progress: 0, queued: 0, total: 1 });
  assert.equal(progress.percent, 100);
  assert.equal(progress.current, null);
});

test('a broken authorization record is INVALID, an expired one PAUSED', async (t) => {
  const root = await emptyRoot(t);
  await write(root, '.loop/backlog.json', { schema_version: 1, items: [{ id: 'WI-1' }, { id: 'WI-2' }] });
  await write(root, '.loop/work-items/WI-1.authorization.json', 'broken');
  await write(root, '.loop/work-items/WI-2.authorization.json', {
    schema_version: 1, item_id: 'WI-2', state: 'READY', scope: { allowed_paths: ['src/'] },
    budget: { max_rounds: 1, max_wall_seconds: 60 }, expires_at: iso(-60), stop_on_first_failure: true,
    authorized_by: 'interactive-tty', authorized_at: '2026-09-01T00:00:00Z',
  });
  const progress = await projectProgress(root);
  assert.deepEqual(progress.queued.map((item) => item.authorization), ['INVALID', 'PAUSED']);
});

test('the title comes from the first heading, else from a Title line', () => {
  assert.equal(workItemTitle('# WI-7: Do it\n', 'WI-7'), 'Do it');
  assert.equal(workItemTitle('# Plain heading\n', 'WI-7'), 'Plain heading');
  assert.equal(workItemTitle('Kind: feature\nTitle: From line\n', 'WI-7'), 'From line');
  assert.equal(workItemTitle(null, 'WI-7'), null);
});

test('check and status carry the small progress summary', async (t) => {
  const root = await emptyRoot(t);
  await progressFixture(root);
  const { check } = await import('../control/check.mjs');
  const { status } = await import('../control/jobs.mjs');
  for (const result of [await check(root), await status(root)]) {
    assert.deepEqual({ done: result.progress.done, in_progress: result.progress.in_progress, queued: result.progress.queued, percent: result.progress.percent }, { done: 2, in_progress: 1, queued: 2, percent: 40 });
    assert.deepEqual(result.progress.done_ids, ['WI-001', 'WI-002']);
    assert.equal(result.progress.current.id, 'WI-003');
  }
});
