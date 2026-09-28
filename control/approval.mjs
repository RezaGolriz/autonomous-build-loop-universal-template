import { signApproval, verifyApproval } from './approval-store.mjs';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlError, acquireDirLock, assertControlPath, atomicJson, exactKeys, exists, jsonDigest, nonce, now, readJson, resolveRoot, sha256 } from './common.mjs';
import { verifyPlanForApproval } from './setup.mjs';

import { runningControlPageLink } from './control-page.mjs';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'approval-server.mjs');

export async function recordTrustedApproval(root, setupDigest, channel, requestId = null) {
  root = await resolveRoot(root);
  const { control } = await assertControlPath(root);
  await fs.mkdir(control, { recursive: true });
  const release = await acquireDirLock(path.join(control, 'setup-approval.lock'), { operation: 'record-setup-approval' });
  try { return await recordTrustedApprovalUnlocked(root, setupDigest, channel, requestId); }
  finally { await release(); }
}

async function recordTrustedApprovalUnlocked(root, setupDigest, channel, requestId) {
  if (!['local-http-user', 'interactive-tty'].includes(channel)) throw new ControlError('INVALID_APPROVAL_CHANNEL', 'untrusted approval channel');
  root = await resolveRoot(root);
  const { control } = await assertControlPath(root); const plan = await verifyPlanForApproval(root);
  if (plan.setup_digest !== setupDigest) throw new ControlError('SETUP_CHANGED', 'approval digest no longer matches the setup plan');
  if (channel === 'local-http-user') {
    const current = await readJson(path.join(control, 'current-approval-request.json'), 'current approval request');
    if (!requestId || current.approval_id !== requestId || current.setup_digest !== setupDigest) throw new ControlError('APPROVAL_SUPERSEDED', 'this approval request is no longer current');
    const request = await readJson(path.join(control, 'approval-requests', `${requestId}.json`));
    if (!(Date.parse(request.expires_at) > Date.now())) throw new ControlError('CONFIRMATION_EXPIRED', 'The setup request expired.');
    if (jsonDigest(request.summary) !== jsonDigest(await approvalSummary(root, plan))) throw new ControlError('CONFIRMATION_STALE', 'Setup or provider details changed after the request was prepared.');
  }
  const receiptPath = path.join(control, 'approvals', `${setupDigest}.json`);
  if (await exists(receiptPath)) {
    const existing = await readJson(receiptPath);
    try {
      await verifyApproval(root, existing);
      if (existing.setup_digest !== setupDigest) throw new ControlError('CONFIRMATION_STALE', 'Approval fingerprint changed.');
      return existing;
    } catch (error) {
      // A forged project-side file is not approval and cannot prevent the
      // person's newly confirmed exact proposal from being recorded.
      if (error.code !== 'APPROVAL_UNTRUSTED') throw error;
    }
  }
  const approval = { schema_version: 1, approval_id: requestId || `approval-${nonce(12)}`, setup_digest: setupDigest, decision: 'APPROVE', channel, approved_at: now() };
  approval.host_signature = await signApproval(root, approval);
  await atomicJson(path.join(control, 'approvals', `${setupDigest}.json`), approval);
  return approval;
}

export async function approvalSummary(root, plan) {
  // A rebind reviews the active setup, unchanged, against a changed package.
  const base = plan.kind === 'rebind' ? path.join(root, '.loop') : path.join(root, '.loop', 'candidate');
  const adapter = await readJson(path.join(base, 'project.adapter.json'));
  const state = await readJson(path.join(base, 'state.json'));
  const workText = await fs.readFile(path.join(base, 'work-items', `${state.work_item_id}.md`), 'utf8').catch(() => '');
  const workKind = /^Kind: (.+)$/m.exec(workText)?.[1] || 'unspecified';
  const hostFile = path.join(root, '.loop', 'host.local.json');
  const host = await exists(hostFile) ? await readJson(hostFile, 'host.local.json') : null;
  const provider = host ? {
    host: host.host,
    provider_path: host.provider_path,
    review_host: host.review_host,
    review_provider_path: host.review_provider_path,
    authentication_check_configured: Boolean(host.auth_check),
    models: host.models ?? null, timeouts: host.timeouts ?? null,
    cli_path: host.cli_path ?? null, review_cli_path: host.review_cli_path ?? null,
    host_config_digest: jsonDigest(host),
  } : null;
  return {
    project: path.basename(root),
    project_root: root,
    adapter_id: adapter.adapter_id,
    adapter,
    target: adapter.target,
    provider,
    work_kind: workKind,
    ...(plan.kind === 'rebind' ? {
      kind: 'rebind',
      request: `Re-activate the existing setup after the build-loop package changed (now version ${plan.package_version}). Adapter, workflow, run state and work items stay unchanged; only the activation record is rewritten after the probes pass.`,
      acceptance_criteria: ['All positive probes pass in a disposable copy.', 'The negative control fails exactly as declared.'],
      out_of_scope: ['Any change to the adapter, workflow, run state, work items or evidence.'],
      allowed_paths: [], frozen_paths: [],
      rebind: { previous_setup_digest: plan.previous_setup_digest, package_version: plan.package_version, distribution_changes: plan.distribution_changes, run_status: state.run_status, work_item_id: state.work_item_id },
    } : {
      request: plan.requested_scope.request,
      acceptance_criteria: plan.requested_scope.acceptance_criteria,
      out_of_scope: plan.requested_scope.out_of_scope,
      allowed_paths: plan.requested_scope.allowed_paths,
      frozen_paths: plan.requested_scope.frozen_paths,
    }),
    protected_paths: adapter.protected_paths,
    environment_names: adapter.environment.allow_names,
    required_evidence: adapter.validation.required_evidence,
    commands: adapter.commands.map(({ id, phase, cwd, argv, timeout_seconds, evidence_types }) => ({ id, phase, cwd, argv, timeout_seconds, evidence_types })),
    limits: { max_rounds: state.max_rounds, max_gate_failures: state.max_gate_failures, max_wall_seconds: state.max_wall_seconds, autonomy: state.autonomy },
    negative_control: plan.negative_control,
    config_hashes: plan.config_hashes,
  };
}

export async function requestApproval(root, args = {}, options = {}) {
  exactKeys(args, [], [], 'args');
  const { control } = await assertControlPath(root); const plan = await verifyPlanForApproval(root);
  if (await exists(path.join(control, 'approvals', `${plan.setup_digest}.json`))) {
    const receipt = await readJson(path.join(control, 'approvals', `${plan.setup_digest}.json`));
    try { await verifyApproval(root, receipt); return { ok: true, already_approved: true, setup_digest: plan.setup_digest, next: 'activate' }; } catch {} // An untrusted project receipt cannot suppress a fresh human review.
  }
  const pageLink = await runningControlPageLink(options.dashboardRoot || root).catch(() => null);
  const summary = await approvalSummary(root, plan);
  const currentFile = path.join(control, 'current-approval-request.json');
  if (await exists(currentFile)) {
    const current = await readJson(currentFile, 'current approval request').catch(() => null);
    if (current?.setup_digest === plan.setup_digest) {
      const requestFile = path.join(control, 'approval-requests', `${current.approval_id}.json`); const runtimeFile = path.join(control, 'approval-runtime', `${current.approval_id}.json`); const readyFile = path.join(control, 'approval-runtime', `${current.approval_id}.ready.json`);
      if (await exists(requestFile) && await exists(runtimeFile) && (pageLink || await exists(readyFile))) {
        const request = await readJson(requestFile); const runtime = await readJson(runtimeFile); const endpoint = pageLink ? null : await readJson(readyFile);
        if (Date.parse(request.expires_at) > Date.now() && jsonDigest(request.summary) === jsonDigest(summary)) return { ok: true, idempotent: true, approval_id: current.approval_id, setup_digest: plan.setup_digest, confirmation_url: pageLink || `${endpoint.origin}/review?token=${encodeURIComponent(runtime.token)}`, ...(pageLink ? { control_page: true } : {}), expires_at: request.expires_at, assurance: 'local-user-action' };
      }
    }
  }
  const approvalId = `request-${nonce(12)}`; const token = nonce(24);
  const runtimeDir = path.join(control, 'approval-runtime'); await fs.mkdir(runtimeDir, { recursive: true });
  const request = {
    schema_version: 1,
    approval_id: approvalId,
    setup_digest: plan.setup_digest,
    created_at: now(),
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    token_sha256: sha256(token),
    summary,
  };
  await atomicJson(path.join(control, 'approval-requests', `${approvalId}.json`), request);
  await atomicJson(path.join(runtimeDir, `${approvalId}.json`), { token }, 0o600);
  await atomicJson(currentFile, { schema_version: 1, approval_id: approvalId, setup_digest: plan.setup_digest });
  if (pageLink) return { ok: true, approval_id: approvalId, setup_digest: plan.setup_digest, confirmation_url: pageLink, control_page: true, expires_at: request.expires_at, assurance: 'local-user-action', instruction: 'Review the setup in the main dashboard and type APPROVE. Never confirm it yourself.' };
  const ready = path.join(runtimeDir, `${approvalId}.ready.json`);
  const log = await fs.open(path.join(runtimeDir, `${approvalId}.log`), 'a', 0o600);
  const child = spawn(process.execPath, [serverPath, root, approvalId], { detached: true, stdio: ['ignore', log.fd, log.fd] }); child.unref(); await log.close();
  const deadline = Date.now() + 3000; let endpoint;
  while (Date.now() < deadline) {
    if (await exists(ready)) { endpoint = await readJson(ready, 'approval endpoint'); break; }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  if (!endpoint) throw new ControlError('APPROVAL_SERVER_FAILED', 'local approval server did not become ready (with a fixed confirmation_page.port another page may still be open on that port)');
  return { ok: true, approval_id: approvalId, setup_digest: plan.setup_digest, confirmation_url: `${endpoint.origin}/review?token=${encodeURIComponent(token)}`, expires_at: request.expires_at, assurance: 'local-user-action', instruction: 'Open the local URL and press Approve. This records a loopback user action, not cryptographic human identity; the setup digest is rechecked when the POST arrives.' };
}
