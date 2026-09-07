import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { dispatch } from '../control/index.mjs';
import { readNextSteps, writeNextSteps } from '../control/notes.mjs';

const run = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHASES = ['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER'];

async function temporary() { return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'notes-test-'))); }

function gates(statuses) {
  return Object.fromEntries(PHASES.map((phase) => [phase, statuses[phase] ?? { status: 'PENDING', evidence_ids: [] }]));
}

// A finished run: a state at a passed HANDOVER, the evidence its gates point at,
// and the work item the provider edited on the way.
async function project(overrides = {}) {
  const root = await temporary();
  const loop = path.join(root, '.loop');
  await fs.mkdir(path.join(loop, 'work-items'), { recursive: true });
  await fs.mkdir(path.join(loop, 'evidence'), { recursive: true });
  const state = {
    ...JSON.parse(await fs.readFile(path.join(repo, 'template', '.loop', 'state.example.json'), 'utf8')),
    work_item_id: 'WI-001',
    phase: 'HANDOVER',
    run_status: 'WAITING_FOR_HUMAN',
    round: 7,
    max_rounds: 40,
    gates: gates({
      DEFINE: { status: 'PASSED', evidence_ids: ['run-WI-001-0-define-orchestrator'] },
      DESIGN: { status: 'PASSED', evidence_ids: [] },
      EXECUTE: { status: 'PASSED', evidence_ids: ['run-WI-001-2-execute-build'] },
      REVIEW: { status: 'PASSED', evidence_ids: ['review-run-WI-001-2-execute'] },
      VALIDATE: { status: 'PASSED', evidence_ids: [] },
      HANDOVER: { status: 'PASSED', evidence_ids: ['run-WI-001-6-handover-orchestrator'] },
    }),
    ...overrides,
  };
  await fs.writeFile(path.join(loop, 'state.json'), JSON.stringify(state));
  await fs.copyFile(path.join(repo, 'template', '.loop', 'workflow.json'), path.join(loop, 'workflow.json'));
  await fs.writeFile(path.join(loop, 'work-items', 'WI-001.md'), [
    '# WI-001: A small bounded change', '', '## Handover', '',
    '- The change is recorded with runner evidence; no delivery action is authorized.', '',
    '## Open decisions', '', '- Decide whether the retry cap stays at three.', '',
  ].join('\n'));
  const evidence = (id, extra) => fs.writeFile(path.join(loop, 'evidence', `${id}.json`), JSON.stringify({
    schema_version: 1, evidence_id: id, work_item_id: 'WI-001', phase: 'EXECUTE', evidence_type: 'artifact',
    result: 'PASSED', producer: 'orchestrator', revision: 'unversioned', environment: 'test',
    captured_at: '2026-09-07T00:00:00Z', artifacts: [], details: { observation: 'recorded', ...extra },
  }));
  await evidence('run-WI-001-2-execute-build', { run_id: 'run-WI-001-2-execute' });
  await evidence('review-run-WI-001-2-execute', { run_id: 'run-WI-001-2-execute', verdict: 'PASS' });
  await evidence('run-WI-001-6-handover-orchestrator', {});
  await evidence('run-WI-001-0-define-orchestrator', {});
  return { root, loop, state };
}

test('the next-steps note records the run, three priorities, the next item, and the last evidence', async () => {
  const { root, loop } = await project();
  await fs.writeFile(path.join(loop, 'backlog.json'), JSON.stringify({
    schema_version: 1, items: [{ id: 'WI-002', title: 'Explain the retry rules', added_at: '2026-09-07T00:00:00Z', work_kind: 'documentation' }],
  }));
  const written = await writeNextSteps(root);
  assert.equal(written.file, '.loop/notes/next-steps.md');
  assert.equal(written.advisory, true);
  const note = await readNextSteps(root);
  assert.match(note, /^# Next steps after WI-001$/m);
  assert.match(note, /^- Work item: WI-001$/m);
  assert.match(note, /^- Run ids: run-WI-001-2-execute$/m);
  assert.match(note, /^- Generated at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
  assert.match(note, /^- Advisory only, never an approval/m);
  for (const heading of ['## Summary', '## Priorities', '## Suggested next item', '## References']) assert.ok(note.includes(`\n${heading}\n`), heading);
  assert.match(note, /^- Rounds used: 7 of 40$/m);
  assert.match(note, /^- Gate results: DEFINE PASSED, DESIGN PASSED, EXECUTE PASSED, REVIEW PASSED, VALIDATE PASSED, HANDOVER PASSED$/m);
  assert.match(note, /^- Review verdict: PASS$/m);
  assert.match(note, /^- Rework loops: 0$/m);
  assert.match(note, /^- Open blockers: 0$/m);
  assert.match(note, /^- WI-002: Explain the retry rules$/m);
  assert.match(note, /^- Evidence of the last round: run-WI-001-6-handover-orchestrator$/m);
  const priorities = note.split('## Priorities\n\n')[1].split('\n\n')[0].split('\n');
  assert.equal(priorities.length, 3);
  assert.match(priorities[0], /Review the handover notes: The change is recorded with runner evidence/);
  assert.match(priorities[1], /Add a follow-up work item for the open decision: Decide whether the retry cap stays at three\./);
  assert.ok(note.split('\n').every((line) => !line.includes(os.homedir())), 'the note carries no absolute personal path');
});

test('failed gates, open blockers and a FAIL verdict become the priorities', async () => {
  const { root, loop } = await project({
    gates: gates({
      DEFINE: { status: 'PASSED', evidence_ids: [] },
      DESIGN: { status: 'PASSED', evidence_ids: [] },
      EXECUTE: { status: 'PASSED', evidence_ids: [] },
      REVIEW: { status: 'FAILED', evidence_ids: ['review-run-WI-001-2-execute'] },
      VALIDATE: { status: 'FAILED', evidence_ids: [] },
    }),
  });
  await fs.writeFile(path.join(loop, 'evidence', 'review-run-WI-001-2-execute.json'), JSON.stringify({
    schema_version: 1, evidence_id: 'review-run-WI-001-2-execute', work_item_id: 'WI-001', phase: 'REVIEW',
    evidence_type: 'independent-review', result: 'FAILED', producer: 'reference-engine', revision: 'unversioned',
    environment: 'test', captured_at: '2026-09-07T00:00:00Z', artifacts: [], details: { verdict: 'FAIL', finding_count: 1 },
  }));
  await fs.writeFile(path.join(loop, 'blockers.md'), '# Blockers\n\n- [ ] REVIEW run-1: a decision is needed\n');
  await writeNextSteps(root);
  const note = await readNextSteps(root);
  assert.match(note, /^- Review verdict: FAIL$/m);
  assert.match(note, /^- Rework loops: 2$/m);
  assert.match(note, /^- Open blockers: 1$/m);
  assert.match(note, /^- Harden REVIEW: that gate failed in this run/m);
  assert.match(note, /^- Harden VALIDATE: that gate failed in this run/m);
  assert.match(note, /^- Resolve the 1 open blocker recorded in \.loop\/blockers\.md\.$/m);
  assert.match(note, /^- none queued$/m);
});

test('the DEFINE brief carries the note as advisory previous cycle notes', async () => {
  const { root, loop } = await project({ phase: 'DEFINE', run_status: 'PAUSED', gates: gates({}) });
  await fs.copyFile(path.join(repo, 'examples', 'adapters', 'python-cli.json'), path.join(loop, 'project.adapter.json'));
  const brief = async () => JSON.parse((await run(path.join(repo, 'engine', 'orchestrator.sh'), ['next', '--root', root, '--host', 'mock'])).stdout);
  const without = await brief();
  assert.ok(!without.prompt.includes('Previous cycle notes'), 'no note, no section');
  await writeNextSteps(root);
  const withNote = await brief();
  assert.ok(withNote.prompt.includes('# Previous cycle notes (advisory)'), 'the DEFINE brief labels the note');
  assert.ok(withNote.prompt.includes('# Next steps after WI-001'), 'the DEFINE brief carries the note content');
  assert.ok(withNote.prompt.includes('it is not an approval'), 'the DEFINE brief says the note approves nothing');
});

test('accept archives the note into history and leaves the live note in place', async () => {
  const { root, loop } = await project();
  await writeNextSteps(root);
  const live = await readNextSteps(root);
  const accepted = await dispatch(root, 'accept', { confirm: 'ACCEPT' }, { channel: 'interactive-tty' });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const archived = await fs.readFile(path.join(root, accepted.archived_to, 'next-steps.md'), 'utf8');
  assert.equal(archived, live);
  assert.equal(await readNextSteps(root), live, 'the live note belongs to the project and stays');
  assert.deepEqual(await fs.readdir(path.join(loop, 'notes')), ['next-steps.md']);
});

test('accept without a note records that no note was written', async () => {
  const { root } = await project();
  const accepted = await dispatch(root, 'accept', { confirm: 'ACCEPT', note: 'Accepted after reading the evidence.' }, { channel: 'interactive-tty' });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const archived = await fs.readFile(path.join(root, accepted.archived_to, 'next-steps.md'), 'utf8');
  assert.match(archived, /No next-steps note was written for this run\./);
  assert.match(archived, /Accepted after reading the evidence\./);
});
