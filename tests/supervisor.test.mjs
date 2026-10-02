import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { launchJob } from '../control/jobs.mjs';
import { dispatch } from '../control/index.mjs';
import { recordTrustedApproval } from '../control/approval.mjs';
import { authorize } from '../control/backlog.mjs';
import { loadTeam, teamConfigure } from '../control/team.mjs';
import { authorizeTeamFrozen, teamApprovalSubject } from '../control/team-approval.mjs';
import { childReadiness, readStore } from '../control/package-store.mjs';
import { jsonDigest } from '../control/common.mjs';
import { readSchedulerRecord, saveSchedulerRecord } from '../control/scheduler-store.mjs';
import { packageAdd, packagesConflict, planNodeAllowance, reconcileChild, reconcileInterruptedChild, supervisorCancel, supervisorCloseCycle, supervisorPause, supervisorRecover, supervisorResume, supervisorStart, supervisorStatus } from '../control/supervisor.mjs';

process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'supervisor-trust-')));
await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);
const temp = async prefix => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
const typed = { channel: 'interactive-tty' };
const config = { schema_version: 1, team_id: 'mock-team', mode: 'parallel', max_active_packages: 2, max_active_agents: 2, execution_policy: 'api_only', members: ['builder', 'reviewer'].map(role => ({
  id: role, role, provider: 'mock', execution_kind: 'managed_api', requested_model: 'mock', endpoint: 'http://127.0.0.1:1/v1',
  tool_scope: role === 'builder' ? ['read_file', 'write_file'] : ['read_file'],
  data_scope: { read_paths: ['docs/**'], write_paths: role === 'builder' ? ['docs/**'] : [] }, budget: { max_turns: 4, max_total_tokens: 1000, max_seconds: 30 },
})) };

async function settle(root, id) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const s = await dispatch(root, 'status', { job_id: id });
    if (!['RUNNING', 'QUEUED', 'STOPPING'].includes(s.job?.status)) return s;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Fixture activation timed out');
}
async function child() {
  const root = await temp('team-child-');
  const prepared = await dispatch(root, 'demo', { kind: 'docs' }); assert.equal(prepared.ok, true, JSON.stringify(prepared));
  await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty');
  const activated = await dispatch(root, 'activate', {}); assert.equal(activated.ok, true, JSON.stringify(activated));
  const done = await settle(root, activated.job.job_id); assert.equal(done.job.status, 'COMPLETED', JSON.stringify(done.job));
  await authorize(root, { confirm: 'AUTHORIZE', max_wall_seconds: 900, max_rounds: 20, allowed_paths: ['docs/guide.md'] }, 'interactive-tty');
  return root;
}

test('shared paths and named resources conflict even when workspace roots differ', () => {
  const a = { root: '/tmp/a', resources: ['database'], shared_paths: ['/tmp/shared'] };
  assert.equal(packagesConflict(a, { root: '/tmp/b', resources: ['database'], shared_paths: [] }), true);
  assert.equal(packagesConflict(a, { root: '/tmp/b', resources: [], shared_paths: ['/tmp/shared/output'] }), true);
  assert.equal(packagesConflict(a, { root: '/tmp/b', resources: [], shared_paths: ['/tmp/other'] }), false);
  assert.equal(packagesConflict(a, { root: '/tmp/shared/child', resources: [], shared_paths: [] }), true, 'a shared footprint overlapping another package root must serialize');
});

test('a team authorization from chat stays pending and cannot be a generic flag', async () => {
  const root = await temp('team-confirm-'); await teamConfigure(root, { config });
  const result = await dispatch(root, 'team_authorize', { confirm: 'AUTHORIZE' }, { channel: 'mcp-user' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.pending_confirmation, true);
  assert.ok(result.confirmation_url); assert.equal((await dispatch(root, 'team_status')).approval.state, 'PENDING');
  const forged = await dispatch(root, 'team_authorize', { confirm: 'AUTHORIZE', confirmed: true });
  assert.equal(forged.ok, false);
});

test('supervisor refuses missing approval and parent hold before launching', async () => {
  const root = await temp('team-refusal-'); await teamConfigure(root, { config });
  await assert.rejects(() => supervisorStart(root, { request_id: 'unapproved' }), e => e.code === 'TEAM_APPROVAL_REQUIRED');
  await authorizeTeamFrozen(root, await teamApprovalSubject(root), 'interactive-tty');
  const held = await dispatch(root, 'hold', { reason: 'fixture hold' }, typed); assert.equal(held.ok, true);
  await assert.rejects(() => supervisorStart(root, { request_id: 'held' }), e => e.code === 'PROJECT_ON_HOLD');
});

test('two isolated documentation packages run in parallel through all six gates', { timeout: 240_000 }, async () => {
  const root = await temp('team-example-'); await teamConfigure(root, { config });
  await authorizeTeamFrozen(root, await teamApprovalSubject(root), 'interactive-tty');
  const a = await child(); const b = await child();
  for (const [id, workspace] of [['guide-a', a], ['guide-b', b]]) await packageAdd(root, { package_id: id, workspace_root: workspace,
    budget: { soft_seconds: 300, reserve_seconds: 300, hard_ceiling_seconds: 600 } });
  const launched = await supervisorStart(root, { request_id: 'example-parallel', max_nodes_per_package: 12 });
  assert.equal(launched.ok, true);
  const duplicate = await supervisorStart(root, { request_id: 'example-parallel', max_nodes_per_package: 12 }); assert.equal(duplicate.idempotent, true);
  let result; let observedParallel = false; const deadline = Date.now() + 180_000;
  do {
    result = await supervisorStatus(root, { job_id: launched.job.job_id });
    observedParallel ||= result.job.packages.filter(x => x.running).length === 2;
    if (!['QUEUED', 'RUNNING'].includes(result.job.status)) break;
    await new Promise(r => setTimeout(r, 100));
  } while (Date.now() < deadline);
  assert.equal(result.job.status, 'COMPLETED', JSON.stringify(result.job));
  assert.equal(observedParallel, true, 'both isolated workspaces should execute concurrently');
  assert.deepEqual(result.packages.map(x => x.status), ['WAITING_FOR_HUMAN', 'WAITING_FOR_HUMAN']);
  assert.deepEqual(result.packages.map(x => x.progress.passed), [6, 6]);
  assert.ok(result.packages.every(x => !x.accepted && !x.integrated));
  await fs.unlink(path.join(root, '.loop', 'scheduler', 'supervisor', 'requests.json'));
  const restoredRequest = await supervisorStart(root, { request_id: 'example-parallel', max_nodes_per_package: 12 });
  assert.equal(restoredRequest.job.job_id, launched.job.job_id, 'a missing local request index must recover from its private latest record');
  assert.equal((await loadTeam(root)).team_digest, result.job.team_digest);
  await assert.rejects(() => supervisorStart(root, { request_id: 'cannot-reset-budgets', max_nodes_per_package: 12 }), e => e.code === 'SUPERVISOR_RESUME_REQUIRED');
  await assert.rejects(() => packageAdd(root, { package_id: 'late', prepare: true, budget: { soft_seconds: 60, hard_ceiling_seconds: 60 } }), e => e.code === 'PACKAGE_SET_FROZEN');
  const firstEntry = result.job.packages[0];
  const childRecord = (await dispatch(a, 'status', { job_id: firstEntry.child_job_id })).job;
  const accounting = { child_job_id: firstEntry.child_job_id, tick_at: new Date(Date.parse(childRecord.finished_at) - 10_000).toISOString(), elapsed_ms: 0, nodes_completed: 0, child_nodes_counted: 0, running: true };
  await reconcileChild({ root: a }, accounting);
  assert.equal(accounting.elapsed_ms, 10_000, 'recovery charges only until child finished, not until a later reconnect');
  assert.equal(accounting.nodes_completed, childRecord.nodes_completed);
  await reconcileChild({ root: a }, accounting);
  assert.equal(accounting.elapsed_ms, 10_000, 'reconciliation is idempotent');
  assert.equal(accounting.nodes_completed, childRecord.nodes_completed);
  for (const pkg of result.packages) { const state = JSON.parse(await fs.readFile(path.join(pkg.workspace, '.loop', 'state.json')));
    assert.ok(Object.values(state.gates).every(x => x.status === 'PASSED' && x.evidence_ids.length > 0)); }

  // Closing the finished cycle opens a new package set without resetting the
  // budget of work the closed cycle left unfinished.
  const closed = await supervisorCloseCycle(root);
  assert.deepEqual([closed.closed_cycle, closed.cycle, closed.closed_job_id], [1, 2, launched.job.job_id]);
  assert.equal((await readStore(root)).packages.length, 0, 'a new cycle starts with an empty package set');
  const fresh = await supervisorStatus(root);
  assert.equal(fresh.cycle, 2); assert.equal(fresh.job, null);
  await assert.rejects(() => packageAdd(root, { package_id: 'guide-a', workspace_root: a, budget: { soft_seconds: 300, hard_ceiling_seconds: 600 } }),
    e => e.code === 'PACKAGE_CYCLE_REUSE', 'an unfinished work item from a closed cycle cannot get a fresh budget');
  await packageAdd(root, { package_id: 'late', prepare: true, budget: { soft_seconds: 60, hard_ceiling_seconds: 60 } });
  assert.deepEqual((await readStore(root)).packages.map(x => x.package_id), ['late']);
  await fs.unlink(path.join(root, '.loop', 'scheduler', 'cycle.json'));
  assert.equal((await supervisorStatus(root)).cycle, 2, 'a missing local cycle record recovers from its private latest record');
  await assert.rejects(() => supervisorCloseCycle(root), e => e.code === 'NO_SUPERVISOR');
  assert.equal((await supervisorStatus(root, { job_id: launched.job.job_id }).catch(e => e)).code, 'SCHEDULER_UNTRUSTED', 'a closed cycle\'s job is history, not current');
});

test('cancelling an interrupted supervisor stops its owned child and remains final even after pause', { timeout: 120_000 }, async () => {
  const root = await temp('team-cancel-recovery-'); await teamConfigure(root, { config });
  await authorizeTeamFrozen(root, await teamApprovalSubject(root), 'interactive-tty');
  const workspace = await child();
  const ownFixtureLock = path.join(workspace, '.loop', 'orchestrator.lock');
  await fs.mkdir(ownFixtureLock);
  try {
    await assert.rejects(() => launchJob(workspace, 'start', { request_id: 'preflight-refusal', max_nodes: 1 }),
      error => error.code === 'WORKSPACE_LOCKED' && error.child_spawned_in_this_call === false);
    const index = JSON.parse(await fs.readFile(path.join(workspace, '.loop', 'control', 'request-index.json')));
    assert.equal(Object.hasOwn(index.requests, 'preflight-refusal'), false, 'a proven preflight refusal starts no child');
  } finally { await fs.rmdir(ownFixtureLock); }
  await packageAdd(root, { package_id: 'guide', workspace_root: workspace, budget: { soft_seconds: 300, hard_ceiling_seconds: 600 } });
  const launched = await supervisorStart(root, { request_id: 'cancel-original', max_nodes_per_package: 12 });
  let snapshot; const deadline = Date.now() + 20_000;
  do { snapshot = await supervisorStatus(root); if (snapshot.job.packages[0].running && snapshot.job.packages[0].child_job_id) break; await new Promise(r => setTimeout(r, 25)); } while (Date.now() < deadline);
  assert.ok(snapshot.job.packages[0].running);
  process.kill(snapshot.job.pid, 'SIGKILL'); await new Promise(r => setTimeout(r, 100));
  const jobFile = path.join(root, '.loop', 'scheduler', 'supervisor', 'jobs', `${launched.job.job_id}.json`);
  const interrupted = await readSchedulerRecord(root, jobFile);
  interrupted.packages[0].status = 'LAUNCHING'; interrupted.packages[0].child_job_id = null;
  await saveSchedulerRecord(root, jobFile, interrupted);
  const indexFile = path.join(workspace, '.loop', 'control', 'request-index.json');
  const originalIndex = await fs.readFile(indexFile);
  await fs.writeFile(indexFile, '{broken');
  assert.equal((await supervisorCancel(root)).desired_status, 'CANCELLED');
  assert.equal((await supervisorStatus(root)).job.status, 'STOPPING', 'an unreadable child receipt cannot certify that nothing launched');
  await fs.writeFile(indexFile, originalIndex);
  await supervisorRecover(root);
  assert.equal((await supervisorPause(root)).desired_status, 'CANCELLED', 'pause never overwrites cancellation');
  await fs.unlink(path.join(root, '.loop', 'scheduler', 'supervisor', `${launched.job.job_id}.intent.json`));
  const childId = snapshot.job.packages[0].child_job_id;
  const stopDeadline = Date.now() + 30_000;
  while (Date.now() < stopDeadline) { const observed = await dispatch(workspace, 'status', { job_id: childId }); if (!['RUNNING', 'QUEUED', 'STOPPING'].includes(observed.job?.status)) break; await new Promise(r => setTimeout(r, 50)); }
  await supervisorRecover(root);
  const cancelled = await supervisorStatus(root);
  assert.equal(cancelled.job.status, 'CANCELLED', JSON.stringify(cancelled.job));
  assert.equal(cancelled.job.packages[0].running, false);
  assert.equal(cancelled.job.packages[0].child_job_id, childId);
  await assert.rejects(() => supervisorResume(root), e => e.code === 'SUPERVISOR_CANCELLED');
  await assert.rejects(() => supervisorStart(root, { request_id: 'new-id-reset' }), e => e.code === 'SUPERVISOR_RESUME_REQUIRED');
});

test('a zero-consumption current job cannot be replaced and historical jobs cannot mutate the supervisor', async () => {
  const root = await temp('team-current-binding-'); await teamConfigure(root, { config });
  await authorizeTeamFrozen(root, await teamApprovalSubject(root), 'interactive-tty');
  await packageAdd(root, { package_id: 'guide', prepare: true, budget: { soft_seconds: 60, hard_ceiling_seconds: 60 } });
  const dir = path.join(root, '.loop', 'scheduler', 'supervisor'); await fs.mkdir(path.join(dir, 'jobs'), { recursive: true });
  const id = 'team-job-current123'; const oldId = 'team-job-history123';
  await saveSchedulerRecord(root, path.join(dir, 'current.json'), { kind: 'supervisor-current', job_id: id });
  for (const jobId of [id, oldId]) await saveSchedulerRecord(root, path.join(dir, 'jobs', `${jobId}.json`), {
    kind: 'supervisor-job', job_id: jobId, status: 'PAUSED', desired_status: 'PAUSED', pid: null,
    packages: [{ id: 'guide', elapsed_ms: 0, nodes_completed: 0, retries: 0, running: false }],
  });
  await assert.rejects(() => supervisorStart(root, { request_id: 'replacement' }), e => e.code === 'SUPERVISOR_RESUME_REQUIRED');
  for (const operation of [supervisorResume, supervisorRecover, supervisorCancel, supervisorPause]) {
    await assert.rejects(() => operation(root, { job_id: oldId }), e => e.code === 'SUPERVISOR_NOT_CURRENT');
  }
  assert.equal((await readSchedulerRecord(root, path.join(dir, 'current.json'))).job_id, id);
});

test('a live terminal worker without its final timestamp remains in flight; a missing dead checkpoint blocks', async () => {
  const workspace = await child(); const job = (await dispatch(workspace, 'status')).job;
  const file = path.join(workspace, '.loop', 'control', 'jobs', `${job.job_id}.json`);
  const original = await fs.readFile(file);
  const entry = { child_job_id: job.job_id, tick_at: new Date().toISOString(), elapsed_ms: 0, nodes_completed: 0, child_nodes_counted: 0, running: true };
  try {
    await fs.writeFile(file, JSON.stringify({ ...job, status: 'PAUSED', finished_at: null, pid: process.pid }));
    const closing = await reconcileChild({ root: workspace }, entry);
    assert.equal(closing.finalizing, true); assert.equal(closing.active, true); assert.equal(entry.running, true);
    const overdue = { ...entry, tick_at: new Date(Date.now() - 2000).toISOString(), elapsed_ms: 0 };
    const bounded = await reconcileChild({ root: workspace, budget: { hard_ceiling_seconds: 1 } }, overdue);
    assert.equal(bounded.active, false); assert.equal(overdue.child_recovery_required, true);
    assert.match(overdue.blocker, /original hard budget/);
    await fs.writeFile(file, JSON.stringify({ ...job, status: 'PAUSED', finished_at: null, pid: 2147483647 }));
    await assert.rejects(() => reconcileChild({ root: workspace }, entry), error => error.code === 'INVALID_CHILD_ACCOUNTING');
  } finally { await fs.writeFile(file, original); }
});

test('recovery wins a queued claim when the launcher dies after spawn; the delayed worker cannot launch', { timeout: 120_000 }, async () => {
  const root = await temp('team-queued-recovery-'); await teamConfigure(root, { config });
  await authorizeTeamFrozen(root, await teamApprovalSubject(root), 'interactive-tty');
  const workspace = await child();
  await packageAdd(root, { package_id: 'guide', workspace_root: workspace, budget: { soft_seconds: 300, hard_ceiling_seconds: 600 } });
  const source = `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    const spawn=cp.spawn; cp.spawn=(...args)=>{const proc=spawn(...args); proc.once('spawn',()=>{proc.kill('SIGSTOP'); process.stdout.write(String(proc.pid)+'\\n');}); return proc;};
    syncBuiltinESMExports(); const {supervisorStart}=await import(${JSON.stringify(new URL('../control/supervisor.mjs', import.meta.url).href)});
    await supervisorStart(${JSON.stringify(root)}, {request_id:'queued-original',max_nodes_per_package:12});`;
  const launcher = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  const workerPid = Number(await new Promise((resolve, reject) => { launcher.stdout.once('data', data => resolve(data.toString().trim())); launcher.once('error', reject); }));
  try {
    const before = await supervisorStatus(root);
    assert.equal(before.job.status, 'QUEUED'); assert.equal(before.job.pid, null);
    const exit = new Promise(resolve => launcher.once('exit', resolve)); launcher.kill('SIGKILL'); await exit;
    await supervisorRecover(root);
    process.kill(workerPid, 'SIGCONT');
    await new Promise(resolve => setTimeout(resolve, 200));
    const after = await supervisorStatus(root);
    assert.equal(after.job.status, 'PAUSED');
    assert.equal(after.job.packages[0].child_job_id, null, 'the delayed worker lost its claim before any child could launch');
    assert.equal((await dispatch(workspace, 'status')).state.run_status, 'PAUSED');
  } finally {
    try { process.kill(workerPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
  }
});


test('a time reserve requires a checkpoint and never exceeds the original hard ceiling', () => {
  const pkg = { budget: { soft_seconds: 100, reserve_seconds: 50, hard_ceiling_seconds: 150 } };
  const entry = { elapsed_ms: 80_000, nodes_completed: 0, checkpoint_at: null, extension_seconds: 0 };
  assert.equal(planNodeAllowance(entry, pkg, 30).allowed, false);
  const progressed = { ...entry, nodes_completed: 1, checkpoint_at: new Date().toISOString() };
  assert.deepEqual(planNodeAllowance(progressed, pkg, 30), { allowed: true, extension_seconds: 50, reason: 'The next bounded node does not fit inside the remaining approved allowance.' });
  assert.equal(planNodeAllowance(progressed, pkg, 71).allowed, false);
});

test('package_control cannot replace a bound root or address an unregistered package', async () => {
  const root = await temp('team-package-routing-');
  const missing = await dispatch(root, 'package_control', { package_id: 'missing', operation: 'inspect' });
  assert.equal(missing.error.code, 'PACKAGE_NOT_FOUND');
  await packageAdd(root, { package_id: 'guide', prepare: true, budget: { soft_seconds: 60, hard_ceiling_seconds: 60 } });
  const inspected = await dispatch(root, 'package_control', { package_id: 'guide', operation: 'inspect' });
  assert.equal(inspected.ok, true); assert.equal(inspected.package_id, 'guide');
  const override = await dispatch(root, 'package_control', { package_id: 'guide', operation: 'inspect', input: { root: '/' } });
  assert.equal(override.ok, false);
  const recursive = await dispatch(root, 'package_control', { package_id: 'guide', operation: 'package_control' });
  assert.equal(recursive.error.code, 'PACKAGE_OPERATION_NOT_ALLOWED');
});


test('a lost supervisor reconnects to the same job without resetting counters or duplicating the child', { timeout: 180_000 }, async () => {
  const root = await temp('team-reconnect-'); await teamConfigure(root, { config });
  await authorizeTeamFrozen(root, await teamApprovalSubject(root), 'interactive-tty');
  const workspace = await child();
  await packageAdd(root, { package_id: 'guide', workspace_root: workspace, budget: { soft_seconds: 300, reserve_seconds: 300, hard_ceiling_seconds: 600 } });
  const launched = await supervisorStart(root, { request_id: 'reconnect-original', max_nodes_per_package: 12 });
  let snapshot; const observeDeadline = Date.now() + 20_000;
  do { snapshot = await supervisorStatus(root); if (snapshot.job.packages[0].running && snapshot.job.packages[0].child_job_id) break; await new Promise(r => setTimeout(r, 25)); } while (Date.now() < observeDeadline);
  assert.ok(snapshot.job.packages[0].child_job_id, 'launch identity must be durable before interruption');
  process.kill(snapshot.job.pid, 'SIGTERM');
  await new Promise(r => setTimeout(r, 100));
  const recovered = await supervisorRecover(root, { job_id: launched.job.job_id });
  assert.equal(recovered.recovered, true);
  const existingChild = snapshot.job.packages[0].child_job_id;
  const stopDeadline = Date.now() + 30_000;
  while (Date.now() < stopDeadline) { const status = await dispatch(workspace, 'status', { job_id: existingChild }); if (!['RUNNING', 'QUEUED', 'STOPPING'].includes(status.job?.status)) break; await new Promise(r => setTimeout(r, 50)); }
  const resumed = await supervisorResume(root, { job_id: launched.job.job_id });
  assert.equal(resumed.job_id, launched.job.job_id); assert.equal(resumed.budgets_preserved, true);
  const finishDeadline = Date.now() + 90_000;
  do { snapshot = await supervisorStatus(root); if (!['RUNNING', 'QUEUED'].includes(snapshot.job.status)) break; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < finishDeadline);
  assert.equal(snapshot.job.status, 'COMPLETED', JSON.stringify(snapshot.job));
  assert.equal(snapshot.job.max_nodes_per_package, 12);
  assert.ok(snapshot.job.packages[0].nodes_completed >= 6);
  assert.ok(snapshot.job.packages[0].elapsed_ms > 0);
  assert.equal(snapshot.packages[0].progress.passed, 6);
});

test('completion between the status read and dead-worker probe is reconciled exactly once', async () => {
  const finished = new Date(Date.now() - 4000).toISOString();
  const base = { job_id: 'job-race', created_at: new Date(Date.now() - 60000).toISOString(), pid: 2147483647 };
  const terminal = { job: { ...base, status: 'COMPLETED', nodes_completed: 3, finished_at: finished } };
  const reads = [{ job: { ...base, status: 'RUNNING', nodes_completed: 1 } }, terminal];
  const entry = { child_job_id: base.job_id, tick_at: new Date(Date.parse(finished) - 6000).toISOString(), elapsed_ms: 1000, nodes_completed: 2, child_nodes_counted: 1, running: true };
  const observed = await reconcileChild({ root: '/unused' }, entry, { readChild: async () => reads.shift() });
  assert.equal(observed.active, false); assert.equal(reads.length, 0);
  assert.equal(entry.child_recovery_required, undefined);
  assert.equal(entry.nodes_completed, 4); assert.equal(entry.elapsed_ms, 7000);
  await reconcileChild({ root: '/unused' }, entry, { readChild: async () => terminal });
  assert.equal(entry.nodes_completed, 4); assert.equal(entry.elapsed_ms, 7000);
  const interrupted = { ...entry, running: true };
  await reconcileChild({ root: '/unused' }, interrupted, { readChild: async () => ({ job: { ...terminal.job, status: 'RUNNING', finished_at: null } }) });
  assert.equal(interrupted.recovery_reason, 'WORKER_INTERRUPTED');
});

test('official recovery verifies terminal bindings and locks, retains counters and enforces resume limits', { timeout: 180000 }, async () => {
  const root = await temp('team-sticky-'); await teamConfigure(root, { config });
  await authorizeTeamFrozen(root, await teamApprovalSubject(root), 'interactive-tty');
  const workspace = await child();
  await packageAdd(root, { package_id: 'guide', workspace_root: workspace, budget: { soft_seconds: 300, hard_ceiling_seconds: 600 } });
  const binding = await childReadiness(workspace);
  const launched = await launchJob(workspace, 'start', { request_id: 'sticky-child', max_nodes: 1 });
  let cj; const deadline = Date.now() + 60000;
  do { cj = (await dispatch(workspace, 'status', { job_id: launched.job.job_id })).job;
    if (cj.finished_at && !await fs.lstat(path.join(workspace, '.loop/control/job.lock')).catch(() => null)) break;
    await new Promise(r => setTimeout(r, 50));
  } while (Date.now() < deadline);
  assert.equal(cj.status, 'COMPLETED');
  const packages = (await readStore(root)).packages; const team = await loadTeam(root);
  const dir = path.join(root, '.loop/scheduler/supervisor'); await fs.mkdir(path.join(dir, 'jobs'), { recursive: true });
  const id = 'team-job-sticky1234'; const file = path.join(dir, 'jobs', `${id}.json`);
  const flagged = (extra = {}) => ({ id: 'guide', work_item_id: binding.work_item_id, activation_digest: binding.activation_digest, host_config_digest: binding.host_config_digest,
    child_job_id: cj.job_id, child_request_id: cj.request_id, elapsed_ms: 5000, nodes_completed: 3, child_nodes_counted: 0, retries: 0, attempt: 1, extension_seconds: 0,
    running: false, child_recovery_required: true, status: 'BLOCKED', tick_at: new Date().toISOString(),
    blocker: 'CHILD_RECOVERY_REQUIRED: Interrupted child ownership requires inspection; no engine locks are removed.', ...extra });
  const install = entry => saveSchedulerRecord(root, file, { schema_version: 1, kind: 'supervisor-job', job_id: id, team_digest: team.team_digest,
    specs_digest: jsonDigest(packages), package_specs: packages, status: 'BLOCKED', desired_status: 'RUNNING', pid: null, fence: 'fixture-fence', max_nodes_per_package: 12, packages: [entry] });
  await saveSchedulerRecord(root, path.join(dir, 'current.json'), { kind: 'supervisor-current', job_id: id });
  const after = async () => (await readSchedulerRecord(root, file)).packages[0];
  const blocked = async () => { await supervisorRecover(root); const entry = await after(); assert.equal(entry.child_recovery_required, true); assert.equal(entry.nodes_completed, 3); assert.equal(entry.elapsed_ms, 5000); };
  for (const extra of [{ work_item_id: 'OTHER' }, { child_request_id: 'other' }, { activation_digest: 'stale' }, { host_config_digest: 'stale' },
    { recovery_reason: 'CLOSING_OVER_BUDGET' }, { recovery_reason: 'RECONCILE_FAILED' }]) { await install(flagged(extra)); await blocked(); }
  const lock = path.join(workspace, '.loop/orchestrator.lock'); await fs.mkdir(lock);
  try {
    await install(flagged()); await blocked(); await blocked();
    assert.equal((await after()).recovery_reason, 'WORKER_INTERRUPTED');
  } finally { await fs.rmdir(lock); }
  assert.equal((await supervisorRecover(root)).stopping, false, 'a released lock permits recovery after repeated refusals');
  assert.equal((await after()).child_recovery_required, false);
  const childFile = path.join(workspace, '.loop/control/jobs', `${cj.job_id}.json`); const original = await fs.readFile(childFile);
  try {
    for (const extra of [{ status: 'RUNNING', pid: process.pid, finished_at: null }, { status: 'INVALID' }, { finished_at: null }]) {
      await fs.writeFile(childFile, JSON.stringify({ ...cj, ...extra })); await install(flagged()); await blocked();
    }
    const originalLstat = fs.lstat;
    fs.lstat = async (file, ...args) => { if (file === lock) throw Object.assign(new Error('Cannot inspect lock'), { code: 'EACCES' }); return originalLstat(file, ...args); };
    try { await fs.writeFile(childFile, original); await install(flagged()); await blocked(); } finally { fs.lstat = originalLstat; }
  } finally { await fs.writeFile(childFile, original); }
  await install(flagged()); assert.equal((await supervisorRecover(root)).stopping, false);
  const cleared = await after(); assert.equal(cleared.child_recovery_required, false); assert.equal(cleared.status, 'PAUSED');
  assert.equal(cleared.nodes_completed, 3 + cj.nodes_completed); assert.equal(cleared.elapsed_ms, 5000);
  await supervisorRecover(root); assert.equal((await after()).nodes_completed, cleared.nodes_completed);
  await install(flagged({ nodes_completed: 12 })); assert.equal((await supervisorResume(root, { job_id: id })).blocked, true);
  assert.match((await after()).blocker, /^PACKAGE_NODE_BUDGET_EXHAUSTED/);
  assert.equal((await dispatch(workspace, 'status')).job.job_id, cj.job_id);
  await assert.rejects(() => reconcileInterruptedChild({ root: workspace }, flagged({ child_request_id: null })), e => e.code === 'CHILD_RECOVERY_REQUIRED');
});
