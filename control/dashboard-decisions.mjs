// One control page, registered roots only. This never opens a confirmation URL.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ControlError, acquireDirLock, assertControlPath, confirmationPolicy, exists, jsonDigest, readJson } from './common.mjs';
import { readStore } from './package-store.mjs';
import { approvalSummary, recordTrustedApproval } from './approval.mjs';
import { verifyApproval, verifyHostConfiguration } from './approval-store.mjs';
import { verifyPlanForApproval } from './setup.mjs';
import { listPendingConfirmations, recordConfirmation, requestDigest } from './confirm.mjs';
import { settleHumanDecisions } from './human-ops.mjs';

export async function decisionTarget(root, packageId = '', specDigest = '') {
  if (!packageId) {
    if (specDigest) throw new ControlError('CONFIRMATION_STALE', 'Unexpected package binding.');
    return { root, package_id: '', spec_digest: '', label: 'Main project' };
  }
  const pkg = (await readStore(root)).packages.find(item => item.package_id === packageId);
  if (!pkg || pkg.spec_digest !== specDigest) throw new ControlError('CONFIRMATION_STALE', 'The registered package changed. Reload the dashboard.');
  if (await fs.realpath(pkg.root) !== pkg.root) throw new ControlError('CONFIRMATION_STALE', 'The registered workspace now resolves elsewhere.');
  await assertControlPath(pkg.root);
  return { root: pkg.root, package_id: pkg.package_id, spec_digest: pkg.spec_digest, label: pkg.title };
}

async function assertPagePolicy(parent, target) {
  for (const root of new Set([parent, target.root])) {
    if ((await confirmationPolicy(root)).human_confirmation === 'tty-only') throw new ControlError('CONFIRMATION_TTY_ONLY', 'This project accepts decisions only at an interactive terminal.');
  }
}

export async function pendingSetup(root) {
  const { control } = await assertControlPath(root);
  const pointer = path.join(control, 'current-approval-request.json');
  if (!await exists(pointer)) return null;
  const current = await readJson(pointer);
  if (typeof current.approval_id !== 'string' || !/^request-[A-Za-z0-9_-]+$/.test(current.approval_id)) throw new ControlError('INVALID_APPROVAL', 'Invalid setup request identity.');
  const request = await readJson(path.join(control, 'approval-requests', `${current.approval_id}.json`));
  if (typeof request.setup_digest !== 'string' || !/^[a-f0-9]{64}$/.test(request.setup_digest)) throw new ControlError('INVALID_APPROVAL', 'Invalid setup fingerprint.');
  if (request.approval_id !== current.approval_id || request.setup_digest !== current.setup_digest) throw new ControlError('CONFIRMATION_STALE', 'The setup request changed.');
  const receiptPath = path.join(control, 'approvals', `${request.setup_digest}.json`);
  if (await exists(receiptPath)) {
    const receipt = await readJson(receiptPath);
    try {
      await verifyApproval(root, receipt);
      if (receipt.setup_digest === request.setup_digest) return null;
    } catch (error) { if (error.code !== 'APPROVAL_UNTRUSTED') throw error; }
  }
  if (!(Date.parse(request.expires_at) > Date.now())) return null;
  const plan = await verifyPlanForApproval(root);
  if (plan.setup_digest !== request.setup_digest) throw new ControlError('CONFIRMATION_STALE', 'The setup plan changed. Request a new approval.');
  const hostPath = path.join(root, '.loop', 'host.local.json');
  const host = await exists(hostPath) ? await readJson(hostPath) : null;
  if (host) await verifyHostConfiguration(root, host);
  const summary = await approvalSummary(root, plan);
  if (jsonDigest(summary) !== jsonDigest(request.summary)) throw new ControlError('CONFIRMATION_STALE', 'Provider or setup details changed. Request a new approval.');
  const fingerprint = jsonDigest({ request, summary, host });
  return { request, summary, fingerprint };
}

async function displayFingerprint(target, digest) {
  if (!target.package_id) return digest;
  const stat = await fs.stat(target.root);
  return jsonDigest({ target, device: stat.dev, inode: stat.ino, digest });
}

export async function dashboardDecisions(root) {
  const entries = [], notices = [];
  const bindings = [{ package_id: '', spec_digest: '', label: 'Main project' }];
  try {
    for (const pkg of (await readStore(root)).packages) bindings.push({ package_id: pkg.package_id, spec_digest: pkg.spec_digest, label: pkg.title });
  } catch (error) { notices.push(`Work packages unavailable: ${error.message}`); }
  for (const binding of bindings) {
    try {
      const target = await decisionTarget(root, binding.package_id, binding.spec_digest);
      await assertPagePolicy(root, target);
      const setup = await pendingSetup(target.root);
      if (setup) entries.push({ kind: 'setup', target, ...setup, fingerprint: await displayFingerprint(target, setup.fingerprint) });
      for (const request of await listPendingConfirmations(target.root)) entries.push({ kind: 'operation', target, request, fingerprint: await displayFingerprint(target, requestDigest(request)) });
    } catch (error) {
      notices.push(`${binding.label}: ${error.message}`);
    }
  }
  return { entries, notices };
}

export async function confirmDashboardDecision(root, fields) {
  const target = await decisionTarget(root, fields.package_id, fields.spec_digest);
  await assertPagePolicy(root, target);
  if (fields.kind === 'setup') {
    const { loop } = await assertControlPath(target.root);
    const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'dashboard-setup-approval' });
    try {
      const fresh = await decisionTarget(root, fields.package_id, fields.spec_digest);
      if (fresh.root !== target.root) throw new ControlError('CONFIRMATION_STALE', 'The registered workspace changed. Nothing was recorded.');
      await assertPagePolicy(root, target);
      const setup = await pendingSetup(target.root);
      if (!setup || fields.request_id !== setup.request.approval_id || fields.request_digest !== await displayFingerprint(target, setup.fingerprint)) throw new ControlError('CONFIRMATION_STALE', 'The setup shown on the page changed or expired. Nothing was recorded.');
      if (fields.decision !== 'APPROVE') throw new ControlError('CONFIRMATION_MISMATCH', 'Type APPROVE exactly. Nothing was recorded.');
      await recordTrustedApproval(target.root, setup.request.setup_digest, 'local-http-user', setup.request.approval_id);
      return { ok: true, operation: 'setup', started: false };
    } finally { await release(); }
  }
  if (fields.kind && fields.kind !== 'operation') throw new ControlError('INVALID_INPUT', 'Unknown decision kind.');
  const request = (await listPendingConfirmations(target.root)).find(item => item.request_id === fields.request_id);
  if (!request || await displayFingerprint(target, requestDigest(request)) !== fields.request_digest) throw new ControlError('CONFIRMATION_STALE', 'The decision shown on the page changed or expired. Nothing was recorded.');
  await recordConfirmation(target.root, request.request_id, fields.decision, requestDigest(request));
  const settled = await settleHumanDecisions(target.root);
  const { scheduler } = await assertControlPath(target.root);
  await fs.rm(path.join(scheduler, 'operation-runtime', `${request.request_id}.json`), { force: true });
  return { operation: request.operation, ...(settled.find(item => item.request_id === request.request_id)?.result ?? { ok: false, error: { message: 'No completed decision receipt.' } }) };
}
