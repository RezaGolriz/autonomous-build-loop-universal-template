import { spawn } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signHostConfiguration, verifyApproval, verifyHostConfiguration } from './approval-store.mjs';
import {
  ControlError, acquireDirLock, assertControlPath, assertNoEngineLock, atomicJson, atomicText, exactKeys,
  effectivePath, ensureRuntimeIgnore, exists, jsonDigest, nonce, now, readJson, safeRelativeArray, sha256, stringArray, stringValue,
} from './common.mjs';
import { activateProject, bundleRoot, distributionHashes, runBounded, verifyPlanForApproval } from './setup.mjs';

const orchestrator = path.join(bundleRoot, 'engine', 'orchestrator.sh');
const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
const authEnvironment = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME'];

async function executable(file) { try { await fs.access(file, constants.X_OK); return true; } catch { return false; } }
async function commandPath(command, envPath = effectivePath()) {
  if (command.includes('/')) return path.isAbsolute(command) && await executable(command) ? command : null;
  const home = os.homedir();
  const directories = [...new Set([...envPath.split(path.delimiter), path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.npm-global', 'bin'), '/Applications/Codex.app/Contents/Resources', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean))];
  for (const dir of directories) { const candidate = path.join(dir, command); if (await executable(candidate)) return candidate; }
  return null;
}

function builtInAuthCheck(host, cliPath, trustedBundledProvider) {
  if (!trustedBundledProvider || !cliPath) return null;
  if (host === 'codex') return { argv: [cliPath, 'login', 'status'], timeout_seconds: 15, expected_exit_code: 0 };
  if (host === 'claude') return { argv: [cliPath, 'auth', 'status'], timeout_seconds: 15, expected_exit_code: 0 };
  return null;
}

async function authenticationState(root, host, installed, check, trusted) {
  if (host === 'mock') return true;
  if (!installed || !check || !trusted) return 'unknown';
  try { const result = await runBounded(check.argv, root, check.timeout_seconds, authEnvironment); return result.exit_code === check.expected_exit_code; }
  catch { return false; }
}

async function wrapProvider(control, role, host, providerPath, cliPath, enabled) {
  if (!enabled || host === 'mock' || !cliPath) return providerPath;
  const wrapper = path.join(control, 'providers', `${role}-${host}.sh`); const variable = host === 'claude' ? 'CLAUDE_BIN' : 'CODEX_BIN';
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await atomicText(wrapper, `#!/bin/sh\nexport ${variable}=${shellQuote(cliPath)}\nexec ${shellQuote(providerPath)}\n`, 0o700); await fs.chmod(wrapper, 0o700);
  return wrapper;
}

export async function configureHost(root, args) {
  const { loop, control } = await assertControlPath(root);
  await fs.mkdir(loop, { recursive: true });
  await ensureRuntimeIgnore(root);
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'configure-host' });
  try {
    if (await exists(path.join(control, 'job.lock'))) throw new ControlError('JOB_ACTIVE', 'provider configuration cannot change while a managed job owns the project');
    return await configureHostUnlocked(root, args, loop, control);
  } finally { await release(); }
}

async function configureHostUnlocked(root, args, loop, control) {
  exactKeys(args, ['host', 'provider_path', 'cli_path', 'review_host', 'review_provider_path', 'review_cli_path'], ['host'], 'args');
  if (!['codex', 'claude', 'mock'].includes(args.host)) throw new ControlError('INVALID_INPUT', 'host must be codex, claude, or mock');
  if (args.provider_path && !path.isAbsolute(args.provider_path)) throw new ControlError('INVALID_INPUT', 'provider_path must be absolute');
  if (args.cli_path && !path.isAbsolute(args.cli_path)) throw new ControlError('INVALID_INPUT', 'cli_path must be absolute');
  if (args.review_host && !['codex', 'claude', 'mock'].includes(args.review_host)) throw new ControlError('INVALID_INPUT', 'review_host is invalid');
  if (args.review_provider_path && !path.isAbsolute(args.review_provider_path)) throw new ControlError('INVALID_INPUT', 'review_provider_path must be absolute');
  if (args.review_cli_path && !path.isAbsolute(args.review_cli_path)) throw new ControlError('INVALID_INPUT', 'review_cli_path must be absolute');
  const reviewHost = args.review_host || args.host;
  const bundledProviderPath = path.join(bundleRoot, 'hosts', args.host, 'provider.sh'); const trustedBundledProvider = !args.provider_path || args.provider_path === bundledProviderPath;
  const bundledReviewProviderPath = path.join(bundleRoot, 'hosts', reviewHost, 'provider.sh'); const trustedBundledReviewProvider = !args.review_provider_path || args.review_provider_path === bundledReviewProviderPath;
  const rawProviderPath = args.provider_path || bundledProviderPath; const rawReviewProviderPath = args.review_provider_path || bundledReviewProviderPath;
  const cliPath = args.host === 'mock' ? null : (args.cli_path || (trustedBundledProvider ? await commandPath(args.host) : null));
  const reviewCliPath = reviewHost === 'mock' ? null : (args.review_cli_path || (trustedBundledReviewProvider ? (reviewHost === args.host && cliPath ? cliPath : await commandPath(reviewHost)) : null));
  const providerPath = await wrapProvider(control, 'primary', args.host, rawProviderPath, cliPath, Boolean(args.cli_path));
  const reviewProviderPath = await wrapProvider(control, 'review', reviewHost, rawReviewProviderPath, reviewCliPath, Boolean(args.review_cli_path));
  const authCheck = builtInAuthCheck(args.host, cliPath, trustedBundledProvider && !args.cli_path);
  const reviewAuthCheck = builtInAuthCheck(reviewHost, reviewCliPath, trustedBundledReviewProvider && !args.review_cli_path);
  const config = { schema_version: 1, host: args.host, provider_path: providerPath, cli_path: cliPath, review_host: reviewHost, review_provider_path: reviewProviderPath, review_cli_path: reviewCliPath, auth_check: authCheck, review_auth_check: reviewAuthCheck, updated_at: now() };
  config.host_signature = await signHostConfiguration(root, config);
  await atomicJson(path.join(loop, 'host.local.json'), config);
  return { ok: true, configured: true, host: config.host, provider_path: config.provider_path, cli_path: config.cli_path, review_host: config.review_host, review_provider_path: config.review_provider_path, review_cli_path: config.review_cli_path, auth_check_configured: Boolean(config.auth_check), review_auth_check_configured: Boolean(config.review_auth_check) };
}

export async function doctor(root) {
  const { loop, control } = await assertControlPath(root); const checks = {};
  checks.node = { installed: Number(process.versions.node.split('.')[0]) >= 22, version: process.versions.node };
  checks.jq = { installed: Boolean(await commandPath('jq')) }; checks.git = { installed: Boolean(await commandPath('git')) };
  checks.bash = { installed: Boolean(await commandPath('bash')) }; checks.perl = { installed: Boolean(await commandPath('perl')) }; checks.shasum = { installed: Boolean(await commandPath('shasum')) };
  checks.orchestrator = { installed: await executable(orchestrator) };
  for (const [name, file] of [['active_adapter', path.join(loop, 'project.adapter.json')], ['candidate_adapter', path.join(loop, 'candidate', 'project.adapter.json')], ['state', path.join(loop, 'state.json')]]) checks[name] = { present: await exists(file) };
  const configFile = path.join(loop, 'host.local.json');
  if (!await exists(configFile)) checks.provider = { configured: false, installed: false, authenticated: 'unknown' };
  else {
    try {
      const config = await readJson(configFile, 'host.local.json');
      await verifyHostConfiguration(root, config);
      const primaryWrapperInstalled = await executable(config.provider_path); const reviewWrapperInstalled = await executable(config.review_provider_path);
      const primaryCli = config.host === 'mock' ? config.provider_path : (config.cli_path || config.host);
      const reviewCli = config.review_host === 'mock' ? config.review_provider_path : (config.review_cli_path || config.review_host);
      const primaryCliPath = await commandPath(primaryCli); const reviewCliPath = await commandPath(reviewCli);
      const primaryInstalled = primaryWrapperInstalled && Boolean(primaryCliPath); const reviewInstalled = reviewWrapperInstalled && Boolean(reviewCliPath);
      const safePrimaryCheck = builtInAuthCheck(config.host, primaryCliPath, config.provider_path === path.join(bundleRoot, 'hosts', config.host, 'provider.sh') && config.cli_path === primaryCliPath);
      const safeReviewCheck = builtInAuthCheck(config.review_host, reviewCliPath, config.review_provider_path === path.join(bundleRoot, 'hosts', config.review_host, 'provider.sh') && config.review_cli_path === reviewCliPath);
      const primaryCheckTrusted = Boolean(safePrimaryCheck && jsonDigest(safePrimaryCheck) === jsonDigest(config.auth_check)); const reviewCheckTrusted = Boolean(safeReviewCheck && jsonDigest(safeReviewCheck) === jsonDigest(config.review_auth_check));
      const primaryAuthenticated = await authenticationState(root, config.host, primaryInstalled, safePrimaryCheck, primaryCheckTrusted);
      const reviewAuthenticated = await authenticationState(root, config.review_host, reviewInstalled, safeReviewCheck, reviewCheckTrusted);
      const authenticated = primaryAuthenticated === false || reviewAuthenticated === false ? false : (primaryAuthenticated === true && reviewAuthenticated === true ? true : 'unknown');
      checks.provider = {
        configured: true,
        installed: primaryInstalled && reviewInstalled,
        authenticated,
        primary: { host: config.host, provider_installed: primaryWrapperInstalled, cli_installed: Boolean(primaryCliPath), cli_path: primaryCliPath, authenticated: primaryAuthenticated, auth_check_configured: primaryCheckTrusted },
        review: { host: config.review_host, provider_installed: reviewWrapperInstalled, cli_installed: Boolean(reviewCliPath), cli_path: reviewCliPath, authenticated: reviewAuthenticated, auth_check_configured: reviewCheckTrusted },
      };
    } catch (error) { checks.provider = { configured: true, installed: false, authenticated: 'unknown', error: error.message }; }
  }
  checks.locks = { engine: await exists(path.join(loop, 'engine.lock')), orchestrator: await exists(path.join(loop, 'orchestrator.lock')), job: await exists(path.join(control, 'job.lock')) };
  checks.symlinks = { loop_safe: true };
  const ready = checks.node.installed && checks.jq.installed && checks.git.installed && checks.bash.installed && checks.perl.installed && checks.shasum.installed && checks.orchestrator.installed && checks.provider.configured && checks.provider.installed && checks.provider.authenticated === true;
  const limitations = checks.provider.authenticated === 'unknown' ? ['Provider executable is installed, but builder or reviewer authentication is unverified. Bundled Codex and Claude providers receive safe default status checks. Custom providers report authentication as unknown; project-owned authentication commands are never executed by doctor.'] : [];
  return { ok: true, ready, checks, limitations, distinction: 'builder and reviewer installation and authentication are checked separately; command output and credentials are never returned' };
}

export async function verifyActivationBinding(root) {
  const { loop, control } = await assertControlPath(root); const file = path.join(control, 'activation.json');
  if (!await exists(file)) return { managed: false, valid: true, legacy: true };
  const activation = await readJson(file, 'activation receipt');
  const adapterBytes = await fs.readFile(path.join(loop, 'project.adapter.json')); const workflowBytes = await fs.readFile(path.join(loop, 'workflow.json'));
  if (sha256(adapterBytes) !== activation.adapter_file_sha256 || sha256(workflowBytes) !== activation.workflow_file_sha256) throw new ControlError('ACTIVATION_BINDING_CHANGED', 'active adapter or workflow no longer matches approved activation');
  const currentDistribution = await distributionHashes();
  if (jsonDigest(currentDistribution) !== jsonDigest(activation.distribution)) throw new ControlError('DISTRIBUTION_CHANGED', 'control distribution changed since activation; setup must be reviewed again');
  const evidence = await readJson(path.join(root, activation.setup_evidence), 'setup evidence');
  if (evidence.status !== 'PASSED' || evidence.setup_digest !== activation.setup_digest || evidence.target_unchanged !== true) throw new ControlError('ACTIVATION_EVIDENCE_INVALID', 'activation evidence is missing or does not bind the approved setup');
  return { managed: true, valid: true, setup_digest: activation.setup_digest };
}

function blankGates() { return Object.fromEntries(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER'].map((phase) => [phase, { status: 'PENDING', evidence_ids: [] }])); }
const quoteBlock = (value) => value.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
const oneLine = (value) => value.replace(/[\r\n]+/g, ' ').trim();
function renderWorkItem(id, args) {
  return `# ${id}: ${oneLine(args.request.split(/\r?\n/, 1)[0].slice(0, 120))}\n\nKind: feature\n\n## Outcome\n\n${quoteBlock(args.request)}\n\n## Acceptance criteria\n\n${args.acceptance_criteria.map((v, i) => `- AC-${i + 1}: ${oneLine(v)}`).join('\n')}\n\n## Out of scope\n\n${args.out_of_scope.map((v) => `- ${oneLine(v)}`).join('\n')}\n\n## Constraints and invariants\n\n- Preserve the approved adapter, workflow, and external-action boundaries.\n\n## Design\n\n## Execution slices\n\n| Slice | Allowed paths | Frozen paths | Verifier IDs | Proof |\n|---|---|---|---|---|\n| 1 | ${args.allowed_paths.map((v) => `\`${v}\``).join(', ')} | ${(args.frozen_paths || []).map((v) => `\`${v}\``).join(', ') || 'none'} | configured adapter commands | runner evidence |\n\n## Independent review\n\n## Validation\n\n## Handover\n`;
}

export async function createTask(root, args) {
  const { loop } = await assertControlPath(root); await assertNoEngineLock(root); await verifyActivationBinding(root);
  stringValue(args.request, 'request', { max: 20000 }); stringArray(args.acceptance_criteria, 'acceptance_criteria', { min: 1 }); stringArray(args.out_of_scope, 'out_of_scope', { min: 1 }); safeRelativeArray(args.allowed_paths, 'allowed_paths', 1); safeRelativeArray(args.frozen_paths || [], 'frozen_paths');
  let id = args.work_item_id;
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'task' });
  try {
    const state = await readJson(path.join(loop, 'state.json'), 'state');
    if (state.run_status !== 'COMPLETED') throw new ControlError('PREVIOUS_HANDOVER_REQUIRED', 'complete the previous HANDOVER before creating a new task');
    if (!id) {
      const files = await fs.readdir(path.join(loop, 'work-items')); const nums = files.map((name) => /^WI-(\d+)\.md$/.exec(name)?.[1]).filter(Boolean).map(Number);
      id = `WI-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`;
    }
    stringValue(id, 'work_item_id', { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }); const workPath = path.join(loop, 'work-items', `${id}.md`);
    if (await exists(workPath)) throw new ControlError('WORK_ITEM_EXISTS', `work item already exists: ${id}`);
    await atomicText(workPath, renderWorkItem(id, args));
    const next = { ...state, work_item_id: id, phase: 'DEFINE', run_status: 'PAUSED', step: 'task-prepared', round: 0, gate_failures_here: 0, started_epoch: 0, gates: blankGates(), last_result: 'New bounded work item prepared.', next_action: 'Review the work item, then start.', updated_at: now() };
    await atomicJson(path.join(loop, 'state.json'), next);
  } finally { await release(); }
  return { ok: true, work_item_id: id, status: 'PAUSED', next: 'start' };
}

async function readJob(root, id) { return readJson(path.join(root, '.loop', 'control', 'jobs', `${id}.json`), 'job'); }
async function activeJob(root) {
  const file = path.join(root, '.loop', 'control', 'current-job.json'); if (!await exists(file)) return null;
  const current = await readJson(file, 'current job'); return readJob(root, current.job_id).catch(() => null);
}

async function priorRequest(root, requestIndex, requestId, scope) {
  const jobId = requestIndex.requests[requestId];
  if (!jobId) return null;
  const job = await readJob(root, jobId);
  const matches = job.operation === scope.operation && job.max_nodes === scope.max_nodes && job.work_item_id === scope.work_item_id && job.activation_digest === scope.activation_digest && job.host_config_digest === scope.host_config_digest;
  if (!matches) {
    throw new ControlError('REQUEST_ID_CONFLICT', 'request_id was already used with different job parameters', {
      request_id: requestId,
      existing: { operation: job.operation, max_nodes: job.max_nodes, work_item_id: job.work_item_id, activation_digest: job.activation_digest, host_config_digest: job.host_config_digest },
      requested: scope,
    });
  }
  return { ok: true, idempotent: true, job };
}

async function waitForWorkerStart(root, jobId, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs; let job = await readJob(root, jobId);
  while (job.status === 'QUEUED' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = await readJob(root, jobId);
  }
  return job;
}

async function privateRuntimeDirectory(root, create = false) {
  const runtimeRoot = await fs.realpath(os.tmpdir()).catch(() => path.resolve(os.tmpdir())); const uid = process.getuid ? String(process.getuid()) : sha256(os.homedir()).slice(0, 16);
  const namespace = path.join(runtimeRoot, `universal-build-loop-control-${uid}`); const project = path.join(namespace, sha256(root).slice(0, 32));
  for (const directory of [namespace, project]) {
    if (create) {
      try { await fs.mkdir(directory, { recursive: false, mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    else if (!await exists(directory)) return project;
    const stat = await fs.lstat(directory); const canonical = await fs.realpath(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()) || canonical !== directory) throw new ControlError('UNSAFE_RUNTIME_CONTROL', 'external job control directory must be private and owned by the current user');
  }
  return project;
}

async function runtimeControlFile(root, jobId, create = false) {
  return path.join(await privateRuntimeDirectory(root, create), `${jobId}.json`);
}

async function acquireJobLock(control, metadata) {
  const directory = path.join(control, 'job.lock'); const lockId = nonce(24);
  try { await fs.mkdir(directory, { recursive: false }); }
  catch (error) { if (error.code === 'EEXIST') throw new ControlError('JOB_ACTIVE', 'a managed job owns the project'); throw error; }
  await atomicJson(path.join(directory, 'owner.json'), { pid: process.pid, created_at: now(), ...metadata, lock_id: lockId });
  return { lock_id: lockId, release: () => releaseJobLock(control, lockId) };
}

async function releaseJobLock(control, lockId) {
  const directory = path.join(control, 'job.lock'); const ownerFile = path.join(directory, 'owner.json');
  const owner = await readJson(ownerFile, 'job lock owner').catch(() => null);
  if (!owner || owner.lock_id !== lockId) return false;
  await fs.rm(ownerFile, { force: true });
  const current = await readJson(ownerFile, 'job lock owner').catch(() => null); if (current) return false;
  await fs.rmdir(directory).catch(() => {}); return true;
}

async function assertJobFence(control, job) {
  const directory = path.join(control, 'job.lock'); const stat = await fs.lstat(directory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new ControlError('JOB_FENCE_LOST', 'managed job lock is missing or unsafe');
  const owner = await readJson(path.join(directory, 'owner.json'), 'job lock owner');
  if (owner.job_id !== job.job_id || owner.request_id !== job.request_id || owner.lock_id !== job.lock_id) throw new ControlError('JOB_FENCE_LOST', 'managed job no longer owns its fencing token');
}

async function createRuntimeControl(root, job) {
  const file = await runtimeControlFile(root, job.job_id, true); const token = nonce(32);
  await atomicJson(file, { schema_version: 1, job_id: job.job_id, lock_id: job.lock_id, token, desired_status: 'RUNNING', requested_at: null, heartbeat_at: now(), worker_finished: false }, 0o600);
  return { file, token };
}

async function readRuntimeControl(root, job, token = null) {
  const control = await readJson(await runtimeControlFile(root, job.job_id), 'external job control');
  if (control.job_id !== job.job_id || control.lock_id !== job.lock_id || (token && control.token !== token)) throw new ControlError('JOB_CONTROL_INVALID', 'external job control capability does not match the active job');
  return control;
}

async function writeRuntimeControl(root, job, runtime) {
  await atomicJson(await runtimeControlFile(root, job.job_id), runtime, 0o600);
}

async function acquireRuntimeGate(root, job, timeoutMs = 5000) {
  const directory = `${await runtimeControlFile(root, job.job_id)}.gate`; const deadline = Date.now() + timeoutMs;
  while (true) {
    try { await fs.mkdir(directory, { recursive: false }); return async () => fs.rmdir(directory).catch(() => {}); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new ControlError('JOB_CONTROL_BUSY', 'job control boundary did not become available');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function recoverStaleJob(root) {
  const control = path.join(root, '.loop', 'control'); const lockDir = path.join(control, 'job.lock');
  if (!await exists(lockDir)) return;
  const stat = await fs.lstat(lockDir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ControlError('UNSAFE_CONTROL_PATH', 'refusing unsafe managed job lock');
  const owner = await readJson(path.join(lockDir, 'owner.json'), 'job lock owner').catch(() => null);
  if (!owner?.job_id || !owner?.lock_id) throw new ControlError('JOB_RECOVERY_REQUIRED', 'managed job lock has no valid fenced owner and was left in place');
  const ownerJob = await readJob(root, owner.job_id).catch(() => null);
  if (ownerJob && !['QUEUED', 'RUNNING', 'STOPPING'].includes(ownerJob.status) && ownerJob.lock_id === owner.lock_id) {
    await releaseJobLock(control, owner.lock_id); return;
  }
}

async function spawnDetachedWorker(root, jobId, stdoutFd, stderrFd) {
  const worker = spawn(process.execPath, [workerPath, root, jobId], { detached: true, stdio: ['ignore', stdoutFd, stderrFd], env: { ...process.env, PATH: effectivePath(), LOOP_JOB_ID: jobId } });
  await new Promise((resolve, reject) => { worker.once('spawn', resolve); worker.once('error', reject); });
  worker.unref(); return worker;
}

async function failUnspawnedJob(root, control, job, jobLock, requestIndexFile, error) {
  // The launcher still owns job.lock and no worker was spawned. Cleanup only
  // its own job records; do not acquire an unrelated busy orchestrator lock.
  try {
    if (job) {
      const persisted = await readJob(root, job.job_id).catch(() => null);
      if (persisted?.job_id === job.job_id && persisted.lock_id === job.lock_id) {
        persisted.status = 'FAILED'; persisted.finished_at = now(); persisted.exit_code = 1;
        persisted.last_error = { code: 'WORKER_START_FAILED', message: String(error?.message || 'managed worker failed before process start').slice(0, 1024), cause_code: error?.code || null };
        await atomicJson(path.join(control, 'jobs', `${job.job_id}.json`), persisted);
      }
      const current = await readJson(path.join(control, 'current-job.json'), 'current job').catch(() => null);
      if (current?.job_id === job.job_id) await fs.rm(path.join(control, 'current-job.json'), { force: true });
      const intent = await readJson(path.join(control, 'intent.json'), 'job intent').catch(() => null);
      if (intent?.job_id === job.job_id && intent.request_id === job.request_id) await fs.rm(path.join(control, 'intent.json'), { force: true });
      const index = await readJson(requestIndexFile, 'request index').catch(() => null);
      if (index?.requests?.[job.request_id] === job.job_id) { delete index.requests[job.request_id]; await atomicJson(requestIndexFile, index); }
      await fs.rm(await runtimeControlFile(root, job.job_id), { force: true });
    }
  } finally { await jobLock.release(); }
}

export async function launchJob(root, mode, args) {
  const { loop, control } = await assertControlPath(root);
  await recoverStaleJob(root); await assertNoEngineLock(root);
  const activation = await verifyActivationBinding(root); let state = await readJson(path.join(loop, 'state.json'), 'state'); let config = await readJson(path.join(loop, 'host.local.json'), 'host.local.json'); await verifyHostConfiguration(root, config); const initialStateDigest = jsonDigest(state);
  let scope = { operation: mode, max_nodes: args.max_nodes, work_item_id: state.work_item_id, activation_digest: activation.setup_digest || 'legacy', host_config_digest: jsonDigest(config) };
  const requestIndexFile = path.join(control, 'request-index.json'); let requestIndex = await exists(requestIndexFile) ? await readJson(requestIndexFile) : { schema_version: 1, requests: {} };
  const prior = await priorRequest(root, requestIndex, args.request_id, scope); if (prior) return prior;
  if (mode === 'start' && state.run_status !== 'PAUSED') throw new ControlError('INVALID_STATE', 'start requires PAUSED state');
  if (mode === 'resume' && !['BLOCKED', 'PAUSED'].includes(state.run_status)) throw new ControlError('INVALID_STATE', 'resume requires BLOCKED or PAUSED state');
  if (mode === 'run' && !['PAUSED', 'RUNNING'].includes(state.run_status)) throw new ControlError('INVALID_STATE', 'run requires PAUSED or RUNNING state');
  if (state.round >= state.max_rounds) throw new ControlError('ROUND_CAP_REACHED', 'round cap is already reached');
  if (state.started_epoch > 0 && Math.floor(Date.now() / 1000) - state.started_epoch > state.max_wall_seconds) throw new ControlError('WALL_CAP_REACHED', 'original wall-clock cap is already reached');
  if (!await executable(config.provider_path) || !await executable(config.review_provider_path)) throw new ControlError('PROVIDER_NOT_INSTALLED', 'configured provider or review provider is not executable');
  const existing = await activeJob(root); if (existing && ['QUEUED', 'RUNNING', 'STOPPING'].includes(existing.status)) throw new ControlError('JOB_ACTIVE', `job ${existing.job_id} is already active`);
  const jobId = `job-${Date.now()}-${nonce(6)}`;
  let jobLock;
  try { jobLock = await acquireJobLock(control, { request_id: args.request_id, job_id: jobId }); }
  catch (error) {
    await recoverStaleJob(root);
    requestIndex = await exists(requestIndexFile) ? await readJson(requestIndexFile) : requestIndex;
    const concurrent = await priorRequest(root, requestIndex, args.request_id, scope); if (concurrent) return concurrent;
    throw error;
  }
  let coordinationLock; let spawned = false; let job; let stdout; let stderr;
  try {
    coordinationLock = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'launch-job', job_id: jobId });
    const currentActivation = await verifyActivationBinding(root); state = await readJson(path.join(loop, 'state.json'), 'state'); config = await readJson(path.join(loop, 'host.local.json'), 'host.local.json'); await verifyHostConfiguration(root, config);
    const currentScope = { operation: mode, max_nodes: args.max_nodes, work_item_id: state.work_item_id, activation_digest: currentActivation.setup_digest || 'legacy', host_config_digest: jsonDigest(config) };
    if (jsonDigest(currentScope) !== jsonDigest(scope) || jsonDigest(state) !== initialStateDigest) throw new ControlError('LAUNCH_SCOPE_CHANGED', 'work item, state, activation, or provider configuration changed while the job was starting');
    requestIndex = await exists(requestIndexFile) ? await readJson(requestIndexFile) : requestIndex;
    const concurrent = await priorRequest(root, requestIndex, args.request_id, scope); if (concurrent) { await coordinationLock(); await jobLock.release(); return concurrent; }
    job = { schema_version: 1, job_id: jobId, request_id: args.request_id, operation: mode, status: 'QUEUED', desired_status: 'RUNNING', max_nodes: args.max_nodes, nodes_completed: 0, created_at: now(), started_at: null, finished_at: null, pid: null, exit_code: null, last_error: null, lock_id: jobLock.lock_id, work_item_id: state.work_item_id, phase_at_launch: state.phase, state_at_launch_digest: initialStateDigest, activation_digest: scope.activation_digest, host_config_digest: scope.host_config_digest, bound_config: config };
    await createRuntimeControl(root, job);
    await atomicJson(path.join(control, 'jobs', `${jobId}.json`), job); await atomicJson(path.join(control, 'current-job.json'), { schema_version: 1, job_id: jobId });
    requestIndex.requests[args.request_id] = jobId; await atomicJson(requestIndexFile, requestIndex);
    await atomicJson(path.join(control, 'intent.json'), { schema_version: 1, job_id: jobId, request_id: args.request_id, desired_status: 'RUNNING', requested_at: now() });
    const logDir = path.join(control, 'jobs', `${jobId}.logs`); await fs.mkdir(logDir, { recursive: true });
    stdout = await fs.open(path.join(logDir, 'stdout.log'), 'a', 0o600); stderr = await fs.open(path.join(logDir, 'stderr.log'), 'a', 0o600);
    await coordinationLock(); coordinationLock = null;
    await spawnDetachedWorker(root, jobId, stdout.fd, stderr.fd); spawned = true; await stdout.close(); stdout = null; await stderr.close(); stderr = null;
    return { ok: true, idempotent: false, job: await waitForWorkerStart(root, jobId) };
  } catch (error) { if (coordinationLock) await coordinationLock(); await stdout?.close().catch(() => {}); await stderr?.close().catch(() => {}); if (!spawned) await failUnspawnedJob(root, control, job, jobLock, requestIndexFile, error); throw error; }
}

export async function launchActivation(root) {
  const { loop, control } = await assertControlPath(root); const plan = await verifyPlanForApproval(root); await recoverStaleJob(root);
  const candidateState = await readJson(path.join(loop, 'candidate', 'state.json'), 'candidate state'); const config = await readJson(path.join(loop, 'host.local.json'), 'host.local.json').catch(() => null);
  const requestId = `activate-${plan.setup_digest}`; const scope = { operation: 'activate', max_nodes: 1, work_item_id: candidateState.work_item_id, activation_digest: plan.setup_digest, host_config_digest: config ? jsonDigest(config) : null };
  const requestIndexFile = path.join(control, 'request-index.json'); let requestIndex = await exists(requestIndexFile) ? await readJson(requestIndexFile) : { schema_version: 1, requests: {} };
  const prior = await priorRequest(root, requestIndex, requestId, scope); if (prior) return prior;
  if (!await exists(path.join(control, 'approvals', `${plan.setup_digest}.json`))) throw new ControlError('APPROVAL_REQUIRED', 'request and complete local approval before activation');
  await assertNoEngineLock(root);
  const existing = await activeJob(root); if (existing && ['QUEUED', 'RUNNING', 'STOPPING'].includes(existing.status)) throw new ControlError('JOB_ACTIVE', `job ${existing.job_id} is already active`);
  const jobId = `job-${Date.now()}-${nonce(6)}`;
  let jobLock;
  try { jobLock = await acquireJobLock(control, { request_id: requestId, job_id: jobId }); }
  catch (error) { await recoverStaleJob(root); requestIndex = await exists(requestIndexFile) ? await readJson(requestIndexFile) : requestIndex; const concurrent = await priorRequest(root, requestIndex, requestId, scope); if (concurrent) return concurrent; throw error; }
  requestIndex = await exists(requestIndexFile) ? await readJson(requestIndexFile) : requestIndex;
  let concurrent;
  try { concurrent = await priorRequest(root, requestIndex, requestId, scope); }
  catch (error) { await jobLock.release(); throw error; }
  if (concurrent) { await jobLock.release(); return concurrent; }
  const job = { schema_version: 1, job_id: jobId, request_id: requestId, operation: 'activate', status: 'QUEUED', desired_status: 'RUNNING', max_nodes: 1, nodes_completed: 0, created_at: now(), started_at: null, finished_at: null, pid: null, exit_code: null, last_error: null, activation_result: null, lock_id: jobLock.lock_id, work_item_id: candidateState.work_item_id, phase_at_launch: candidateState.phase, state_at_launch_digest: jsonDigest(candidateState), activation_digest: plan.setup_digest, host_config_digest: scope.host_config_digest, bound_config: config };
  let spawned = false; let stdout; let stderr;
  try {
    await createRuntimeControl(root, job);
    await atomicJson(path.join(control, 'jobs', `${jobId}.json`), job); await atomicJson(path.join(control, 'current-job.json'), { schema_version: 1, job_id: jobId }); requestIndex.requests[requestId] = jobId; await atomicJson(requestIndexFile, requestIndex);
    const logDir = path.join(control, 'jobs', `${jobId}.logs`); await fs.mkdir(logDir, { recursive: true }); stdout = await fs.open(path.join(logDir, 'stdout.log'), 'a', 0o600); stderr = await fs.open(path.join(logDir, 'stderr.log'), 'a', 0o600);
    await spawnDetachedWorker(root, jobId, stdout.fd, stderr.fd); spawned = true; await stdout.close(); stdout = null; await stderr.close(); stderr = null;
    return { ok: true, idempotent: false, job: await waitForWorkerStart(root, jobId) };
  } catch (error) { await stdout?.close().catch(() => {}); await stderr?.close().catch(() => {}); if (!spawned) await failUnspawnedJob(root, control, job, jobLock, requestIndexFile, error); throw error; }
}

export async function setIntent(root, desired) {
  const { loop, control } = await assertControlPath(root); const job = await activeJob(root);
  if (job && ['QUEUED', 'RUNNING', 'STOPPING'].includes(job.status)) {
    if (job.operation === 'activate') throw new ControlError('ACTIVATION_NOT_STOPPABLE', 'activation probes cannot be paused or cancelled; each probe has its approved finite timeout', { job_id: job.job_id });
    await assertJobFence(control, job); const release = await acquireRuntimeGate(root, job);
    try {
      const currentJob = await readJob(root, job.job_id); if (!['QUEUED', 'RUNNING', 'STOPPING'].includes(currentJob.status)) throw new ControlError('NOT_RUNNING', 'managed job reached a terminal state before the stop request was recorded');
      const runtime = await readRuntimeControl(root, job); runtime.desired_status = desired; runtime.requested_at = now(); await writeRuntimeControl(root, job, runtime);
    } finally { await release(); }
    return { ok: true, deferred_until_node_boundary: job.status !== 'QUEUED', desired_status: desired, observed_status: 'STOPPING', job_id: job.job_id };
  }
  if (await exists(path.join(control, 'job.lock'))) throw new ControlError('JOB_STARTING', 'a fenced managed job is starting; retry pause or cancel');
  await assertNoEngineLock(root);
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: desired.toLowerCase() });
  try { const state = await readJson(path.join(loop, 'state.json'), 'state'); if (state.run_status !== 'RUNNING') throw new ControlError('NOT_RUNNING', 'no active run can be stopped'); state.run_status = desired; state.last_result = desired === 'PAUSED' ? 'paused at node boundary' : 'cancelled at node boundary'; state.next_action = desired === 'PAUSED' ? 'resume when ready' : 'create a new task after explicit handover decision'; state.updated_at = now(); await atomicJson(path.join(loop, 'state.json'), state); }
  finally { await release(); }
  return { ok: true, deferred_until_node_boundary: false, desired_status: desired };
}

function blockerId(line) { return `blocker-${sha256(line).slice(0, 20)}`; }
async function recoverAnswerQuarantine(root, loop, control, state) {
  const quarantineFile = path.join(loop, 'quarantine.json'); if (!await exists(quarantineFile)) return false;
  const quarantine = await readJson(quarantineFile, 'workspace quarantine');
  exactKeys(quarantine, ['schema_version', 'work_item_id', 'phase', 'run_id', 'detected_at', 'changed_paths', 'expected'], ['schema_version', 'work_item_id', 'phase', 'run_id', 'detected_at', 'changed_paths', 'expected'], 'quarantine');
  if (quarantine.schema_version !== 1 || quarantine.work_item_id !== state.work_item_id || quarantine.phase !== state.phase) throw new ControlError('WORKSPACE_QUARANTINED', 'workspace quarantine does not match the active blocker context');
  if (!Array.isArray(quarantine.changed_paths) || !quarantine.changed_paths.length || new Set(quarantine.changed_paths).size !== quarantine.changed_paths.length || [...quarantine.changed_paths].sort().some((value, index) => value !== quarantine.changed_paths[index])) throw new ControlError('WORKSPACE_QUARANTINED', 'workspace quarantine changed_paths is invalid');
  const answerPattern = /^\.loop\/control\/answers\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
  if (quarantine.changed_paths.some((item) => typeof item !== 'string' || !answerPattern.test(item))) throw new ControlError('WORKSPACE_QUARANTINED', 'workspace has non-answer control or evidence damage; restore the quarantined paths before answering');
  if (!Array.isArray(quarantine.expected) || quarantine.expected.length !== quarantine.changed_paths.length || quarantine.expected.some((item, index) => !item || item.path !== quarantine.changed_paths[index] || !(item.record === null || typeof item.record === 'object'))) throw new ControlError('WORKSPACE_QUARANTINED', 'workspace quarantine expected records are invalid');
  const answersDir = path.join(control, 'answers'); const stat = await fs.lstat(answersDir).catch(() => null);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(answersDir) !== answersDir)) throw new ControlError('UNSAFE_CONTROL_PATH', 'refusing unsafe quarantined answers directory');
  for (const item of quarantine.changed_paths) await fs.rm(path.join(root, item), { force: true });
  return true;
}

export async function answerBlocker(root, args) {
  const { loop, control } = await assertControlPath(root); await assertNoEngineLock(root);
  if ((args.blocker_id ? 1 : 0) + (args.blocker_index ? 1 : 0) !== 1) throw new ControlError('INVALID_INPUT', 'provide exactly one of blocker_id or blocker_index');
  stringValue(args.answer, 'answer', { max: 20000 }); const blockersFile = path.join(loop, 'blockers.md');
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'answer' });
  let answerId; let selected; let open; let recoveredQuarantine = false;
  try { const text = await fs.readFile(blockersFile, 'utf8').catch(() => { throw new ControlError('NO_BLOCKERS', 'no blocker file exists'); }); const lines = text.split('\n'); open = lines.map((line, index) => ({ line, index, blocker_id: blockerId(line) })).filter(({ line }) => line.includes('- [ ]')); selected = args.blocker_id ? open.find((item) => item.blocker_id === args.blocker_id) : open[args.blocker_index - 1]; if (!selected) throw new ControlError('BLOCKER_NOT_FOUND', 'referenced open blocker was not found', { open_blockers: open.map(({ blocker_id, line }, index) => ({ blocker_id, blocker_index: index + 1, text: line })) }); const state = await readJson(path.join(loop, 'state.json'), 'state'); recoveredQuarantine = await recoverAnswerQuarantine(root, loop, control, state); answerId = `answer-${nonce(12)}`; const record = { schema_version: 1, answer_id: answerId, blocker_id: selected.blocker_id, work_item_id: state.work_item_id, phase: state.phase, answer: args.answer, recorded_at: now(), answer_sha256: sha256(args.answer) }; await atomicJson(path.join(control, 'answers', `${answerId}.json`), record); lines[selected.index] = selected.line.replace('- [ ]', '- [x]'); await atomicText(blockersFile, lines.join('\n')); if (recoveredQuarantine) await fs.rm(path.join(loop, 'quarantine.json'), { force: true }); }
  finally { await release(); }
  return { ok: true, answer_id: answerId, blocker_id: selected.blocker_id, remaining_open_blockers: open.length - 1 };
}

export async function completeHandover(root, args) {
  const { loop, control } = await assertControlPath(root); await assertNoEngineLock(root);
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'handover' });
  let state;
  try { state = await readJson(path.join(loop, 'state.json'), 'state'); const passedHandover = state.phase === 'HANDOVER' && state.run_status === 'WAITING_FOR_HUMAN' && state.gates?.HANDOVER?.status === 'PASSED'; const cancelled = state.run_status === 'CANCELLED'; if (!passedHandover && !cancelled) throw new ControlError('HANDOVER_NOT_READY', 'HANDOVER must be passed and waiting, or the run must be CANCELLED'); await atomicJson(path.join(control, 'handovers', `${state.work_item_id}.json`), { schema_version: 1, work_item_id: state.work_item_id, kind: cancelled ? 'cancellation' : 'completed-work', note: args.note, acknowledged_at: now(), external_action_authorized: false }); state.run_status = 'COMPLETED'; state.last_result = cancelled ? 'Cancellation acknowledged; no delivery action performed.' : 'Handover acknowledged locally; no delivery action performed.'; state.next_action = 'Create the next work item or separately authorize a delivery action.'; state.updated_at = now(); await atomicJson(path.join(loop, 'state.json'), state); }
  finally { await release(); }
  return { ok: true, work_item_id: state.work_item_id, status: 'COMPLETED', external_action_performed: false };
}

export async function status(root, args = {}) {
  const { loop, control } = await assertControlPath(root); const stateFile = path.join(loop, 'state.json'); const state = await exists(stateFile) ? await readJson(stateFile, 'state') : null;
  let job = null; if (args.job_id) job = await readJob(root, args.job_id); else job = await activeJob(root);
  if (job && ['QUEUED', 'RUNNING', 'STOPPING'].includes(job.status)) {
    const runtime = await readRuntimeControl(root, job).catch(() => null);
    job = { ...job, observed_status: runtime?.desired_status && runtime.desired_status !== 'RUNNING' ? 'STOPPING' : job.status, requested_status: runtime?.desired_status || job.desired_status, heartbeat_at: runtime?.heartbeat_at || null };
  }
  let blockers = [];
  if (await exists(path.join(loop, 'blockers.md'))) blockers = (await fs.readFile(path.join(loop, 'blockers.md'), 'utf8')).split('\n').filter((line) => line.includes('- [ ]')).map((line, index) => ({ blocker_index: index + 1, blocker_id: blockerId(line), text: line.replace(/^.*?:\s*/, '') }));
  let activation = state ? await verifyActivationBinding(root).catch((error) => ({ managed: true, valid: false, error: error.message })) : null;
  if (!state && await exists(path.join(loop, 'candidate', 'setup.plan.json'))) {
    const plan = await readJson(path.join(loop, 'candidate', 'setup.plan.json')); const receiptFile = path.join(control, 'approvals', `${plan.setup_digest}.json`); let approvalTrusted = false; let untrustedReceipt = false;
    if (await exists(receiptFile)) { try { await verifyApproval(root, await readJson(receiptFile, 'approval receipt')); approvalTrusted = true; } catch { untrustedReceipt = true; } }
    activation = { managed: true, valid: null, setup_digest: plan.setup_digest, status: job?.operation === 'activate' ? job.status : (approvalTrusted ? 'APPROVED' : 'PENDING_APPROVAL'), approval_trusted: approvalTrusted, untrusted_receipt: untrustedReceipt };
  }
  return { ok: true, initialized: Boolean(state), state, job, open_blockers: blockers, activation };
}

export async function workerRun(root, jobId) {
  const { loop, control } = await assertControlPath(root); const jobFile = path.join(control, 'jobs', `${jobId}.json`); const job = await readJson(jobFile, 'job');
  const persist = async () => atomicJson(jobFile, job);
  const current = await readJson(path.join(control, 'current-job.json'), 'current job');
  if (current.job_id !== job.job_id) throw new ControlError('JOB_FENCE_LOST', 'delayed worker is not the current managed job');
  await assertJobFence(control, job); const initialRuntime = await readRuntimeControl(root, job); const runtimeToken = initialRuntime.token;
  let ownsFence = true; let failure = null;
  try {
    job.pid = process.pid; job.status = 'RUNNING'; if (!job.started_at) job.started_at = now(); await persist();
    await atomicJson(path.join(control, 'job.lock', 'owner.json'), { pid: process.pid, created_at: job.started_at, request_id: job.request_id, job_id: job.job_id, lock_id: job.lock_id });
    if (job.operation === 'activate') {
      await assertJobFence(control, job); job.activation_result = await activateProject(root); await assertJobFence(control, job);
      job.nodes_completed = 1; job.status = 'COMPLETED'; job.exit_code = 0;
    } else {
      const config = job.bound_config; await verifyBoundExecution(root, job);
      let stopped = false;
      if (job.operation === 'start' || (job.operation === 'run' && (await readJson(path.join(loop, 'state.json'))).run_status === 'PAUSED')) {
        const boundary = await childAtBoundary(root, control, job, runtimeToken, ['start', '--root', root]);
        if (boundary.stop) stopped = await applyPendingStop(root, job, runtimeToken, persist);
      }
      if (!stopped && job.operation === 'resume') {
        const state = await readJson(path.join(loop, 'state.json')); const boundary = await childAtBoundary(root, control, job, runtimeToken, [state.run_status === 'PAUSED' ? 'start' : 'resume', '--root', root]);
        if (boundary.stop) stopped = await applyPendingStop(root, job, runtimeToken, persist);
      }
      while (!stopped && job.nodes_completed < job.max_nodes) {
        const state = await readJson(path.join(loop, 'state.json'));
        if (!(state.run_status === 'RUNNING' || (state.run_status === 'WAITING_FOR_HUMAN' && state.phase === 'HANDOVER' && state.gates.HANDOVER.status === 'PENDING'))) break;
        const args = ['run', '--root', root, '--host', config.host, '--provider', config.provider_path, '--review-host', config.review_host, '--review-provider', config.review_provider_path];
        const boundary = await childAtBoundary(root, control, job, runtimeToken, args);
        if (boundary.result) { job.nodes_completed += 1; job.last_exit_code = boundary.result.exit_code; await persist(); }
        if (boundary.stop) { stopped = await applyPendingStop(root, job, runtimeToken, persist); if (stopped) break; }
        const after = await readJson(path.join(loop, 'state.json')); if (after.run_status !== 'RUNNING' && !(after.run_status === 'WAITING_FOR_HUMAN' && after.phase === 'HANDOVER' && after.gates.HANDOVER.status === 'PENDING')) break;
      }
      if (!['PAUSED', 'CANCELLED'].includes(job.status)) {
        const release = await acquireRuntimeGate(root, job);
        try {
          const runtime = await readRuntimeControl(root, job, runtimeToken);
          if (runtime.desired_status !== 'RUNNING') await applyStop(root, job, runtime.desired_status, persist);
          else { job.status = 'COMPLETED'; job.exit_code = 0; await persist(); }
        } finally { await release(); }
      }
    }
  } catch (error) {
    try { await assertJobFence(control, job); }
    catch { ownsFence = false; }
    if (ownsFence) failure = error;
  }
  if (!ownsFence) return;
  const finalRelease = await acquireRuntimeGate(root, job);
  try {
    const runtime = await readRuntimeControl(root, job, runtimeToken).catch(() => null);
    if (failure) {
      job.last_error = { code: failure.code || 'WORKER_ERROR', message: failure.message };
      if (job.operation !== 'activate' && runtime?.desired_status && runtime.desired_status !== 'RUNNING') await applyStop(root, job, runtime.desired_status, persist);
      else { job.status = 'FAILED'; job.exit_code = failure.exit_code || 1; }
    } else if (job.operation !== 'activate' && runtime?.desired_status && runtime.desired_status !== 'RUNNING' && !['PAUSED', 'CANCELLED'].includes(job.status)) await applyStop(root, job, runtime.desired_status, persist);
    job.finished_at = now(); await persist();
    if (runtime) { runtime.worker_finished = true; runtime.heartbeat_at = now(); await writeRuntimeControl(root, job, runtime); }
  } finally { await finalRelease(); }
  await fs.rm(path.join(control, 'intent.json'), { force: true }); await releaseJobLock(control, job.lock_id); await fs.rm(await runtimeControlFile(root, job.job_id), { force: true });
}

async function verifyBoundExecution(root, job) {
  const current = await readJson(path.join(root, '.loop', 'control', 'current-job.json'), 'current job'); if (current.job_id !== job.job_id) throw new ControlError('JOB_FENCE_LOST', 'managed job is no longer current');
  const activation = await verifyActivationBinding(root); if ((activation.setup_digest || 'legacy') !== job.activation_digest) throw new ControlError('JOB_SCOPE_CHANGED', 'activation binding changed after the job was queued');
  const config = await readJson(path.join(root, '.loop', 'host.local.json'), 'host.local.json'); await verifyHostConfiguration(root, config); if (jsonDigest(config) !== job.host_config_digest) throw new ControlError('JOB_SCOPE_CHANGED', 'provider configuration changed after the job was queued');
  const state = await readJson(path.join(root, '.loop', 'state.json'), 'state'); if (state.work_item_id !== job.work_item_id) throw new ControlError('JOB_SCOPE_CHANGED', 'work item changed after the job was queued');
}

async function childAtBoundary(root, control, job, runtimeToken, args) {
  await assertJobFence(control, job); await verifyBoundExecution(root, job); const release = await acquireRuntimeGate(root, job); let pending; let stop = null;
  try {
    const runtime = await readRuntimeControl(root, job, runtimeToken); runtime.heartbeat_at = now(); await writeRuntimeControl(root, job, runtime);
    if (runtime.desired_status !== 'RUNNING') stop = runtime.desired_status;
    else pending = child(orchestrator, args, root, job.job_id, job.lock_id);
  } finally { await release(); }
  if (!pending) return { result: null, stop };
  const result = await pending; await assertJobFence(control, job); await verifyBoundExecution(root, job);
  const afterRelease = await acquireRuntimeGate(root, job);
  try {
    const runtime = await readRuntimeControl(root, job, runtimeToken); runtime.heartbeat_at = now(); await writeRuntimeControl(root, job, runtime);
    return { result, stop: runtime.desired_status === 'RUNNING' ? null : runtime.desired_status };
  } finally { await afterRelease(); }
}

async function applyStop(root, job, desired, persist) {
  const canonical = await setCanonicalStop(root, desired); job.desired_status = desired;
  job.status = canonical === 'CANCELLED' ? 'CANCELLED' : canonical === 'PAUSED' ? 'PAUSED' : 'COMPLETED'; job.exit_code = 0; await persist();
}

async function applyPendingStop(root, job, runtimeToken, persist) {
  const release = await acquireRuntimeGate(root, job);
  try {
    const runtime = await readRuntimeControl(root, job, runtimeToken);
    if (runtime.desired_status === 'RUNNING') return false;
    await applyStop(root, job, runtime.desired_status, persist); return true;
  } finally { await release(); }
}

async function child(command, args, cwd, jobId, lockId) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, env: { ...process.env, PATH: effectivePath(), LOOP_JOB_ID: jobId, LOOP_JOB_LOCK_ID: lockId }, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
    proc.stdout.on('data', (chunk) => { if (stdout.length < 131072) stdout += chunk; }); proc.stderr.on('data', (chunk) => { if (stderr.length < 131072) stderr += chunk; }); proc.on('error', reject);
    proc.on('close', (code, signal) => { if (code === null || code > 1) { const error = new ControlError('ORCHESTRATOR_FAILED', stderr.trim().slice(0, 4096) || `orchestrator terminated ${signal || `with exit ${code}`}`); error.exit_code = code ?? 1; reject(error); } else resolve({ exit_code: code, stdout, stderr }); });
  });
}

async function setCanonicalStop(root, desired) {
  const loop = path.join(root, '.loop'); const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'job-stop' });
  try {
    const state = await readJson(path.join(loop, 'state.json'));
    if (desired === 'CANCELLED' && ['RUNNING', 'PAUSED', 'WAITING_FOR_HUMAN', 'BLOCKED'].includes(state.run_status)) state.run_status = 'CANCELLED';
    else if (desired === 'PAUSED' && state.run_status === 'RUNNING') state.run_status = 'PAUSED';
    if (state.run_status === desired) { state.last_result = desired === 'PAUSED' ? 'paused at node boundary' : 'cancelled at node boundary'; state.next_action = desired === 'PAUSED' ? 'resume when ready' : 'run cancelled'; state.updated_at = now(); await atomicJson(path.join(loop, 'state.json'), state); }
    return state.run_status;
  }
  finally { await release(); }
}
