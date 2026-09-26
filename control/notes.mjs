// Memory between cycles. When a run reaches HANDOVER, the loop writes one small
// note under `.loop/notes/next-steps.md`: what happened, what looks worth doing
// next, and where the evidence for that is. The next DEFINE brief and every
// scout brief carry it along.
//
// The note is advisory. It is never an approval, it never authorizes anything,
// and nothing reads a decision out of it. A person still decides what happens
// next. The Bash orchestrator writes the same note from the same files
// (engine/next-steps.sh), so both layers leave one comparable record.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertControlPath, atomicText, exists, now, readJson } from './common.mjs';
import { REVIEW_NOT_ISOLATED, recordedReview } from './chat.mjs';

const PHASES = ['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER'];
const NOTE_LABEL = 'Previous cycle notes (advisory)';
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const oneLine = (value) => String(value).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
export const notesFile = (loop) => path.join(loop, 'notes', 'next-steps.md');

export async function readNextSteps(root) {
  const loop = path.join(root, '.loop');
  return fs.readFile(notesFile(loop), 'utf8').catch(() => null);
}

// The labelled block a brief carries. Null when no previous cycle left a note.
export async function nextStepsBriefSection(root) {
  const notes = await readNextSteps(root);
  if (!notes?.trim()) return null;
  return `# ${NOTE_LABEL}\n\nThe previous cycle left this note under .loop/notes/next-steps.md. It is advisory: it is not an approval and it does not widen this node's scope.\n\n${notes.trim()}`;
}

async function evidenceRecord(loop, id) {
  if (typeof id !== 'string' || !idPattern.test(id)) return null;
  return readJson(path.join(loop, 'evidence', `${id}.json`), 'evidence').catch(() => null);
}

function gateEvidenceIds(state) {
  return PHASES.flatMap((phase) => (Array.isArray(state?.gates?.[phase]?.evidence_ids) ? state.gates[phase].evidence_ids : []));
}

function lastRoundEvidenceIds(state) {
  const decided = PHASES.filter((phase) => ['PASSED', 'FAILED'].includes(state?.gates?.[phase]?.status));
  const last = decided[decided.length - 1];
  return last ? (state.gates[last].evidence_ids ?? []) : [];
}

async function reviewVerdict(loop, state) {
  const ids = (state?.gates?.REVIEW?.evidence_ids ?? []).filter((id) => typeof id === 'string');
  for (const id of [...ids].reverse()) {
    const verdict = (await evidenceRecord(loop, id))?.details?.verdict;
    if (verdict === 'PASS' || verdict === 'FAIL') return verdict;
  }
  return null;
}

async function runIds(loop, state) {
  const ids = new Set();
  for (const id of gateEvidenceIds(state)) {
    const runId = (await evidenceRecord(loop, id))?.details?.run_id;
    if (typeof runId === 'string' && runId) ids.add(runId);
  }
  return [...ids].sort();
}

async function openBlockers(loop) {
  const text = await fs.readFile(path.join(loop, 'blockers.md'), 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.includes('- [ ]')).length;
}

// The first readable sentence of a work item section, without list or quote
// markers. Used to turn the human's own handover words into a priority line.
function sectionLead(text, heading) {
  const pattern = new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm');
  const body = pattern.exec(text ?? '')?.[1] ?? '';
  for (const line of body.split(/\r?\n/)) {
    const cleaned = line.replace(/^[-*>\s]+/, '').trim();
    if (cleaned && !cleaned.startsWith('|')) return oneLine(cleaned);
  }
  return null;
}

function priorities({ failedGates, blockers, verdict, handoverLead, decisionLead }) {
  const lines = [];
  for (const phase of failedGates) lines.push(`Harden ${phase}: that gate failed in this run, so read its evidence before taking the same route again.`);
  if (blockers > 0) lines.push(`Resolve the ${blockers} open blocker${blockers === 1 ? '' : 's'} recorded in .loop/blockers.md.`);
  if (verdict === 'FAIL') lines.push('Re-read the review findings: the last recorded verdict was FAIL, so this run is not verified success.');
  if (handoverLead) lines.push(`Review the handover notes: ${handoverLead}`);
  if (decisionLead) lines.push(`Add a follow-up work item for the open decision: ${decisionLead}`);
  lines.push('Review the handover notes in the work item before anything else starts.');
  lines.push('Add a follow-up work item for whatever the handover left open.');
  lines.push('Confirm that the next item is still the right one after this change.');
  return [...new Set(lines)].slice(0, 3);
}

export function renderNextSteps(data) {
  const gateResults = PHASES.map((phase) => `${phase} ${data.gates[phase] ?? 'PENDING'}`).join(', ');
  return [
    `# Next steps after ${data.item_id}`,
    '',
    `- Work item: ${data.item_id}`,
    `- Run ids: ${data.run_ids.length ? data.run_ids.join(', ') : 'none recorded'}`,
    `- Generated at: ${data.generated_at}`,
    '- Advisory only, never an approval: a person decides what happens next.',
    '',
    '## Summary',
    '',
    `- Rounds used: ${data.round} of ${data.max_rounds}`,
    `- Gate results: ${gateResults}`,
    `- Review verdict: ${data.verdict ?? 'none recorded'}`,
    ...(data.review_not_isolated ? [`- Review independence: ${REVIEW_NOT_ISOLATED}`] : []),
    `- Rework loops: ${data.rework_loops}`,
    `- Open blockers: ${data.open_blockers}`,
    '',
    '## Priorities',
    '',
    ...data.priorities.map((line) => `- ${line}`),
    '',
    '## Suggested next item',
    '',
    `- ${data.next_item ?? 'none queued'}`,
    '',
    '## References',
    '',
    `- Evidence of the last round: ${data.last_evidence_ids.length ? data.last_evidence_ids.join(', ') : 'none recorded'}`,
    '',
  ].join('\n');
}

// Writes the note from what is recorded, atomically. It reads state, evidence,
// blockers, the backlog and the work item; it changes none of them.
export async function writeNextSteps(root) {
  const { loop } = await assertControlPath(root);
  const stateFile = path.join(loop, 'state.json');
  if (!await exists(stateFile)) return null;
  const state = await readJson(stateFile, 'state').catch(() => null);
  if (!state?.work_item_id || !idPattern.test(String(state.work_item_id))) return null;
  const itemId = state.work_item_id;
  const gates = Object.fromEntries(PHASES.map((phase) => [phase, state.gates?.[phase]?.status ?? 'PENDING']));
  const failedGates = PHASES.filter((phase) => gates[phase] === 'FAILED');
  const workItem = await fs.readFile(path.join(loop, 'work-items', `${itemId}.md`), 'utf8').catch(() => '');
  const backlog = await readJson(path.join(loop, 'backlog.json'), 'backlog').catch(() => null);
  const first = Array.isArray(backlog?.items) ? backlog.items[0] : null;
  const blockers = await openBlockers(loop);
  const verdict = await reviewVerdict(loop, state);
  const data = {
    item_id: itemId,
    run_ids: await runIds(loop, state),
    generated_at: now(),
    round: Number.isInteger(state.round) ? state.round : 0,
    max_rounds: Number.isInteger(state.max_rounds) ? state.max_rounds : 0,
    gates,
    verdict,
    review_not_isolated: (await recordedReview(root, itemId).catch(() => null))?.review_isolated === false,
    rework_loops: failedGates.length,
    open_blockers: blockers,
    priorities: priorities({
      failedGates,
      blockers,
      verdict,
      handoverLead: sectionLead(workItem, 'Handover'),
      decisionLead: sectionLead(workItem, 'Open decisions'),
    }),
    next_item: first?.id ? `${first.id}: ${oneLine(first.title ?? first.id)}` : null,
    last_evidence_ids: lastRoundEvidenceIds(state).filter((id) => typeof id === 'string'),
  };
  const file = notesFile(loop);
  await atomicText(file, renderNextSteps(data));
  return { file: path.relative(root, file), work_item_id: itemId, advisory: true };
}
