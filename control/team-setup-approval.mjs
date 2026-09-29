// One human decision for a frozen team and the pending setups of its registered
// packages. Work authorization remains a separate, per-item human decision.
import { promises as fs } from 'node:fs';
import { recordTrustedApproval } from './approval.mjs';
import { verifyApproval } from './approval-store.mjs';
import { ControlError, confirmationPolicy, exists, jsonDigest, readJson } from './common.mjs';
import { decisionTarget, pendingSetup } from './dashboard-decisions.mjs';
import { readStore } from './package-store.mjs';
import { verifyPlanForApproval } from './setup.mjs';
import { authorizeTeamFrozen, teamApprovalSubject } from './team-approval.mjs';

const same = (a, b) => jsonDigest(a) === jsonDigest(b);

export async function teamSetupSubject(root, channel = 'local-http-user') {
  const team = await teamApprovalSubject(root);
  const store = await readStore(root);
  if (!store.packages.length) throw new ControlError('NO_PACKAGES', 'Register and prepare at least one package before requesting a combined approval.');
  const packages = [];
  for (const pkg of store.packages) {
    const target = await decisionTarget(root, pkg.package_id, pkg.spec_digest);
    const hostFile = `${target.root}/.loop/host.local.json`;
    const host = await exists(hostFile) ? await readJson(hostFile) : null;
    let childTeam = null;
    if (host?.host === 'api' || host?.review_host === 'api') {
      childTeam = await teamApprovalSubject(target.root);
      if (childTeam.team_digest !== team.team_digest) throw new ControlError('TEAM_SCOPE_CHANGED', `The API team in ${pkg.package_id} differs from the main team.`);
    }
    const setup = await pendingSetup(target.root);
    if (!setup) {
      const plan = await verifyPlanForApproval(target.root).catch(() => null);
      const receiptPath = plan && `${target.root}/.loop/control/approvals/${plan.setup_digest}.json`;
      if (!receiptPath || !await exists(receiptPath)) throw new ControlError('SETUP_NOT_PENDING', `Request a current setup approval for ${pkg.package_id} before preparing the combined decision.`);
      const receipt = await readJson(receiptPath);
      await verifyApproval(target.root, receipt);
      if (receipt.setup_digest !== plan.setup_digest) throw new ControlError('SETUP_NOT_PENDING', `The setup approval for ${pkg.package_id} does not match its current plan.`);
      continue;
    }
    if (channel !== 'interactive-tty' && (await confirmationPolicy(target.root)).human_confirmation === 'tty-only') throw new ControlError('CONFIRMATION_TTY_ONLY', `${pkg.package_id} requires a decision at an interactive terminal.`);
    const stat = await fs.stat(target.root);
    packages.push({
      package_id: pkg.package_id, spec_digest: pkg.spec_digest, root: target.root,
      device: stat.dev, inode: stat.ino,
      approval_id: setup.request.approval_id, setup_digest: setup.request.setup_digest,
      setup_fingerprint: setup.fingerprint, summary: setup.summary, child_team: childTeam,
    });
  }
  if (!packages.length) throw new ControlError('NO_PENDING_SETUPS', 'All registered package setups are already approved. Use the existing team authorization if needed.');
  return { team, package_set_digest: jsonDigest(store.packages.map(pkg => [pkg.package_id, pkg.spec_digest])), packages };
}

export async function authorizeTeamSetupsFrozen(root, subject, channel) {
  if (!['interactive-tty', 'local-http-user'].includes(channel)) throw new ControlError('CONFIRMATION_REQUIRED', 'A person must confirm the combined decision.');
  // Check every root and displayed proposal before writing any approval. A
  // cross-root filesystem transaction is unavailable: if a later write fails,
  // some setup receipts may remain, but the team receipt is written last and
  // the supervisor still requires each package's separate READY authority.
  const current = await teamSetupSubject(root, channel);
  if (!same(current, subject)) throw new ControlError('CONFIRMATION_STALE', 'The team, package set, setup, provider or confirmation policy changed. This decision did not approve anything further.');
  for (const pkg of subject.packages) {
    const target = await decisionTarget(root, pkg.package_id, pkg.spec_digest);
    const stat = await fs.stat(target.root);
    if (stat.dev !== pkg.device || stat.ino !== pkg.inode) throw new ControlError('CONFIRMATION_STALE', 'A registered workspace was replaced. Nothing was approved.');
  }
  const approved = [];
  for (const pkg of subject.packages) {
    await recordTrustedApproval(pkg.root, pkg.setup_digest, channel, channel === 'local-http-user' ? pkg.approval_id : null);
    if (pkg.child_team) await authorizeTeamFrozen(pkg.root, pkg.child_team, channel);
    approved.push(pkg.package_id);
  }
  await authorizeTeamFrozen(root, subject.team, channel);
  return { ok: true, authorized: true, team_digest: subject.team.team_digest, setup_approved: approved, executed: false, work_authorized: false, assurance: 'local-user-action' };
}
