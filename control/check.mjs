// Read-only situation report. It answers "where does this stand" in one call
// and never changes a file. handover_ready means there is something for a
// person to look at; only a PASS verdict plus a passed VALIDATE gate is
// verified success.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertControlPath, confirmationPolicy, exists, readJson } from './common.mjs';
import { backlogSummary, inboxCount, readAuthorization } from './backlog.mjs';
import { holdSummary } from './hold.mjs';

async function reviewVerdict(loop, state) {
  const ids = (state?.gates?.REVIEW?.evidence_ids ?? []).filter((id) => typeof id === 'string' && id.startsWith('review-'));
  for (const id of [...ids].reverse()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) continue;
    const record = await readJson(path.join(loop, 'evidence', `${id}.json`), 'evidence').catch(() => null);
    const verdict = record?.details?.verdict;
    if (verdict === 'PASS' || verdict === 'FAIL') return verdict;
  }
  return null;
}

async function openBlockers(loop) {
  const file = path.join(loop, 'blockers.md');
  if (!await exists(file)) return 0;
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.includes('- [ ]')).length;
}

function nextAction(state, handoverReady, verdict) {
  if (!state) return 'Prepare a setup proposal, have a person approve it, then activate.';
  switch (state.run_status) {
    case 'BLOCKED': return 'Answer the open blockers, then resume.';
    case 'RUNNING': return 'A run is in progress; read status or wait for the next node boundary.';
    case 'PAUSED': return 'Start or resume the run when a person decides it may proceed.';
    case 'WAITING_FOR_HUMAN':
      if (!handoverReady) return typeof state.next_action === 'string' ? state.next_action : 'A person has to look at the run.';
      return verdict === 'PASS'
        ? 'Read the handover and the evidence, then accept or send the item back.'
        : 'Read the handover: the review verdict is not a PASS, so this is not verified success.';
    case 'COMPLETED': return 'Add or authorize the next backlog item.';
    case 'CANCELLED': return 'Record why the run was cancelled, then choose the next item.';
    default: return typeof state?.next_action === 'string' ? state.next_action : 'Read the project status.';
  }
}

export async function check(root) {
  const { loop } = await assertControlPath(root);
  const stateFile = path.join(loop, 'state.json');
  const state = await exists(stateFile) ? await readJson(stateFile, 'state') : null;
  const handoverReady = Boolean(state && state.run_status === 'WAITING_FOR_HUMAN' && state.gates?.HANDOVER?.status === 'PASSED');
  const verdict = state ? await reviewVerdict(loop, state) : null;
  const backlog = await backlogSummary(loop);
  // A project-wide hold is the first thing a person needs to see: while it is
  // there nothing automated runs, whatever the run status says.
  const hold = await holdSummary(root).catch(() => null);
  // A policy file nobody can read is reported, never hidden behind the
  // permissive default: while it is broken the project is tty-only, and the one
  // glance this operation gives has to say so.
  const policy = await confirmationPolicy(root).catch((error) => ({ human_confirmation: 'tty-only', source: 'invalid-policy', error: { code: 'INVALID_POLICY', message: error.message } }));
  return {
    ok: true,
    run_status: state?.run_status ?? null,
    phase: state?.phase ?? null,
    work_item_id: state?.work_item_id ?? null,
    handover_ready: handoverReady,
    judge_verdict: verdict,
    gates: state?.gates ?? null,
    open_blockers: await openBlockers(loop),
    backlog: { ready: backlog.ready, paused: backlog.paused },
    inbox: await inboxCount(loop),
    hold,
    authorization: state ? await readAuthorization(loop, state.work_item_id).catch(() => null) : null,
    human_confirmation: policy.human_confirmation,
    policy: { mode: policy.human_confirmation, source: policy.source, error: policy.error ?? null },
    next_action: hold ? `This project is on hold: ${hold.reason || 'no reason recorded'}. A person releases it with the word RELEASE, at an interactive terminal or on the local confirmation page. Until then nothing automated starts, runs, resumes, ticks, prepares a task or scouts.` : nextAction(state, handoverReady, verdict),
    verified_success_requires: 'a REVIEW verdict of PASS together with a passed VALIDATE gate; handover_ready alone only means there is something to look at',
  };
}

// Command-line exit codes: 0 handover ready or terminal, 3 not done yet,
// 4 blocked, 2 on error (the caller maps a failed result to 2).
export function checkExitCode(result) {
  if (!result?.ok) return 2;
  if (result.run_status === 'BLOCKED') return 4;
  if (result.handover_ready) return 0;
  if (['COMPLETED', 'CANCELLED'].includes(result.run_status)) return 0;
  return 3;
}
