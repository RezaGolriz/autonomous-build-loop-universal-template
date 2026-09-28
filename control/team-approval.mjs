import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadTeam, teamApprovalBinding, teamFiles } from './team.mjs';
import { signApproval } from './approval-store.mjs';
import { ControlError, acquireDirLock, assertControlPath, assertNoEngineLock, atomicJson, jsonDigest, now } from './common.mjs';

export async function teamApprovalSubject(root) {
  const team = await loadTeam(root);
  if (!team) throw new ControlError('TEAM_NOT_CONFIGURED', 'Configure a paused team proposal first.');
  return { proposal_id: team.proposal_id, team_digest: team.team_digest, config: team.config };
}

// Called only by the existing human-decision flow after a literal word at a
// terminal, or settlement of a host-signed local-page confirmation.
export async function authorizeTeamFrozen(root, subject, channel) {
  if (!['interactive-tty', 'local-http-user'].includes(channel)) throw new ControlError('CONFIRMATION_REQUIRED', 'A person must authorize this exact team.');
  const { loop, control } = await assertControlPath(root);
  await assertNoEngineLock(root); await fs.mkdir(loop, { recursive: true });
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'team-authorize' });
  try {
    const current = await teamApprovalSubject(root);
    if (jsonDigest(current) !== jsonDigest(subject)) throw new ControlError('CONFIRMATION_STALE', 'The team changed after its confirmation was prepared.');
    const receipt = { ...teamApprovalBinding(current), channel, approved_at: now(), decision: 'APPROVE' };
    receipt.host_signature = await signApproval(root, receipt);
    await atomicJson(teamFiles(control).approval, receipt);
    return { ok: true, authorized: true, team_digest: current.team_digest, executed: false, assurance: 'local-user-action' };
  } finally { await release(); }
}
