import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteSchedulerRecord, readSchedulerRecord, saveSchedulerRecord, schedulerRecordExists } from './scheduler-store.mjs';
import { ControlError, assertControlPath, atomicJson, exists, intValue, jsonDigest, nonce, now, readJson } from './common.mjs';
import { childReadiness, launchIssues, packageAdd, packageList, readStore, withShortLock } from './package-store.mjs';
import { readApiObservation } from '../runtimes/api-observability.mjs';
import { loadTeam, teamStatus, verifyTeamBinding } from './team.mjs';
import { launchJob, managedEnvironment, setIntent, status as childStatus } from './jobs.mjs';
import { assertNotHeld } from './hold.mjs';

export { packageAdd, packageList };
const running = ['QUEUED', 'RUNNING', 'STOPPING'];
const idPattern = /^team-job-[A-Za-z0-9_-]{8,64}$/;
const requestPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function paths(root, create = false) {
  const { scheduler } = await assertControlPath(root);
  const dir = path.join(scheduler, 'supervisor');
  if (create) await fs.mkdir(path.join(dir, 'jobs'), { recursive: true });
  for (const part of [scheduler, dir, path.join(dir, 'jobs')]) {
    const info = await fs.lstat(part).catch(() => null);
    if (info && (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(part) !== part)) throw new ControlError('UNSAFE_CONTROL_PATH', 'Unsafe supervisor directory.');
  }
  return { dir, current: path.join(dir, 'current.json'), index: path.join(dir, 'requests.json'), lock: path.join(dir, 'run.lock'), mutation: path.join(dir, 'mutation.lock'), claim: path.join(dir, 'claim.lock'), lease: path.join(dir, 'lease.json') };
}
const jobPath = (p, id) => { if (!idPattern.test(id)) throw new ControlError('INVALID_INPUT', 'Invalid supervisor job ID.'); return path.join(p.dir, 'jobs', `${id}.json`); };
const save = saveSchedulerRecord;
const trusted = readSchedulerRecord;
async function currentJob(root, p, id) {
  if (!id) { if (!await schedulerRecordExists(root, p.current)) return null; id = (await trusted(root, p.current)).job_id; }
  const job = await trusted(root, jobPath(p, id));
  if (job.kind !== 'supervisor-job' || job.job_id !== id) throw new ControlError('SUPERVISOR_UNTRUSTED', 'Supervisor job identity does not match its record.');
  return job;
}
async function mutableCurrent(root, p, id) {
  const job = await currentJob(root, p);
  if (id && job?.job_id !== id) throw new ControlError('SUPERVISOR_NOT_CURRENT', 'Historical or unclaimed jobs cannot be resumed or changed. Use the current job ID.');
  return job;
}

export function packagesConflict(a, b) {
  const comparable = x => process.platform === 'darwin' ? x.toLowerCase() : x;
  a = { ...a, root: comparable(a.root), shared_paths: a.shared_paths.map(comparable) };
  b = { ...b, root: comparable(b.root), shared_paths: b.shared_paths.map(comparable) };
  if (a.root === b.root) return true;
  if (a.resources.some(x => b.resources.includes(x))) return true;
  return [a.root, ...a.shared_paths].some(x => [b.root, ...b.shared_paths].some(y => x === y || x.startsWith(`${y}${path.sep}`) || y.startsWith(`${x}${path.sep}`)));
}

async function guardParent(root, expectedDigest) {
  await assertNotHeld(root, 'mcp-user', 'supervisor');
  if (await exists(path.join(root, '.loop', 'quarantine.json'))) throw new ControlError('WORKSPACE_QUARANTINED', 'Restore the quarantined parent project before continuing.');
  const team = await verifyTeamBinding(root);
  if (expectedDigest && team.team_digest !== expectedDigest) throw new ControlError('TEAM_APPROVAL_STALE', 'Team changed since this job was authorized.');
  return team;
}

async function guardChild(team, pkg) {
  const child = await childReadiness(pkg.root);
  const issues = launchIssues(child);
  if (issues.length) throw new ControlError(issues[0].code, issues[0].message, { next: issues[0].next });
  if (child.handover_ready) return child;
  if (!Number.isInteger(child.authorization_budget?.max_wall_seconds) || pkg.budget.hard_ceiling_seconds > child.authorization_budget.max_wall_seconds) throw new ControlError('PACKAGE_BUDGET_UNAUTHORIZED', 'Package hard ceiling exceeds its human-authorized budget.');
  const host = child.host;
  for (const [role, providerHost] of [['builder', host], ['reviewer', child.review_host]]) {
    if (providerHost === 'api') {
      const binding = await verifyTeamBinding(pkg.root);
      if (binding.team_digest !== team.team_digest) throw new ControlError('CHILD_TEAM_MISMATCH', 'Child API team differs from the approved supervisor team.');
    } else if (providerHost === 'chat') {
      throw new ControlError('NATIVE_CAPABILITY_UNVERIFIED', 'Automatic supervision of native host agents is unavailable until host delegation and fresh reviewer isolation are verified. Use the existing explicit chat_next/chat_submit path.');
    } else {
      const provider = providerHost === 'codex' ? 'openai' : providerHost === 'claude' ? 'anthropic' : providerHost === 'mock' ? 'mock' : null;
      const member = team.config.members.find(m => m.role === role && m.provider === provider && (m.execution_kind === 'cli' || provider === 'mock'));
      if (!member || (provider !== 'mock' && team.config.execution_policy !== 'hybrid')) throw new ControlError('TEAM_MEMBER_NOT_ALLOWED', `${providerHost} ${role} is not permitted by this team.`);
      const model = child.models?.[role === 'reviewer' ? 'REVIEW' : 'default'] ?? child.models?.default;
      if (provider !== 'mock' && model !== member.requested_model && !member.allowed_resolved_models.includes(model)) throw new ControlError('CHILD_MODEL_MISMATCH', 'The child model configuration is not permitted by the team.');
    }
  }
  return child;
}

// Reserve before admission, not after a long node has already overrun it.
// A node retains its independently bounded provider and verifier timeouts.
export function planNodeAllowance(entry, pkg, boundedNodeSeconds) {
  const elapsed = entry.elapsed_ms / 1000;
  const hardRemaining = pkg.budget.hard_ceiling_seconds - elapsed;
  if (boundedNodeSeconds > hardRemaining) return { allowed: false, extension_seconds: entry.extension_seconds, reason: 'The next bounded node does not fit inside the original hard ceiling.' };
  let extension = entry.extension_seconds;
  if (boundedNodeSeconds > pkg.budget.soft_seconds + extension - elapsed && entry.nodes_completed > 0 && entry.checkpoint_at) extension = pkg.budget.reserve_seconds;
  return { allowed: boundedNodeSeconds <= pkg.budget.soft_seconds + extension - elapsed, extension_seconds: extension, reason: 'The next bounded node does not fit inside the remaining approved allowance.' };
}
async function nodeAllowance(root, child, team) {
  const host = child.phase === 'REVIEW' ? child.review_host : child.host;
  let providerSeconds;
  if (host === 'mock') providerSeconds = 0;
  else if (host === 'api') {
    const role = child.phase === 'REVIEW' ? 'reviewer' : 'builder';
    const member = team.config.members.find(m => m.role === role && m.execution_kind === 'managed_api');
    if (!member) throw new ControlError('TEAM_MEMBER_NOT_ALLOWED', 'No approved API member for this phase.');
    providerSeconds = member.budget.max_seconds;
  } else providerSeconds = child.timeouts?.[child.phase] ?? child.timeouts?.default ?? 900;
  const adapter = await readJson(path.join(root, '.loop', 'project.adapter.json'));
  const checks = adapter.commands.filter(x => x.phase === child.phase);
  if (checks.some(x => !Number.isInteger(x.timeout_seconds) || x.timeout_seconds <= 0)) throw new ControlError('UNBOUNDED_NODE', 'All verifiers require finite timeouts.');
  return providerSeconds + checks.reduce((sum, x) => sum + x.timeout_seconds, 0) + 15;
}

// A supervisor launch is permission to continue already-authorized packages,
// never a replacement for their setup approval or READY authorization.
export async function supervisorStart(root, args, channel = 'mcp-user') {
  if (!requestPattern.test(args.request_id ?? '')) throw new ControlError('INVALID_INPUT', 'request_id is required.');
  const maxNodes = intValue(args.max_nodes_per_package ?? 12, 'max_nodes_per_package', 1, 500);
  const p = await paths(root, true);
  return withShortLock(p.mutation, 'supervisor-start', async () => {
    const team = await guardParent(root);
    const store = await readStore(root);
    if (!store.packages.length) throw new ControlError('NO_PACKAGES', 'Register and approve at least one isolated package first.');
    const requestDigest = jsonDigest({ team_digest: team.team_digest, packages: store.packages.map(x => x.spec_digest), maxNodes });
    const index = await schedulerRecordExists(root, p.index) ? await trusted(root, p.index) : { requests: {} };
    if (Object.hasOwn(index.requests, args.request_id)) {
      const previous = await currentJob(root, p, index.requests[args.request_id]);
      if (previous.request_digest !== requestDigest) throw new ControlError('REQUEST_ID_REUSED', 'This request ID belongs to a different team or package set.');
      return { ok: true, idempotent: true, job: previous };
    }
    const prior = await currentJob(root, p);
    if (prior && running.includes(prior.status)) throw new ControlError('SUPERVISOR_ACTIVE', 'Read or resume the existing supervisor; do not start a duplicate.', { job_id: prior.job_id });
    if (prior && prior.packages.some(x => x.child_job_id && x.running)) throw new ControlError('CHILD_JOB_ACTIVE', 'A child from the previous job is still stopping.');
    if (prior) throw new ControlError('SUPERVISOR_RESUME_REQUIRED', 'Continue or inspect the current job. A new request ID never creates a replacement budget.');
    const children = new Map();
    for (const pkg of store.packages) children.set(pkg.package_id, await guardChild(team, pkg));
    if (await schedulerRecordExists(root, p.lease)) throw new ControlError('SUPERVISOR_RECOVERY_REQUIRED', 'An existing supervisor lease must be inspected before a new job is launched.');
    const id = `team-job-${nonce(12)}`; const fence = nonce(24);
    const job = { schema_version: 1, kind: 'supervisor-job', job_id: id, request_id: args.request_id, request_digest: requestDigest,
      team_digest: team.team_digest, specs_digest: jsonDigest(store.packages), package_specs: store.packages, created_at: now(), updated_at: now(), status: 'QUEUED',
      desired_status: 'RUNNING', pid: null, fence, max_nodes_per_package: maxNodes, packages: store.packages.map(pkg => ({
        id: pkg.package_id, work_item_id: children.get(pkg.package_id).work_item_id, activation_digest: children.get(pkg.package_id).activation_digest, host_config_digest: children.get(pkg.package_id).host_config_digest, elapsed_ms: 0, nodes_completed: 0, retries: 0, child_job_id: null, running: false,
        attempt: 1, extension_seconds: 0, status: 'QUEUED', checkpoint_at: null, tick_at: null, next_action: 'Waiting for a free slot.',
      })) };
    try {
      await save(root, jobPath(p, id), job); index.requests[args.request_id] = id; await save(root, p.index, index);
      await save(root, p.current, { kind: 'supervisor-current', job_id: id });
      await save(root, p.lease, { kind: 'supervisor-lease', job_id: id, fence, pid: null });
      await startWorker(root, job, p);
      return { ok: true, idempotent: false, job: await currentJob(root, p, id) };
    } catch (error) {
      await withShortLock(p.claim, 'supervisor-start-failed', async () => {
        const latest = await currentJob(root, p, id).catch(() => job);
        latest.status = 'FAILED'; latest.desired_status = 'PAUSED'; latest.next_action = error.message; latest.pid = null;
        await save(root, jobPath(p, id), latest);
        for (const entry of latest.packages.filter(x => x.running)) {
          const pkg = store.packages.find(x => x.package_id === entry.id);
          if (pkg) await stopOwnedChild(pkg, entry, job.desired_status === 'CANCELLED' ? 'CANCELLED' : 'PAUSED').catch(() => null);
        }
        await removeLease(root, p, latest);
      });
      throw error;
    }
  });
}

async function startWorker(root, job, p) {
  const proc = spawn(process.execPath, [fileURLToPath(new URL('./supervisor-worker.mjs', import.meta.url)), root, job.job_id, job.fence],
    { detached: true, stdio: 'ignore', env: managedEnvironment() });
  await new Promise((resolve, reject) => { proc.once('spawn', resolve); proc.once('error', reject); }); proc.unref();
  // Startup handshake: the child owns the lease before the launcher returns.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const started = await currentJob(root, p, job.job_id);
    if (started.started_pid === proc.pid) return;
    if (!alive(proc.pid)) throw new ControlError('SUPERVISOR_START_FAILED', 'The supervisor exited before acquiring its lease.');
    await pause(25);
  }
  try { process.kill(proc.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  throw new ControlError('SUPERVISOR_START_FAILED', 'The supervisor did not acquire its lease in time; its known process was stopped. Inspect children before recovery.');
}
async function removeLease(root, p, job) {
  if (!await schedulerRecordExists(root, p.lease)) return;
  const lease = await trusted(root, p.lease);
  if (lease.job_id !== job.job_id || (lease.fence !== job.fence && alive(lease.pid))) throw new ControlError('SUPERVISOR_FENCE_LOST', 'Another supervisor owns this lease.');
  await deleteSchedulerRecord(root, p.lease);
}

export async function supervisorStatus(root, args = {}) {
  const p = await paths(root); const job = await currentJob(root, p, args.job_id);
  const team = await teamStatus(root); const store = await readStore(root);
  const packages = [];
  for (const pkg of store.packages) {
    const child = await childReadiness(pkg.root);
    const observation = job?.packages.find(x => x.id === pkg.package_id);
    const result = child.initialized ? await childStatus(pkg.root).catch(() => null) : null;
    const gates = Object.fromEntries((child.gates ?? []).map(g => [g.phase, { status: g.status, evidence_ids: g.evidence_ids }]));
    const apiObservation = await readApiObservation(pkg.root).catch(() => null);
    const observedApi = apiObservation?.work_item_id === child.work_item_id && apiObservation?.team_digest === job?.team_digest ? apiObservation : null;
    const passed = Object.values(gates).filter(g => g.status === 'PASSED' && g.evidence_ids.length).length;
    packages.push({ id: pkg.package_id, title: pkg.title, workspace: pkg.root, phase: child.phase,
      status: observation?.status ?? child.run_status ?? 'NEEDS_SETUP', gates, progress: child.initialized ? { passed, total: 6 } : null,
      accepted: false, integrated: false,
      elapsed_seconds: observation ? Math.ceil(observation.elapsed_ms / 1000) : 0, hard_seconds: pkg.budget.hard_ceiling_seconds,
      extension_seconds: observation?.extension_seconds ?? 0, attempt: observation?.attempt ?? 1, max_attempts: pkg.max_retries + 1,
      job_id: observation?.child_job_id, checkpoint_at: observation?.checkpoint_at,
      heartbeat_at: result?.job?.heartbeat_at, expires_at: child.authorization_expires_at,
      execution_kind: child.host === 'api' ? 'managed_api' : child.host === 'chat' ? 'native' : child.host === 'mock' ? 'mock' : 'cli',
      reported_model: observedApi?.reported_model ?? null, model_source: observedApi?.reported_model ? `Provider response from ${observedApi.phase} · ${observedApi.updated_at}` : 'Not reported by this child status', member_id: observedApi?.member_id ?? null,
      session_id: observedApi?.session_id ?? null, api_session_status: observedApi?.status ?? null, usage: observedApi?.usage ?? null,
      next_action: observation?.next_action ?? child.next[0] ?? 'Inspect setup and authorization before starting.',
      blocker: observation?.blocker ?? (child.problems.map(x => x.message).join('; ') || null),
      evidence_refs: Object.values(gates).flatMap(g => g.evidence_ids), revision: null });
  }
  return { ok: true, job, configured: team.configured, mode: team.mode ?? 'sequential', status: job && running.includes(job.status) && !alive(job.pid) ? 'RECOVERY_REQUIRED' : job?.status ?? 'NOT_STARTED',
    max_active_packages: team.limits?.max_active_packages ?? 1, max_active_agents: team.limits?.max_active_agents ?? 2,
    members: (team.members ?? []).map(m => ({ ...m, readiness: m.readiness?.state, capability_note: m.readiness?.detail })),
    progress_unit: 'gates', packages, supervisor_alive: alive(job?.pid) };
}

async function assertWorkerFence(root, p, job) {
  const lease = await trusted(root, p.lease);
  if (lease.fence !== job.fence || lease.job_id !== job.job_id || lease.pid !== process.pid) throw new ControlError('SUPERVISOR_FENCE_LOST', 'Worker no longer owns this supervisor.');
}
async function stopOwnedChild(pkg, entry, desired) {
  const current = await childStatus(pkg.root);
  if (current.job?.job_id !== entry.child_job_id) throw new ControlError('CHILD_JOB_CHANGED', 'A different child job is active; it is not owned by this supervisor.');
  return setIntent(pkg.root, desired, entry.child_job_id);
}
async function recoverLaunching(pkg, entry) {
  if (!entry.child_request_id || (entry.status !== 'LAUNCHING' && entry.child_job_id)) return;
  let index;
  try { index = await readJson(path.join(pkg.root, '.loop', 'control', 'request-index.json')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new ControlError('CHILD_RECOVERY_REQUIRED', 'The child launch index cannot be read. Absence of a receipt is not proof that no child launched.');
  }
  const id = index?.requests && Object.hasOwn(index.requests, entry.child_request_id) ? index.requests[entry.child_request_id] : null;
  const current = (await childStatus(pkg.root)).job;
  const currentId = current?.request_id === entry.child_request_id ? current.job_id : null;
  if (id && currentId && id !== currentId) throw new ControlError('CHILD_RECOVERY_REQUIRED', 'The launch index disagrees with the current child identity.');
  const verifiedId = id ?? currentId;
  if (!verifiedId) throw new ControlError('CHILD_RECOVERY_REQUIRED', 'Interrupted launch has no verifiable child receipt. Inspect the child; do not infer that nothing launched.');
  if (typeof verifiedId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(verifiedId)) throw new ControlError('CHILD_RECOVERY_REQUIRED', 'Invalid child launch identity.');
  const observed = await childStatus(pkg.root, { job_id: verifiedId });
  if (observed.job?.request_id !== entry.child_request_id || observed.job.work_item_id !== entry.work_item_id || observed.job.activation_digest !== entry.activation_digest || observed.job.host_config_digest !== entry.host_config_digest) throw new ControlError('CHILD_SCOPE_CHANGED', 'Interrupted launch no longer matches its original scope.');
  entry.child_job_id = verifiedId; entry.child_nodes_counted = 0; entry.running = true;
  entry.tick_at = observed.job.created_at; entry.status = 'RUNNING';
}

export async function reconcileChild(pkg, entry) {
  if (!entry.child_job_id) throw new ControlError('CHILD_JOB_MISSING', 'The child launch must be recovered by its recorded request ID.');
  const result = await childStatus(pkg.root, { job_id: entry.child_job_id });
  const cj = result.job;
  if (cj?.job_id !== entry.child_job_id) throw new ControlError('CHILD_JOB_CHANGED', 'The referenced child job cannot be verified.');
  const tick = Date.parse(entry.tick_at);
  if (!Number.isFinite(tick) || !Number.isFinite(entry.elapsed_ms) || entry.elapsed_ms < 0 || !Number.isInteger(cj.nodes_completed) || cj.nodes_completed < 0) throw new ControlError('INVALID_CHILD_ACCOUNTING', 'Invalid child time or node counters.');
  // A stop publishes its terminal status before the worker's final persist
  // adds finished_at. Keep that live closing interval in flight; it is not a
  // corrupted checkpoint and never permission to launch another child.
  const finalizing = !running.includes(cj.status) && !Number.isFinite(Date.parse(cj.finished_at)) && alive(cj.pid);
  const active = running.includes(cj.status) || finalizing;
  const finished = active ? Date.now() : Date.parse(cj.finished_at);
  if (!Number.isFinite(finished)) throw new ControlError('INVALID_CHILD_ACCOUNTING', 'Terminal child has no valid finish time.');
  const end = Math.min(Date.now(), finished);
  entry.elapsed_ms += Math.max(0, end - tick); entry.tick_at = new Date(Math.max(tick, end)).toISOString();
  const counted = entry.child_nodes_counted ?? 0;
  if (cj.nodes_completed < counted) throw new ControlError('INVALID_CHILD_ACCOUNTING', 'Child node counter moved backwards.');
  entry.nodes_completed += cj.nodes_completed - counted; entry.child_nodes_counted = cj.nodes_completed;
  if (finalizing && pkg.budget && entry.elapsed_ms >= pkg.budget.hard_ceiling_seconds * 1000) {
    entry.running = false; entry.child_recovery_required = true; entry.status = 'BLOCKED';
    entry.blocker = 'Closing checkpoint exceeded the original hard budget. Inspect the existing worker; its locks are retained.';
  }
  if (!active) { entry.running = false; entry.checkpoint_at = cj.finished_at; }
  else if (!alive(cj.pid) && Date.now() - Date.parse(cj.created_at) > 5000) { entry.running = false; entry.child_recovery_required = true; entry.status = 'BLOCKED'; entry.blocker = 'Child worker interrupted; inspect descendant ownership and locks before continuing.'; }
  return { result, cj, finalizing, active: active && !entry.child_recovery_required };
}

async function intentFor(root, p, job) {
  const file = path.join(p.dir, `${job.job_id}.intent.json`);
  if (!await schedulerRecordExists(root, file)) return null;
  const intent = await trusted(root, file);
  if (intent.kind !== 'supervisor-intent' || intent.job_id !== job.job_id || !['PAUSED', 'CANCELLED'].includes(intent.desired)) throw new ControlError('SUPERVISOR_UNTRUSTED', 'Invalid supervisor intent.');
  return intent;
}
async function effectiveDesired(root, p, job) {
  const intent = await intentFor(root, p, job);
  if (job.desired_status === 'CANCELLED' || intent?.desired === 'CANCELLED') return 'CANCELLED';
  return intent?.fence === job.fence ? intent.desired : job.desired_status;
}
async function settleOwnedChildren(root, p, job, desired, ownWorker = false) {
  return withShortLock(p.claim, 'supervisor-settle', async () => {
  job = await mutableCurrent(root, p, job.job_id);
  // Claim and settle share a lock. A queued worker cannot start after this
  // check and have its freshly persisted launch overwritten by a stale copy.
  if (alive(job.pid) && !(ownWorker && job.pid === process.pid)) return true;
  let unresolved = false;
  for (const pkg of job.package_specs) {
    const entry = job.packages.find(x => x.id === pkg.package_id);
    try {
      await recoverLaunching(pkg, entry);
      if (!entry.running) {
        unresolved ||= Boolean(entry.child_recovery_required);
        if (!entry.child_recovery_required && ['RUNNING', 'QUEUED'].includes(entry.status)) entry.status = desired;
        continue;
      }
      const observed = await reconcileChild(pkg, entry);
      if (observed.active && !observed.finalizing) {
        try { await stopOwnedChild(pkg, entry, desired); }
        catch (error) {
          if (!['NOT_RUNNING', 'CHILD_JOB_CHANGED'].includes(error.code)) throw error;
          const refreshed = await reconcileChild(pkg, entry);
          if (refreshed.active && !refreshed.finalizing) throw error;
        }
        entry.next_action = 'Existing child is stopping at its bounded node boundary.';
      }
      if (!entry.running && ['RUNNING', 'QUEUED'].includes(entry.status)) entry.status = desired;
      unresolved ||= entry.running || Boolean(entry.child_recovery_required);
    } catch (error) { entry.blocker = error.message; entry.status = 'BLOCKED'; unresolved = true; }
  }
  job.desired_status = desired;
  job.status = unresolved ? 'STOPPING' : desired;
  job.pid = null; job.updated_at = now();
  await save(root, jobPath(p, job.job_id), job);
  if (await schedulerRecordExists(root, p.lease)) await removeLease(root, p, job);
  return unresolved;
  });
}
async function setSupervisorIntent(root, args, desired) {
  const p = await paths(root, true);
  return withShortLock(p.mutation, 'supervisor-intent', async () => {
    const job = await mutableCurrent(root, p, args.job_id);
    if (!job) throw new ControlError('NO_SUPERVISOR', 'No supervisor job exists.');
    if (await effectiveDesired(root, p, job) === 'CANCELLED') desired = 'CANCELLED';
    await save(root, path.join(p.dir, `${job.job_id}.intent.json`), { kind: 'supervisor-intent', job_id: job.job_id, fence: job.fence, desired, requested_at: now() });
    const stopping = !alive(job.pid) ? await settleOwnedChildren(root, p, job, desired) : true;
    return { ok: true, job_id: job.job_id, desired_status: desired, deferred_until_node_boundary: stopping };
  });
}
export const supervisorPause = (root, args = {}) => setSupervisorIntent(root, args, 'PAUSED');
export const supervisorCancel = (root, args = {}) => setSupervisorIntent(root, args, 'CANCELLED');

export async function supervisorResume(root, args = {}, channel = 'mcp-user') {
  const p = await paths(root, true);
  return withShortLock(p.mutation, 'supervisor-resume', async () => {
    const job = await mutableCurrent(root, p, args.job_id);
    if (!job) throw new ControlError('NO_SUPERVISOR', 'No job exists.');
    if (await effectiveDesired(root, p, job) === 'CANCELLED') throw new ControlError('SUPERVISOR_CANCELLED', 'Cancellation is final; inspect recovery to stop any remaining owned children.');
    if (alive(job.pid)) throw new ControlError('SUPERVISOR_ACTIVE', 'The existing supervisor is still alive; read its status.');
    if (!['PAUSED', 'BLOCKED', 'FAILED', 'STOPPING'].includes(job.status)) throw new ControlError('SUPERVISOR_RECOVERY_REQUIRED', 'Inspect an interrupted supervisor before resuming it.');
    const team = await guardParent(root, job.team_digest);
    if (jsonDigest((await readStore(root)).packages) !== job.specs_digest) throw new ControlError('PACKAGE_SCOPE_CHANGED', 'The registered package set changed; existing budgets cannot be rebound.');
    for (const pkg of job.package_specs) {
      const entry = job.packages.find(x => x.id === pkg.package_id);
      try {
        await recoverLaunching(pkg, entry);
        if (entry.running) { const observed = await reconcileChild(pkg, entry); if (observed.active) continue; }
        if (entry.child_recovery_required) throw new ControlError('CHILD_RECOVERY_REQUIRED', 'Interrupted child ownership requires inspection; no engine locks are removed.');
        const child = await guardChild(team, pkg);
        if (child.work_item_id !== entry.work_item_id || child.activation_digest !== entry.activation_digest || child.host_config_digest !== entry.host_config_digest) throw new ControlError('CHILD_SCOPE_CHANGED', 'The original child binding changed.');
        if (['WAITING_FOR_HUMAN', 'COMPLETED'].includes(entry.status)) continue;
        if (entry.nodes_completed >= job.max_nodes_per_package) throw new ControlError('PACKAGE_NODE_BUDGET_EXHAUSTED', 'Original bounded node count exhausted.');
        if (entry.elapsed_ms >= pkg.budget.hard_ceiling_seconds * 1000) throw new ControlError('PACKAGE_BUDGET_EXHAUSTED', 'Original package time budget exhausted.');
        if (entry.child_job_id) {
          const previous = (await childStatus(pkg.root, { job_id: entry.child_job_id })).job;
          if (previous?.status === 'FAILED' && previous.nodes_completed === 0 && entry.retry_for_child !== previous.job_id) {
            if (entry.retries >= pkg.max_retries) throw new ControlError('PACKAGE_RETRY_BUDGET_EXHAUSTED', 'Original technical retry limit exhausted.');
            entry.retries++; entry.retry_for_child = previous.job_id;
          }
          if (previous?.nodes_completed === 0 && entry.resume_for_child !== previous.job_id) { entry.attempt++; entry.resume_for_child = previous.job_id; }
        }
        entry.status = 'QUEUED'; entry.blocker = null;
      } catch (error) { entry.status = 'BLOCKED'; entry.blocker = `${error.code ?? 'RECOVERY'}: ${error.message}`; }
    }
    await save(root, jobPath(p, job.job_id), job);
    if (await schedulerRecordExists(root, p.lease)) {
      const lease = await trusted(root, p.lease);
      if (alive(lease.pid)) throw new ControlError('SUPERVISOR_ACTIVE', 'Existing lease owner is alive.');
      await removeLease(root, p, job);
    }
    if (!job.packages.some(x => x.running || x.status === 'QUEUED')) return { ok: true, job_id: job.job_id, budgets_preserved: true, blocked: true, next: 'Each package has retained its own blocker; no usable work remains.' };
    job.status = 'QUEUED'; job.desired_status = 'RUNNING'; job.pid = null; job.started_pid = null; job.fence = nonce(24);
    await save(root, jobPath(p, job.job_id), job);
    await deleteSchedulerRecord(root, path.join(p.dir, `${job.job_id}.intent.json`));
    await save(root, p.lease, { kind: 'supervisor-lease', job_id: job.job_id, fence: job.fence, pid: null });
    try { await startWorker(root, job, p); }
    catch (error) {
      const latest = await currentJob(root, p, job.job_id);
      await settleOwnedChildren(root, p, latest, await effectiveDesired(root, p, latest) === 'CANCELLED' ? 'CANCELLED' : 'PAUSED');
      throw error;
    }
    return { ok: true, job_id: job.job_id, budgets_preserved: true };
  });
}
export async function supervisorRecover(root, args = {}) {
  const p = await paths(root, true);
  return withShortLock(p.mutation, 'supervisor-recover', async () => {
    const job = await mutableCurrent(root, p, args.job_id);
    if (!job) throw new ControlError('NO_SUPERVISOR', 'No existing job.');
    if (alive(job.pid)) return { ok: true, existing_alive: true, job_id: job.job_id, next: 'Read status; do not start another job.' };
    const desired = await effectiveDesired(root, p, job) === 'CANCELLED' ? 'CANCELLED' : 'PAUSED';
    const unresolved = await settleOwnedChildren(root, p, job, desired);
    return { ok: true, job_id: job.job_id, recovered: true, stopping: unresolved, next: desired === 'CANCELLED' ? 'Cancellation remains final. Inspect until all owned children stop.' : 'Wait for existing children to stop, then resume this same job. Budgets and retries were retained.' };
  });
}

export async function supervisorWorker(root, id, fence) {
  const p = await paths(root, true); let job = await currentJob(root, p, id);
  await withShortLock(p.claim, 'supervisor-claim', async () => {
    const lease = await trusted(root, p.lease);
    job = await currentJob(root, p, id);
    if (job.status !== 'QUEUED' || job.pid !== null || job.fence !== fence || lease.fence !== fence || lease.job_id !== id) throw new ControlError('SUPERVISOR_FENCE_LOST', 'Delayed or duplicate worker cannot claim this job.');
    await save(root, p.lease, { ...lease, pid: process.pid });
    job.pid = process.pid; job.started_pid = process.pid; job.status = 'RUNNING'; await save(root, jobPath(p, id), job);
  });
  const persist = async () => { const own = await trusted(root, p.lease); if (own.fence !== fence || own.pid !== process.pid) throw new ControlError('SUPERVISOR_FENCE_LOST', 'Supervisor lease changed.'); job.updated_at = now(); await save(root, jobPath(p, id), job); };
  try {
    for (;;) {
      const store = { packages: job.package_specs };
      let team;
      try { team = await guardParent(root, job.team_digest); if (jsonDigest((await readStore(root)).packages) !== job.specs_digest) throw new ControlError('PACKAGE_SCOPE_CHANGED', 'Registered packages changed.'); }
      catch (error) { if (job.desired_status !== 'CANCELLED') job.desired_status = 'PAUSED'; job.next_action = error.message; }
      const intentFile = path.join(p.dir, `${id}.intent.json`);
      job.desired_status = await effectiveDesired(root, p, job);
      for (const pkg of store.packages) {
        const entry = job.packages.find(x => x.id === pkg.package_id);
        if (!entry?.running) continue;
        let observed;
        try { observed = await reconcileChild(pkg, entry); }
        catch (error) {
          entry.status = 'BLOCKED'; entry.blocker = error.message;
          entry.running = false; entry.child_recovery_required = true;
          continue;
        }
        const { result, cj, active, finalizing } = observed;
        if (entry.child_recovery_required) continue;
        if (active) {
          if (finalizing) { entry.next_action = 'The existing worker is recording its final checkpoint.'; continue; }
          if (entry.elapsed_ms >= pkg.budget.soft_seconds * 1000 && pkg.budget.reserve_seconds && entry.nodes_completed > 0 && entry.checkpoint_at) entry.extension_seconds = pkg.budget.reserve_seconds;
          if (job.desired_status !== 'RUNNING' || entry.elapsed_ms >= (pkg.budget.soft_seconds + entry.extension_seconds) * 1000) {
            await assertWorkerFence(root, p, job);
            await stopOwnedChild(pkg, entry, job.desired_status === 'CANCELLED' ? 'CANCELLED' : 'PAUSED'); entry.next_action = 'Stopping at the current bounded node boundary.';
          }
          continue;
        }
        if (result.state?.run_status === 'WAITING_FOR_HUMAN' && result.state?.gates?.HANDOVER?.status === 'PASSED') entry.status = 'WAITING_FOR_HUMAN';
        else if (cj?.status === 'PAUSED') { entry.status = 'PAUSED'; entry.next_action = 'Child paused at a bounded node boundary. Resume the existing supervisor when authorized.'; }
        else if (cj?.status === 'FAILED' || result.state?.run_status === 'BLOCKED') { entry.status = 'BLOCKED'; entry.blocker = cj?.last_error?.message ?? result.state?.last_result ?? 'Read the failed checks before continuing.'; }
        else if (entry.nodes_completed >= job.max_nodes_per_package) { entry.status = 'PAUSED'; entry.next_action = 'The bounded node count was reached.'; }
        else if (entry.elapsed_ms >= pkg.budget.hard_ceiling_seconds * 1000) { entry.status = 'BLOCKED'; entry.blocker = 'Original hard package budget exhausted.'; }
        else entry.status = job.desired_status === 'RUNNING' ? 'QUEUED' : job.desired_status;
      }
      if (job.desired_status === 'RUNNING' && team) {
        const slots = Math.min(team.config.max_active_packages, team.config.max_active_agents);
        for (const pkg of store.packages) {
          const entry = job.packages.find(x => x.id === pkg.package_id);
          if (!entry || entry.running || entry.status !== 'QUEUED') continue;
          if (entry.nodes_completed >= job.max_nodes_per_package) { entry.status = 'PAUSED'; entry.next_action = 'Original bounded node limit exhausted.'; continue; }
          const active = store.packages.filter(x => { const owner = job.packages.find(e => e.id === x.package_id); return owner?.running || owner?.child_recovery_required; });
          if (active.length >= slots) break;
          const conflict = active.some(x => packagesConflict(pkg, x));
          if (conflict) { if (pkg.on_conflict === 'block') { entry.status = 'BLOCKED'; entry.blocker = 'A shared path or resource is currently owned by another package.'; } continue; }
          const pending = pkg.depends_on.length > 0; // No signed integration receipt exists yet; never infer it from handover/history prose.
          if (pending) { entry.next_action = 'Dependency integration requires a separate verified receipt; automatic dependent launch is unavailable.'; continue; }
          let freshRequestId = null;
          try {
            const child = await guardChild(team, pkg);
            if (child.work_item_id !== entry.work_item_id || child.activation_digest !== entry.activation_digest || child.host_config_digest !== entry.host_config_digest) throw new ControlError('CHILD_SCOPE_CHANGED', 'The child work item, activation or provider changed since supervisor launch.');
            if (child.handover_ready) { entry.status = 'WAITING_FOR_HUMAN'; continue; }
            const allowance = planNodeAllowance(entry, pkg, await nodeAllowance(pkg.root, child, team));
            entry.extension_seconds = allowance.extension_seconds;
            if (!allowance.allowed) { entry.status = 'BLOCKED'; entry.blocker = allowance.reason; continue; }
            if (entry.elapsed_ms >= (pkg.budget.soft_seconds + entry.extension_seconds) * 1000) { entry.status = 'BLOCKED'; entry.blocker = 'Time allowance exhausted without verified checkpoint movement.'; continue; }
            await assertWorkerFence(root, p, job);
            entry.status = 'LAUNCHING'; entry.child_job_id = null; entry.launch_sequence = (entry.launch_sequence ?? 0) + 1; entry.child_request_id = `${id}-${entry.id}-launch-${entry.launch_sequence}`;
            freshRequestId = entry.child_request_id;
            await persist();
            const launched = await launchJob(pkg.root, child.run_status === 'PAUSED' ? 'start' : 'run',
              { request_id: entry.child_request_id, max_nodes: 1 }, 'mcp-user');
            entry.child_job_id = launched.job.job_id; entry.child_nodes_counted = 0; entry.running = true; entry.status = 'RUNNING'; entry.tick_at = new Date().toISOString(); entry.next_action = 'One runner-owned node is executing.';
          } catch (error) {
            if (error.code === 'SUPERVISOR_FENCE_LOST') throw error;
            if (entry.status === 'LAUNCHING' && freshRequestId !== null && entry.child_request_id === freshRequestId && error.child_spawned_in_this_call === false) {
              entry.status = 'BLOCKED'; entry.child_request_id = null;
              entry.blocker = error.message; continue;
            }
            if (entry.status === 'LAUNCHING') { await recoverLaunching(pkg, entry); if (entry.running) { entry.next_action = 'Reattached after interrupted launch.'; continue; } }
            entry.status = 'BLOCKED'; entry.blocker = error.message;
          }
        }
      }
      await persist();
      if (!job.packages.some(x => x.running)) {
        const queued = job.packages.some(x => x.status === 'QUEUED');
        if (job.desired_status !== 'RUNNING' || !queued || job.packages.every(x => ['COMPLETED', 'WAITING_FOR_HUMAN', 'BLOCKED', 'PAUSED'].includes(x.status))) {
          job.status = job.desired_status !== 'RUNNING' ? job.desired_status : job.packages.some(x => x.status === 'BLOCKED') ? 'BLOCKED' : job.packages.some(x => x.status === 'PAUSED') ? 'PAUSED' : 'COMPLETED'; break;
        }
        // Dependencies waiting on human decisions do not keep an idle daemon busy.
        if (queued && !job.packages.some(x => x.status === 'RUNNING')) { job.status = 'PAUSED'; job.next_action = 'Dependencies need a human decision before continuation.'; break; }
      }
      await pause(250);
    }
  } catch (error) {
    job.status = 'FAILED'; job.next_action = error.message;
    job.desired_status = await effectiveDesired(root, p, job) === 'CANCELLED' ? 'CANCELLED' : 'PAUSED';
    const store = { packages: job.package_specs };
    for (const entry of job.packages.filter(x => x.running)) {
      const pkg = store?.packages.find(x => x.package_id === entry.id);
      if (pkg) await stopOwnedChild(pkg, entry, job.desired_status === 'CANCELLED' ? 'CANCELLED' : 'PAUSED').catch(() => null);
    }
  }
  finally {
    await withShortLock(p.mutation, 'supervisor-finalize', async () => {
      job.desired_status = await effectiveDesired(root, p, job);
      if (job.desired_status !== 'RUNNING') {
        await assertWorkerFence(root, p, job);
        await settleOwnedChildren(root, p, job, job.desired_status, true);
      } else { job.pid = null; await persist(); await removeLease(root, p, job); }
    });
  }
}
