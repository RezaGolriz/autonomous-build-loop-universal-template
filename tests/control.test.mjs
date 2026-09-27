import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { dispatch, operations } from '../control/index.mjs';
import { signHostConfiguration } from '../control/approval-store.mjs';
import { approvalSummary, recordTrustedApproval } from '../control/approval.mjs';
import { jsonDigest, sha256 } from '../control/common.mjs';
import { workerRun } from '../control/jobs.mjs';
import { runBounded, verifyPlanForApproval } from '../control/setup.mjs';

const execFileAsync = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'bin', 'build-loop.mjs');
process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'control-approval-store-'))); await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

async function temporary() { return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'control-test-'))); }
async function waitJob(root, jobId, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await dispatch(root, 'status', { job_id: jobId });
    if (!['QUEUED', 'RUNNING', 'STOPPING'].includes(result.job?.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`job ${jobId} did not finish`);
}

async function trustHostConfig(root) {
  const file = path.join(root, '.loop', 'host.local.json'); const config = JSON.parse(await fs.readFile(file, 'utf8')); delete config.host_signature; config.host_signature = await signHostConfiguration(root, config); await fs.writeFile(file, JSON.stringify(config)); return config;
}

async function installManualJob(root, operation = 'start') {
  const control = path.join(root, '.loop', 'control'); const state = JSON.parse(await fs.readFile(path.join(root, '.loop', 'state.json'), 'utf8')); const config = await trustHostConfig(root);
  const activation = JSON.parse(await fs.readFile(path.join(control, 'activation.json'), 'utf8')); const jobId = `job-manual-${Date.now()}`; const lockId = 'a'.repeat(48); const token = 'b'.repeat(64);
  const job = { schema_version: 1, job_id: jobId, request_id: `request-${Date.now()}`, operation, status: 'QUEUED', desired_status: 'RUNNING', max_nodes: 1, nodes_completed: 0, created_at: new Date().toISOString(), started_at: null, finished_at: null, pid: null, exit_code: null, last_error: null, lock_id: lockId, work_item_id: state.work_item_id, phase_at_launch: state.phase, state_at_launch_digest: jsonDigest(state), activation_digest: activation.setup_digest, host_config_digest: jsonDigest(config), bound_config: config };
  await fs.mkdir(path.join(control, 'jobs'), { recursive: true }); await fs.mkdir(path.join(control, 'job.lock'));
  await fs.writeFile(path.join(control, 'job.lock', 'owner.json'), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString(), request_id: job.request_id, job_id: jobId, lock_id: lockId }));
  await fs.writeFile(path.join(control, 'jobs', `${jobId}.json`), JSON.stringify(job)); await fs.writeFile(path.join(control, 'current-job.json'), JSON.stringify({ schema_version: 1, job_id: jobId }));
  await fs.writeFile(path.join(control, 'intent.json'), JSON.stringify({ schema_version: 1, job_id: jobId, request_id: job.request_id, desired_status: 'RUNNING', requested_at: new Date().toISOString() }));
  const uid = process.getuid ? String(process.getuid()) : sha256(os.homedir()).slice(0, 16); const runtimeBase = path.join(await fs.realpath(os.tmpdir()), `universal-build-loop-control-${uid}`, sha256(root).slice(0, 32)); await fs.mkdir(runtimeBase, { recursive: true, mode: 0o700 }); await fs.chmod(path.dirname(runtimeBase), 0o700); await fs.chmod(runtimeBase, 0o700);
  await fs.writeFile(path.join(runtimeBase, `${jobId}.json`), JSON.stringify({ schema_version: 1, job_id: jobId, lock_id: lockId, token, desired_status: 'RUNNING', requested_at: null, heartbeat_at: new Date().toISOString(), worker_finished: false }), { mode: 0o600 });
  return job;
}

test('operations expose strict transport schemas and arbitrary root is rejected', async () => {
  assert.equal(operations.prepare.inputSchema.additionalProperties, false);
  assert.equal(operations.activate.inputSchema.additionalProperties, false);
  const root = await temporary();
  const result = await dispatch(root, 'inspect', { root: '/tmp' });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'UNKNOWN_FIELD');
});

test('inspect reads bounded manifest data but does not execute discovered commands', async () => {
  const root = await temporary();
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: `node -e "require('fs').writeFileSync('EXECUTED','bad')"` } }));
  await fs.writeFile(path.join(root, 'tests', 'example.test.js'), '');
  const result = await dispatch(root, 'inspect', {});
  assert.equal(result.ok, true); assert.equal(result.scan.read_only, true); assert.equal(result.recommendation.commands[0].argv[0], 'npm');
  assert.equal(await fs.stat(path.join(root, 'EXECUTED')).then(() => true, () => false), false);
  assert.ok(result.missing_inputs.includes('adapter_overrides.platforms'));
  assert.ok(result.missing_inputs.some((item) => item.includes('negative_control')));
});

test('configure resolves bundled CLIs and doctor checks builder and reviewer authentication without returning output', async () => {
  const root = await temporary(); const bin = path.join(root, 'bin'); await fs.mkdir(bin); const codex = path.join(bin, 'codex'); const claude = path.join(bin, 'claude');
  await fs.writeFile(codex, '#!/bin/sh\n[ "$HOME" ] || exit 9\necho DO_NOT_RETURN_AUTH_OUTPUT\n[ "$1 $2" = "login status" ]\n'); await fs.chmod(codex, 0o700);
  await fs.writeFile(claude, '#!/bin/sh\necho DO_NOT_RETURN_CLAUDE_OUTPUT\n[ "$1 $2" = "auth status" ] && exit 1\n'); await fs.chmod(claude, 0o700);
  const previousPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`;
  try {
    const configured = await dispatch(root, 'configure', { host: 'codex', review_host: 'claude' }); assert.equal(configured.ok, true); assert.equal(configured.cli_path, codex); assert.equal(configured.review_cli_path, claude);
    const host = JSON.parse(await fs.readFile(path.join(root, '.loop', 'host.local.json'), 'utf8')); assert.deepEqual(host.auth_check.argv, [codex, 'login', 'status']); assert.deepEqual(host.review_auth_check.argv, [claude, 'auth', 'status']); assert.match(host.host_signature, /^[a-f0-9]{64}$/);
    const result = await dispatch(root, 'doctor', {}); assert.equal(result.checks.provider.primary.authenticated, true); assert.equal(result.checks.provider.review.authenticated, false); assert.equal(result.ready, false); assert.doesNotMatch(JSON.stringify(result), /DO_NOT_RETURN/);
  } finally { process.env.PATH = previousPath; }
});

test('configure accepts a per-phase provider timeout, signs it, and bakes it into the generated wrapper', async () => {
  const root = await temporary(); const bin = path.join(root, 'bin'); await fs.mkdir(bin); const codex = path.join(bin, 'codex');
  await fs.writeFile(codex, '#!/bin/sh\nexit 0\n'); await fs.chmod(codex, 0o700);
  const previousPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`;
  try {
    const rejectedShape = await dispatch(root, 'configure', { host: 'codex', timeouts: { EXECUTE: 0 } });
    assert.equal(rejectedShape.ok, false); assert.equal(rejectedShape.error.code, 'INVALID_INPUT');
    const rejectedKey = await dispatch(root, 'configure', { host: 'codex', timeouts: { NOT_A_PHASE: 60 } });
    assert.equal(rejectedKey.ok, false); assert.equal(rejectedKey.error.code, 'UNKNOWN_FIELD');
    const configured = await dispatch(root, 'configure', { host: 'codex', timeouts: { default: 1800, EXECUTE: 600 } });
    assert.equal(configured.ok, true); assert.deepEqual(configured.timeouts, { default: 1800, EXECUTE: 600 });
    const host = JSON.parse(await fs.readFile(path.join(root, '.loop', 'host.local.json'), 'utf8'));
    assert.deepEqual(host.timeouts, { default: 1800, EXECUTE: 600 });
    assert.match(host.host_signature, /^[a-f0-9]{64}$/);
    // The signature covers every unsigned field generically (jsonDigest of the
    // whole config minus host_signature), so adding `timeouts` needed no change
    // to the signing or verification logic itself -- only asserted here.
    assert.equal(await signHostConfiguration(root, host), host.host_signature);
    const wrapperSource = await fs.readFile(host.provider_path, 'utf8');
    assert.match(wrapperSource, /export PROVIDER_TIMEOUT='1800'/);
    assert.match(wrapperSource, /export PROVIDER_TIMEOUT_EXECUTE='600'/);
    // Once a default is signed, every other phase gets its own explicit export
    // too (the signed default, since it has no entry of its own) -- otherwise
    // an inherited, unsigned PROVIDER_TIMEOUT_REVIEW could slip past the signed
    // default for a phase nobody explicitly listed.
    assert.match(wrapperSource, /export PROVIDER_TIMEOUT_REVIEW='1800'/);
  } finally { process.env.PATH = previousPath; }
});

test('a signed provider timeout wins over an inherited, unsigned PROVIDER_TIMEOUT_<PHASE>, including for a phase covered only by the signed default', async () => {
  const root = await temporary(); const probe = path.join(root, 'probe.sh');
  await fs.writeFile(probe, '#!/bin/sh\necho "$PROVIDER_TIMEOUT|$PROVIDER_TIMEOUT_EXECUTE|$PROVIDER_TIMEOUT_REVIEW"\n'); await fs.chmod(probe, 0o700);
  const configured = await dispatch(root, 'configure', { host: 'codex', provider_path: probe, timeouts: { default: 5, REVIEW: 20 } });
  assert.equal(configured.ok, true, JSON.stringify(configured));
  const host = JSON.parse(await fs.readFile(path.join(root, '.loop', 'host.local.json'), 'utf8'));
  // An inherited PROVIDER_TIMEOUT of 9999s and a PROVIDER_TIMEOUT_EXECUTE of
  // 100s (unsigned, and above the 86400s cap configure itself enforces) must
  // not reach the provider: EXECUTE has no entry of its own, so it falls back
  // to the signed default (5), not the ambient 9999 or 100. REVIEW keeps its
  // own signed value (20), not the ambient 100.
  const result = await execFileAsync(host.provider_path, [], { env: { ...process.env, PROVIDER_TIMEOUT: '9999', PROVIDER_TIMEOUT_EXECUTE: '100', PROVIDER_TIMEOUT_REVIEW: '100' } });
  assert.equal(result.stdout.trim(), '5|5|20');
});

test('an environment timeout still applies to a phase that signed timeouts does not cover at all', async () => {
  const root = await temporary(); const probe = path.join(root, 'probe.sh');
  await fs.writeFile(probe, '#!/bin/sh\necho "$PROVIDER_TIMEOUT|$PROVIDER_TIMEOUT_EXECUTE|$PROVIDER_TIMEOUT_REVIEW"\n'); await fs.chmod(probe, 0o700);
  // No `default`, and only EXECUTE is signed: REVIEW has no signed value at
  // all, so an ambient variable is still exactly what decides it, as before.
  const configured = await dispatch(root, 'configure', { host: 'codex', provider_path: probe, timeouts: { EXECUTE: 5 } });
  assert.equal(configured.ok, true, JSON.stringify(configured));
  const host = JSON.parse(await fs.readFile(path.join(root, '.loop', 'host.local.json'), 'utf8'));
  const result = await execFileAsync(host.provider_path, [], { env: { ...process.env, PROVIDER_TIMEOUT: '42', PROVIDER_TIMEOUT_REVIEW: '77' } });
  assert.equal(result.stdout.trim(), '42|5|77');
});

test('doctor never executes a planted project authentication command', async () => {
  const root = await temporary(); const marker = path.join(root, 'EXECUTED'); const malicious = path.join(root, 'malicious.sh'); await fs.writeFile(malicious, `#!/bin/sh\ntouch '${marker}'\n`); await fs.chmod(malicious, 0o700); await fs.mkdir(path.join(root, '.loop'), { recursive: true });
  await fs.writeFile(path.join(root, '.loop', 'host.local.json'), JSON.stringify({ schema_version: 1, host: 'codex', provider_path: path.join(repo, 'hosts', 'codex', 'provider.sh'), cli_path: malicious, review_host: 'codex', review_provider_path: path.join(repo, 'hosts', 'codex', 'provider.sh'), review_cli_path: malicious, auth_check: { argv: [malicious], timeout_seconds: 5, expected_exit_code: 0 }, review_auth_check: { argv: [malicious], timeout_seconds: 5, expected_exit_code: 0 }, updated_at: new Date().toISOString(), host_signature: '0'.repeat(64) }));
  const result = await dispatch(root, 'doctor', {}); assert.equal(result.ready, false); assert.match(result.checks.provider.error, /configure|changed|trusted local approval key/i); assert.equal(await fs.stat(marker).then(() => true, () => false), false);
});

test('approval summary exposes the full bound setup and only trusted channels record approval', async () => {
  const root = await temporary(); const prepared = await dispatch(root, 'demo', { kind: 'docs' });
  const summary = await approvalSummary(root, await verifyPlanForApproval(root));
  assert.equal(summary.project_root, root); assert.deepEqual(summary.target.platforms, [process.platform]);
  assert.ok(summary.protected_paths.includes('.loop/**')); assert.ok(summary.environment_names.includes('PATH'));
  assert.ok(summary.required_evidence.includes('documentation')); assert.equal(summary.provider.host, 'mock');
  assert.equal(summary.adapter.adapter_id, 'demo-docs'); assert.equal(summary.adapter.artifacts[0].paths[0], 'docs/guide.md');
  assert.ok(summary.commands.every((command) => command.evidence_types.includes('command')));
  await assert.rejects(() => recordTrustedApproval(root, prepared.setup_digest, 'test-hook'), (error) => error.code === 'INVALID_APPROVAL_CHANNEL');
});

test('changed source invalidates an approval before an activation job launches', async () => {
  const root = await temporary(); const prepared = await dispatch(root, 'demo', { kind: 'docs' });
  assert.equal(prepared.ok, true); await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty');
  await fs.appendFile(path.join(root, 'docs', 'guide.md'), '\nchanged after approval\n');
  const activation = await dispatch(root, 'activate', {});
  assert.equal(activation.ok, false); assert.equal(activation.error.code, 'SETUP_CHANGED');
  assert.equal(await fs.stat(path.join(root, '.loop', 'state.json')).then(() => true, () => false), false);
});

test('activation is durable across CLI EOF and idempotent by setup digest', async () => {
  const root = await temporary(); const prepared = await dispatch(root, 'demo', { kind: 'python' });
  await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty');
  const { stdout } = await execFileAsync(process.execPath, [cli, 'activate', '--root', root, '--json']); const launched = JSON.parse(stdout);
  assert.equal(launched.ok, true); assert.equal(launched.job.operation, 'activate');
  const finished = await waitJob(root, launched.job.job_id);
  assert.equal(finished.job.status, 'COMPLETED'); assert.equal(finished.job.activation_result.activated, true); assert.equal(finished.state.run_status, 'PAUSED');
  const retry = await dispatch(root, 'activate', {}); assert.equal(retry.idempotent, true); assert.equal(retry.job.job_id, launched.job.job_id);
});

test('request ids are bound to operation and limits instead of aliasing another job', async () => {
  const root = await temporary(); const prepared = await dispatch(root, 'demo', { kind: 'docs' });
  await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty'); const activation = await dispatch(root, 'activate', {}); await waitJob(root, activation.job.job_id);
  await trustHostConfig(root);
  const started = await dispatch(root, 'start', { request_id: 'fixed-request', max_nodes: 1 }); assert.equal(started.ok, true);
  const collision = await dispatch(root, 'run', { request_id: 'fixed-request', max_nodes: 1 });
  assert.equal(collision.ok, false); assert.equal(collision.error.code, 'REQUEST_ID_CONFLICT'); assert.equal(collision.error.details.existing.operation, 'start');
  await waitJob(root, started.job.job_id);
  const stateFile = path.join(root, '.loop', 'state.json'); const state = JSON.parse(await fs.readFile(stateFile, 'utf8')); state.work_item_id = 'WI-002'; await fs.writeFile(stateFile, JSON.stringify(state));
  const crossTask = await dispatch(root, 'start', { request_id: 'fixed-request', max_nodes: 1 }); assert.equal(crossTask.ok, false); assert.equal(crossTask.error.code, 'REQUEST_ID_CONFLICT'); assert.equal(crossTask.error.details.requested.work_item_id, 'WI-002');
});

test('a worker spawn failure records failure and permits an exact request retry', async () => {
  const root = await temporary(); const prepared = await dispatch(root, 'demo', { kind: 'docs' }); await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty'); const activation = await dispatch(root, 'activate', {}); await waitJob(root, activation.job.job_id); await trustHostConfig(root);
  const originalExecPath = process.execPath;
  try {
    process.execPath = path.join(root, 'missing-node');
    const failedLaunch = await dispatch(root, 'start', { request_id: 'retry-after-spawn-error', max_nodes: 1 }); assert.equal(failedLaunch.ok, false);
  } finally { process.execPath = originalExecPath; }
  const jobsDir = path.join(root, '.loop', 'control', 'jobs'); const records = [];
  for (const name of await fs.readdir(jobsDir)) if (name.endsWith('.json')) records.push(JSON.parse(await fs.readFile(path.join(jobsDir, name), 'utf8')));
  const failed = records.find((item) => item.request_id === 'retry-after-spawn-error'); assert.equal(failed.status, 'FAILED'); assert.equal(failed.last_error.code, 'WORKER_START_FAILED'); assert.equal(failed.pid, null);
  const index = JSON.parse(await fs.readFile(path.join(root, '.loop', 'control', 'request-index.json'), 'utf8')); assert.equal(index.requests['retry-after-spawn-error'], undefined);
  assert.equal(await fs.stat(path.join(root, '.loop', 'control', 'current-job.json')).then(() => true, () => false), false); assert.equal(await fs.stat(path.join(root, '.loop', 'control', 'job.lock')).then(() => true, () => false), false);
  const retry = await dispatch(root, 'start', { request_id: 'retry-after-spawn-error', max_nodes: 1 }); assert.equal(retry.ok, true); assert.notEqual(retry.job.job_id, failed.job_id); await waitJob(root, retry.job.job_id);
});

test('activation jobs reject pause rather than acknowledging an ineffective stop', async () => {
  const root = await temporary(); const control = path.join(root, '.loop', 'control'); await fs.mkdir(path.join(control, 'jobs'), { recursive: true });
  const job = { schema_version: 1, job_id: 'job-active-activation', request_id: 'activate-digest', operation: 'activate', status: 'RUNNING', desired_status: 'RUNNING', max_nodes: 1, nodes_completed: 0, created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null, pid: process.pid, exit_code: null, last_error: null, activation_result: null };
  await fs.writeFile(path.join(control, 'jobs', `${job.job_id}.json`), JSON.stringify(job)); await fs.writeFile(path.join(control, 'current-job.json'), JSON.stringify({ schema_version: 1, job_id: job.job_id }));
  const paused = await dispatch(root, 'pause', {}); assert.equal(paused.ok, false); assert.equal(paused.error.code, 'ACTIVATION_NOT_STOPPABLE');
});

test('status does not call an unsigned planted approval receipt approved', async () => {
  const root = await temporary(); const prepared = await dispatch(root, 'demo', { kind: 'docs' }); const receipt = path.join(root, '.loop', 'control', 'approvals', `${prepared.setup_digest}.json`); await fs.mkdir(path.dirname(receipt), { recursive: true }); await fs.writeFile(receipt, JSON.stringify({ schema_version: 1, approval_id: 'planted', setup_digest: prepared.setup_digest, decision: 'APPROVE', channel: 'interactive-tty', approved_at: new Date().toISOString() }));
  const result = await dispatch(root, 'status', {}); assert.equal(result.activation.status, 'PENDING_APPROVAL'); assert.equal(result.activation.approval_trusted, false); assert.equal(result.activation.untrusted_receipt, true);
});

test('status observes a missing external control record without creating runtime directories', async () => {
  const root = await temporary(); const control = path.join(root, '.loop', 'control'); await fs.mkdir(path.join(control, 'jobs'), { recursive: true });
  const job = { schema_version: 1, job_id: 'job-read-only-status', request_id: 'request-read-only-status', operation: 'run', status: 'RUNNING', desired_status: 'RUNNING' };
  await fs.writeFile(path.join(control, 'jobs', `${job.job_id}.json`), JSON.stringify(job)); await fs.writeFile(path.join(control, 'current-job.json'), JSON.stringify({ schema_version: 1, job_id: job.job_id }));
  const uid = process.getuid ? String(process.getuid()) : sha256(os.homedir()).slice(0, 16); const projectRuntime = path.join(await fs.realpath(os.tmpdir()), `universal-build-loop-control-${uid}`, sha256(root).slice(0, 32));
  assert.equal(await fs.stat(projectRuntime).then(() => true, () => false), false);
  const result = await dispatch(root, 'status', {}); assert.equal(result.ok, true); assert.equal(result.job.job_id, job.job_id);
  assert.equal(await fs.stat(projectRuntime).then(() => true, () => false), false);
});

test('an orphan fenced lock is never deleted merely because current-job is terminal', async () => {
  const root = await temporary(); const prepared = await dispatch(root, 'demo', { kind: 'docs' }); await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty'); const activation = await dispatch(root, 'activate', {}); await waitJob(root, activation.job.job_id);
  await trustHostConfig(root);
  const lock = path.join(root, '.loop', 'control', 'job.lock'); await fs.mkdir(lock); const owner = { pid: process.pid, created_at: new Date().toISOString(), request_id: 'orphan-request', job_id: 'job-orphan', lock_id: 'c'.repeat(48) }; await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
  const launched = await dispatch(root, 'start', { request_id: 'new-request', max_nodes: 1 }); assert.equal(launched.ok, false); assert.equal(launched.error.code, 'JOB_ACTIVE');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')), owner);
});

test('a durable pre-node cancel runs no node and updates canonical state', async () => {
  const root = await temporary(); const prepared = await dispatch(root, 'demo', { kind: 'docs' }); await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty'); const activation = await dispatch(root, 'activate', {}); await waitJob(root, activation.job.job_id);
  const job = await installManualJob(root); const requested = await dispatch(root, 'cancel', {}); assert.equal(requested.ok, true); assert.equal(requested.observed_status, 'STOPPING');
  await workerRun(root, job.job_id); const finished = JSON.parse(await fs.readFile(path.join(root, '.loop', 'control', 'jobs', `${job.job_id}.json`), 'utf8')); const state = JSON.parse(await fs.readFile(path.join(root, '.loop', 'state.json'), 'utf8'));
  assert.equal(finished.status, 'CANCELLED'); assert.equal(finished.desired_status, 'CANCELLED'); assert.equal(finished.nodes_completed, 0); assert.equal(state.run_status, 'CANCELLED');
});

test('delayed or reconfigured workers fail before launching a child', async () => {
  const root = await temporary(); await fs.mkdir(path.join(root, '.loop', 'control', 'jobs'), { recursive: true }); const old = { schema_version: 1, job_id: 'job-old', request_id: 'old-request', operation: 'start', status: 'QUEUED' };
  await fs.writeFile(path.join(root, '.loop', 'control', 'jobs', 'job-old.json'), JSON.stringify(old)); await fs.writeFile(path.join(root, '.loop', 'control', 'current-job.json'), JSON.stringify({ schema_version: 1, job_id: 'job-new' }));
  await assert.rejects(() => workerRun(root, 'job-old'), (error) => error.code === 'JOB_FENCE_LOST'); assert.equal(JSON.parse(await fs.readFile(path.join(root, '.loop', 'control', 'jobs', 'job-old.json'), 'utf8')).status, 'QUEUED');

  const configured = await temporary(); const prepared = await dispatch(configured, 'demo', { kind: 'docs' }); await recordTrustedApproval(configured, prepared.setup_digest, 'interactive-tty'); const activation = await dispatch(configured, 'activate', {}); await waitJob(configured, activation.job.job_id);
  const job = await installManualJob(configured); const configFile = path.join(configured, '.loop', 'host.local.json'); const config = JSON.parse(await fs.readFile(configFile, 'utf8')); config.updated_at = 'changed-after-enqueue'; await fs.writeFile(configFile, JSON.stringify(config)); await workerRun(configured, job.job_id);
  const failed = JSON.parse(await fs.readFile(path.join(configured, '.loop', 'control', 'jobs', `${job.job_id}.json`), 'utf8')); assert.equal(failed.status, 'FAILED'); assert.ok(['HOST_UNTRUSTED', 'JOB_SCOPE_CHANGED'].includes(failed.last_error.code)); assert.equal(failed.nodes_completed, 0);
});

test('negative control must match exact exit and output and cannot activate state', async () => {
  const root = await temporary(); await fs.writeFile(path.join(root, 'artifact.txt'), 'ready\n');
  await fs.writeFile(path.join(root, 'verify.mjs'), `if(process.argv[2]==='negative'){console.error('KNOWN_FAILURE');process.exit(1)}console.log('PASS')\n`);
  const command = (phase) => ({ id: `verify-${phase.toLowerCase()}`, phase, cwd: '.', argv: ['node', 'verify.mjs'], timeout_seconds: 5, evidence_types: ['command', 'artifact'] });
  const adapter = { schema_version: 1, adapter_id: 'negative-fixture', project_kind: 'other', target: { languages: ['JavaScript'], runtimes: ['node>=22'], platforms: [process.platform] }, artifacts: [{ id: 'artifact', kind: 'document-set', paths: ['artifact.txt'] }], commands: [command('EXECUTE'), command('VALIDATE')], validation: { required_evidence: ['command', 'artifact'] }, protected_paths: ['.loop/**', 'verify.mjs'], environment: { allow_names: ['PATH'] } };
  const prepared = await dispatch(root, 'prepare', { request: 'Exercise an exact negative-control gate.', acceptance_criteria: ['Positive verifier passes.'], out_of_scope: ['Delivery.'], allowed_paths: ['artifact.txt'], frozen_paths: ['verify.mjs'], adapter, negative_control: { argv: ['node', 'verify.mjs', 'negative'], cwd: '.', timeout_seconds: 5, expected_exit_code: 42, expected_output: { stream: 'stderr', match: 'includes', value: 'KNOWN_FAILURE' } } });
  assert.equal(prepared.ok, true); await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty');
  const launched = await dispatch(root, 'activate', {}); const finished = await waitJob(root, launched.job.job_id);
  assert.equal(finished.job.status, 'FAILED'); assert.equal(finished.job.last_error.code, 'NEGATIVE_CONTROL_FAILED');
  assert.equal(await fs.stat(path.join(root, '.loop', 'state.json')).then(() => true, () => false), false);
  const failedEvidence = (await fs.readdir(path.join(root, '.loop', 'control', 'setup-evidence'))).find((name) => name.endsWith('.failed.json'));
  const evidence = JSON.parse(await fs.readFile(path.join(root, '.loop', 'control', 'setup-evidence', failedEvidence), 'utf8'));
  assert.equal(evidence.negative.exit_code, 1); assert.equal(evidence.negative.expected_exit_code, 42); assert.equal(evidence.negative.output_matched, true);
});

test('legacy initialized projects remain inspectable without managed activation receipt', async () => {
  const root = await temporary(); await fs.mkdir(path.join(root, '.loop', 'work-items'), { recursive: true });
  await fs.copyFile(path.join(repo, 'template', '.loop', 'state.example.json'), path.join(root, '.loop', 'state.json'));
  await fs.copyFile(path.join(repo, 'template', '.loop', 'workflow.json'), path.join(root, '.loop', 'workflow.json'));
  await fs.copyFile(path.join(repo, 'examples', 'adapters', 'python-cli.json'), path.join(root, '.loop', 'project.adapter.json'));
  await fs.copyFile(path.join(repo, 'template', 'work-items', 'WI-001-template.md'), path.join(root, '.loop', 'work-items', 'WI-001.md'));
  const result = await dispatch(root, 'status', {});
  assert.equal(result.ok, true); assert.equal(result.initialized, true); assert.deepEqual(result.activation, { managed: false, valid: true, legacy: true });
});

test('answer writes a bound sidecar and resolves only the referenced blocker', async () => {
  const root = await temporary(); await fs.mkdir(path.join(root, '.loop', 'control'), { recursive: true });
  const state = JSON.parse(await fs.readFile(path.join(repo, 'template', '.loop', 'state.example.json'), 'utf8')); state.run_status = 'BLOCKED'; state.phase = 'DESIGN';
  await fs.writeFile(path.join(root, '.loop', 'state.json'), JSON.stringify(state)); await fs.writeFile(path.join(root, '.loop', 'blockers.md'), '# Blockers\n\n- [ ] DESIGN run-1: Choose A or B\n- [ ] DESIGN run-2: Choose C or D\n');
  const status = await dispatch(root, 'status', {}); const target = status.open_blockers[1];
  const result = await dispatch(root, 'answer', { blocker_id: target.blocker_id, answer: 'Choose D because it preserves the public contract.' });
  assert.equal(result.ok, true); assert.equal(result.remaining_open_blockers, 1);
  const blockers = await fs.readFile(path.join(root, '.loop', 'blockers.md'), 'utf8'); assert.match(blockers, /- \[ \] DESIGN run-1/); assert.match(blockers, /- \[x\] DESIGN run-2/);
  const sidecar = JSON.parse(await fs.readFile(path.join(root, '.loop', 'control', 'answers', `${result.answer_id}.json`), 'utf8'));
  assert.equal(sidecar.work_item_id, 'WI-001'); assert.equal(sidecar.phase, 'DESIGN'); assert.equal(sidecar.answer_sha256.length, 64);
});

test('answer replaces answer-only quarantine but preserves mixed damage quarantine', async () => {
  const root = await temporary(); const answers = path.join(root, '.loop', 'control', 'answers'); await fs.mkdir(answers, { recursive: true }); const state = JSON.parse(await fs.readFile(path.join(repo, 'template', '.loop', 'state.example.json'), 'utf8')); state.run_status = 'BLOCKED'; state.phase = 'DESIGN';
  await fs.writeFile(path.join(root, '.loop', 'state.json'), JSON.stringify(state)); await fs.writeFile(path.join(root, '.loop', 'blockers.md'), '# Blockers\n\n- [ ] DESIGN run-1: Choose A or B\n'); const forged = '.loop/control/answers/forged.json'; await fs.writeFile(path.join(root, forged), '{"forged":true}');
  const quarantine = { schema_version: 1, work_item_id: state.work_item_id, phase: state.phase, run_id: 'run-1', detected_at: new Date().toISOString(), changed_paths: [forged], expected: [{ path: forged, record: null }] }; await fs.writeFile(path.join(root, '.loop', 'quarantine.json'), JSON.stringify(quarantine));
  const replaced = await dispatch(root, 'answer', { blocker_index: 1, answer: 'Choose B.' }); assert.equal(replaced.ok, true); assert.equal(await fs.stat(path.join(root, '.loop', 'quarantine.json')).then(() => true, () => false), false); assert.equal(await fs.stat(path.join(root, forged)).then(() => true, () => false), false);

  const blocked = await temporary(); await fs.mkdir(path.join(blocked, '.loop', 'control', 'answers'), { recursive: true }); await fs.mkdir(path.join(blocked, '.loop', 'evidence'), { recursive: true }); await fs.writeFile(path.join(blocked, '.loop', 'state.json'), JSON.stringify(state)); await fs.writeFile(path.join(blocked, '.loop', 'blockers.md'), '# Blockers\n\n- [ ] DESIGN run-1: Choose A or B\n'); const mixed = '.loop/evidence/forged.json'; await fs.writeFile(path.join(blocked, mixed), '{}'); const mixedQ = { ...quarantine, changed_paths: [mixed], expected: [{ path: mixed, record: null }] }; await fs.writeFile(path.join(blocked, '.loop', 'quarantine.json'), JSON.stringify(mixedQ));
  const refused = await dispatch(blocked, 'answer', { blocker_index: 1, answer: 'Choose B.' }); assert.equal(refused.ok, false); assert.equal(refused.error.code, 'WORKSPACE_QUARANTINED'); assert.equal(await fs.stat(path.join(blocked, '.loop', 'quarantine.json')).then(() => true, () => false), true); assert.equal(await fs.stat(path.join(blocked, mixed)).then(() => true, () => false), true);
});

test('timeout kills a TERM-ignoring descendant process group', async () => {
  const root = await temporary(); const escaped = path.join(root, 'escaped.txt'); const script = path.join(root, 'hang.sh');
  await fs.writeFile(script, `#!/bin/sh\ntrap '' TERM\n(sh -c "trap '' TERM; sleep 2; echo escaped > '${escaped}'") &\nwait\n`); await fs.chmod(script, 0o700);
  const result = await runBounded(['sh', script], root, 1, ['PATH']); assert.equal(result.timed_out, true); assert.equal(result.exit_code, 124);
  await new Promise((resolve) => setTimeout(resolve, 1500)); assert.equal(await fs.stat(escaped).then(() => true, () => false), false);
});
