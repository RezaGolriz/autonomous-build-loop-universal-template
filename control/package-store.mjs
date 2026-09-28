// Registered packages of the multi-package supervisor (control/supervisor.mjs).
//
// A package is one isolated project root with its own .loop: its own engine,
// its own locks, its own state and its own six phases. Registering a package
// runs nothing and grants nothing. The record says where the root is, which
// shared resources it touches, what it depends on and how much time it may use;
// whether it may run at all is decided in the root itself, by its own
// activation and its own READY authorization, which only a person gives.
//
// The store lives under .loop/scheduler, beside the tick lock, never under
// .loop/control: it may be written while a node of the supervising project is
// running, and the engine treats any change under .loop/control during a node
// as provider tampering.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { verifyApproval, verifyHostConfiguration } from './approval-store.mjs';
import {
  ControlError, acquireDirLock, assertControlPath, assertPlain, atomicJson, ensureRuntimeIgnore, exactKeys, exists, intValue, jsonDigest, now, readJson, resolveRoot, stringArray, stringValue,
} from './common.mjs';
import { readSchedulerRecord, saveSchedulerRecord, schedulerRecordExists } from './scheduler-store.mjs';
import { withSchedulerLock } from './scheduler-lock.mjs';
import { authorizationExpired, readAuthorization } from './backlog.mjs';
import { readHold } from './hold.mjs';
import { handoverNodePending, verifyActivationBinding } from './jobs.mjs';

export const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESOURCE = /^[a-z][a-z0-9_.:/-]{0,127}$/;
const PHASES = ['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER'];
const ADD_KEYS = ['package_id', 'title', 'workspace_root', 'prepare', 'shared_paths', 'resources', 'depends_on', 'budget', 'max_retries', 'on_conflict'];
const MAX_PACKAGES = 64;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const oneLine = (value) => value.replace(/[\r\n]+/g, ' ').trim();
const inside = (outer, inner) => inner === outer || inner.startsWith(`${outer}${path.sep}`);

export function storePaths(scheduler) {
  const dir = path.join(scheduler, 'packages');
  return { dir, file: path.join(dir, 'packages.json'), lock: path.join(dir, 'store.lock'), roots: path.join(scheduler, 'package-roots') };
}

// A directory under .loop/scheduler that a record is written into has to be a
// real directory of this project, not a link somewhere else.
export async function assertRealDirectory(directory, label) {
  const stat = await fs.lstat(directory).catch(() => null);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw new ControlError('UNSAFE_CONTROL_PATH', `refusing unsafe ${label}`);
  return true;
}

// A short critical section. A time delay is never permission to steal a lock.
export async function withShortLock(directory, operation, fn, timeoutMs = 5000) {
  return withSchedulerLock(directory, operation, fn, timeoutMs);
}

function budgetValue(value) {
  exactKeys(value, ['soft_seconds', 'reserve_seconds', 'hard_ceiling_seconds'], ['soft_seconds', 'hard_ceiling_seconds'], 'budget');
  const soft = intValue(value.soft_seconds, 'budget.soft_seconds', 1, 604800);
  const reserve = value.reserve_seconds === undefined ? 0 : intValue(value.reserve_seconds, 'budget.reserve_seconds', 0, 604800);
  const hard = intValue(value.hard_ceiling_seconds, 'budget.hard_ceiling_seconds', 1, 604800);
  if (soft + reserve > hard) throw new ControlError('INVALID_BUDGET', 'budget.soft_seconds plus budget.reserve_seconds may not exceed budget.hard_ceiling_seconds: the reserve is part of the ceiling, never beyond it');
  return { soft_seconds: soft, reserve_seconds: reserve, hard_ceiling_seconds: hard };
}

function sharedPathsValue(value) {
  if (value === undefined) return [];
  return stringArray(value, 'shared_paths', { max: 32 }).map((item, index) => {
    if (!path.isAbsolute(item) || /[\0-\x1f\x7f]/.test(item) || path.resolve(item) !== item || item === path.parse(item).root) throw new ControlError('UNSAFE_PATH', `shared_paths[${index}] must be a normalized absolute path that is not a filesystem root`);
    return item;
  });
}

async function canonicalSharedPath(value) {
  let part = value; const suffix = [];
  for (;;) {
    try { return path.join(await fs.realpath(part), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(part);
      if (parent === part) throw new ControlError('UNSAFE_PATH', 'Shared path cannot be resolved.');
      suffix.push(path.basename(part)); part = parent;
    }
  }
}

function packageSpecDigest(record) {
  const { added_at, spec_digest, ...spec } = record;
  return jsonDigest(spec);
}

// A record read back from the store is checked as strictly as one being
// added: a store somebody edited by hand into something else is refused.
function validateStoredPackage(record, index) {
  const label = `packages[${index}]`;
  exactKeys(record, ['schema_version', 'package_id', 'title', 'root', 'prepared', 'shared_paths', 'resources', 'depends_on', 'budget', 'max_retries', 'on_conflict', 'added_at', 'spec_digest'], ['schema_version', 'package_id', 'title', 'root', 'prepared', 'shared_paths', 'resources', 'depends_on', 'budget', 'max_retries', 'on_conflict', 'added_at', 'spec_digest'], label);
  if (record.schema_version !== 1) throw new ControlError('INVALID_PACKAGE_STORE', `${label} must be a version 1 record`);
  stringValue(record.package_id, `${label}.package_id`, { pattern: PACKAGE_ID });
  if (typeof record.root !== 'string' || !path.isAbsolute(record.root)) throw new ControlError('INVALID_PACKAGE_STORE', `${label}.root must be absolute`);
  budgetValue(record.budget); sharedPathsValue(record.shared_paths);
  stringArray(record.resources, `${label}.resources`, { max: 32, pattern: RESOURCE });
  stringArray(record.depends_on, `${label}.depends_on`, { max: 32, pattern: PACKAGE_ID });
  intValue(record.max_retries, `${label}.max_retries`, 0, 5);
  if (!['serialize', 'block'].includes(record.on_conflict) || typeof record.prepared !== 'boolean') throw new ControlError('INVALID_PACKAGE_STORE', `${label} is invalid`);
  if (packageSpecDigest(record) !== record.spec_digest) throw new ControlError('INVALID_PACKAGE_STORE', `${label} does not match its spec_digest; the store was changed by hand`);
  return record;
}

export async function readStore(root) {
  const { scheduler } = await assertControlPath(root);
  const paths = storePaths(scheduler);
  if (!await schedulerRecordExists(root, paths.file)) return { schema_version: 1, packages: [] };
  await assertRealDirectory(scheduler, '.loop/scheduler');
  await assertRealDirectory(paths.dir, 'package store directory');
  const store = await readSchedulerRecord(root, paths.file);
  if (store.schema_version !== 1 || !Array.isArray(store.packages)) throw new ControlError('INVALID_PACKAGE_STORE', 'packages.json must be a version 1 record with a packages array');
  store.packages.forEach(validateStoredPackage);
  if (new Set(store.packages.map(x => x.package_id)).size !== store.packages.length) throw new ControlError('INVALID_PACKAGE_STORE', 'Duplicate package identifiers.');
  for (const pkg of store.packages) {
    if (await resolveRoot(pkg.root) !== pkg.root) throw new ControlError('PACKAGE_ROOT_CHANGED', 'Registered root now resolves elsewhere.');
    for (const shared of pkg.shared_paths) if (await canonicalSharedPath(shared) !== shared) throw new ControlError('SHARED_PATH_CHANGED', 'A declared shared path now resolves elsewhere.');
    const problem = rootProblem(root, scheduler, pkg.root, store.packages, pkg.package_id);
    if (problem) throw problem;
    if (pkg.depends_on.some(id => !store.packages.some(x => x.package_id === id))) throw new ControlError('INVALID_PACKAGE_STORE', 'Unknown stored dependency.');
  }
  return store;
}

// Where a package root may be. Each root is its own project, so it may not be
// the supervising project, contain it, or sit inside its working tree (the
// supervising project's own run would see the package's files change); the one
// exception is an inert root prepared under .loop/scheduler/package-roots. Two
// packages never share a root and never nest.
function rootProblem(parent, scheduler, candidate, packages, id) {
  const preparedRoots = storePaths(scheduler).roots;
  if (candidate === parent || inside(candidate, parent)) return new ControlError('PACKAGE_ROOT_OVERLAP', 'a package root may not be the supervising project or one of its ancestors');
  if (inside(parent, candidate) && !(inside(preparedRoots, candidate) && candidate !== preparedRoots)) return new ControlError('PACKAGE_ROOT_OVERLAP', 'a package root inside the supervising project would be seen by that project\'s own run; use a separate checkout or worktree, or prepare: true');
  for (const other of packages) {
    if (other.package_id === id) continue;
    if (other.root === candidate) return new ControlError('PACKAGE_ROOT_COLLISION', `package ${other.package_id} already owns this root; one root has one .loop, one state and one run`, { package_id: other.package_id, root: candidate });
    if (inside(other.root, candidate) || inside(candidate, other.root)) return new ControlError('PACKAGE_ROOT_OVERLAP', `this root and the root of package ${other.package_id} contain one another`, { package_id: other.package_id });
  }
  return null;
}

// Register one package. It never prepares a setup, approves, activates,
// authorizes or starts anything. With prepare: true an empty, inert root is
// created under .loop/scheduler/package-roots; it becomes runnable only after a
// person approved a setup for it on that root's own approval page and it was
// activated there.
export async function packageAdd(root, args = {}) {
  root = await resolveRoot(root);
  const { scheduler } = await assertControlPath(root);
  exactKeys(args, ADD_KEYS, ['package_id', 'budget'], 'args');
  const id = stringValue(args.package_id, 'package_id', { pattern: PACKAGE_ID });
  const title = args.title === undefined ? id : oneLine(stringValue(args.title, 'title', { max: 200 }));
  if (args.prepare !== undefined && typeof args.prepare !== 'boolean') throw new ControlError('INVALID_INPUT', 'prepare must be true or false');
  if ((args.workspace_root !== undefined) === (args.prepare === true)) throw new ControlError('INVALID_INPUT', 'give exactly one of workspace_root (an existing isolated project root) or prepare: true (an inert root under .loop/scheduler/package-roots)');
  const budget = budgetValue(args.budget);
  const sharedPaths = await Promise.all(sharedPathsValue(args.shared_paths).map(canonicalSharedPath));
  const resources = args.resources === undefined ? [] : stringArray(args.resources, 'resources', { max: 32, pattern: RESOURCE });
  const dependsOn = args.depends_on === undefined ? [] : stringArray(args.depends_on, 'depends_on', { max: 32, pattern: PACKAGE_ID });
  if (dependsOn.includes(id)) throw new ControlError('INVALID_DEPENDENCY', 'a package cannot depend on itself');
  const maxRetries = args.max_retries === undefined ? 2 : intValue(args.max_retries, 'max_retries', 0, 5);
  const onConflict = args.on_conflict === undefined ? 'serialize' : args.on_conflict;
  if (!['serialize', 'block'].includes(onConflict)) throw new ControlError('INVALID_INPUT', 'on_conflict must be serialize or block');

  let candidate;
  if (args.prepare === true) candidate = path.join(storePaths(scheduler).roots, id);
  else {
    if (typeof args.workspace_root !== 'string' || !path.isAbsolute(args.workspace_root)) throw new ControlError('INVALID_INPUT', 'workspace_root must be an absolute path to an existing directory');
    candidate = await resolveRoot(args.workspace_root);
  }
  await ensureRuntimeIgnore(root);
  const paths = storePaths(scheduler);
  await fs.mkdir(paths.dir, { recursive: true });
  await assertRealDirectory(scheduler, '.loop/scheduler'); await assertRealDirectory(paths.dir, '.loop/scheduler/packages');
  return withShortLock(paths.lock, 'package_add', async () => {
    const store = await readStore(root);
    const record = { schema_version: 1, package_id: id, title, root: candidate, prepared: args.prepare === true, shared_paths: sharedPaths, resources, depends_on: dependsOn, budget, max_retries: maxRetries, on_conflict: onConflict };
    const specDigest = jsonDigest(record);
    const existing = store.packages.find((item) => item.package_id === id);
    if (existing) {
      if (existing.spec_digest !== specDigest) throw new ControlError('PACKAGE_EXISTS', `package ${id} is already registered with a different root, budget, dependencies or resources; a registered package is never widened in place`, { package_id: id });
      return { ok: true, idempotent: true, package: existing, child: await childReadiness(existing.root), started: false };
    }
    const supervisorPointer = path.join(scheduler, 'supervisor', 'current.json');
    if (await schedulerRecordExists(root, supervisorPointer)) throw new ControlError('PACKAGE_SET_FROZEN', 'This supervisor package set is frozen; adding packages cannot invalidate or reset an existing job.');
    if (store.packages.length >= MAX_PACKAGES) throw new ControlError('PACKAGE_LIMIT', `at most ${MAX_PACKAGES} packages can be registered`);
    // A dependency has to exist already, so the graph can never have a cycle.
    const missing = dependsOn.filter((dep) => !store.packages.some((item) => item.package_id === dep));
    if (missing.length) throw new ControlError('INVALID_DEPENDENCY', `unknown dependency: ${missing.join(', ')}; register a package before the packages that depend on it`, { missing });
    const problem = rootProblem(root, scheduler, candidate, store.packages, id);
    if (problem) throw problem;
    if (record.prepared) {
      await fs.mkdir(paths.roots, { recursive: true, mode: 0o700 }); await assertRealDirectory(paths.roots, '.loop/scheduler/package-roots');
      try { await fs.mkdir(candidate, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if ((await fs.readdir(candidate)).length) throw new ControlError('PACKAGE_PREPARE_NOT_EMPTY', 'Prepared workspace must be empty; register an existing workspace explicitly instead');
      if (await fs.realpath(candidate) !== candidate) throw new ControlError('UNSAFE_CONTROL_PATH', 'the prepared package root resolves elsewhere');
    }
    const stored = { ...record, added_at: now(), spec_digest: specDigest };
    store.packages.push(stored);
    await saveSchedulerRecord(root, paths.file, store);
    const child = await childReadiness(candidate);
    return { ok: true, idempotent: false, package: stored, child, started: false, ...(child.next.length ? { next: child.next } : {}) };
  });
}

export async function packageList(root) {
  root = await resolveRoot(root);
  const store = await readStore(root);
  const packages = [];
  for (const record of store.packages) packages.push({ ...record, child: await childReadiness(record.root) });
  return { ok: true, packages, count: packages.length };
}

// The work item a package ran was handed over or accepted by a person. Only
// that makes it a finished dependency; a passed HANDOVER gate on its own is
// still waiting for somebody to look at it.
export async function workItemAcknowledged(childRoot, workItemId) {
  if (!workItemId || !PACKAGE_ID.test(workItemId)) return false;
  const loop = path.join(childRoot, '.loop');
  const handover = await readJson(path.join(loop, 'control', 'handovers', `${workItemId}.json`), 'handover record').catch(() => null);
  if (handover?.work_item_id === workItemId && handover.kind === 'completed-work') return true;
  const history = await fs.readdir(path.join(loop, 'history')).catch(() => []);
  for (const name of history.filter((entry) => entry.startsWith(`${workItemId}-`))) {
    const acceptance = await readJson(path.join(loop, 'history', name, 'acceptance.json'), 'acceptance').catch(() => null);
    if (acceptance?.work_item_id === workItemId) return true;
  }
  return false;
}

// What one package root looks like right now, read-only. Nothing here is run,
// approved, activated or written. Every field comes from a runner-owned or
// signed record in that root; nothing a worker wrote in prose is used.
export async function childReadiness(rootPath) {
  const out = { root: rootPath, initialized: false, activation: 'NEEDS_SETUP', activation_digest: null, host: null, review_host: null, host_config_digest: null, models: null, timeouts: null, authorization: 'NONE', authorization_expires_at: null, authorization_budget: null, work_item_id: null, run_status: null, phase: null, gates: null, round: null, held: false, quarantined: false, handover_ready: false, acknowledged: false, problems: [], next: [] };
  let root;
  try { root = await resolveRoot(rootPath); await assertControlPath(root); }
  catch (error) { return { ...out, activation: 'UNAVAILABLE', problems: [{ code: error.code || 'CHILD_ROOT_UNAVAILABLE', message: error.message }] }; }
  out.root = root;
  const loop = path.join(root, '.loop');
  const hold = await readHold(root).catch(() => ({ invalid: true }));
  out.held = Boolean(hold);
  out.quarantined = await exists(path.join(loop, 'quarantine.json'));
  const stateFile = path.join(loop, 'state.json');
  if (!await exists(stateFile)) {
    const planFile = path.join(loop, 'candidate', 'setup.plan.json');
    if (await exists(planFile)) {
      const plan = await readJson(planFile, 'setup plan').catch(() => null);
      const receiptFile = plan?.setup_digest ? path.join(loop, 'control', 'approvals', `${plan.setup_digest}.json`) : null;
      const receipt = receiptFile && await exists(receiptFile) ? await readJson(receiptFile, 'approval receipt').catch(() => null) : null;
      const trusted = receipt ? await verifyApproval(root, receipt).then(() => true, () => false) : false;
      out.activation = trusted ? 'APPROVED_NOT_ACTIVATED' : 'PENDING_APPROVAL';
      out.next.push(trusted ? `activate the approved setup in ${root}` : `a person approves the setup proposal of ${root} on that root's own local approval page`);
    } else out.next.push(`prepare a setup proposal for ${root} without running target commands, then have a person approve it on that root's own local approval page`);
    return out;
  }
  const state = await readJson(stateFile, 'state').catch(() => null);
  if (!state) { out.activation = 'INVALID'; out.problems.push({ code: 'INVALID_STATE_FILE', message: 'the package state cannot be read' }); return out; }
  out.initialized = true;
  out.work_item_id = typeof state.work_item_id === 'string' ? state.work_item_id : null;
  out.run_status = state.run_status ?? null; out.phase = state.phase ?? null; out.round = Number.isInteger(state.round) ? state.round : null;
  out.gates = PHASES.map((phase) => ({ phase, status: state.gates?.[phase]?.status ?? 'PENDING', evidence_ids: Array.isArray(state.gates?.[phase]?.evidence_ids) ? state.gates[phase].evidence_ids.map(String) : [] }));
  out.handover_ready = state.run_status === 'WAITING_FOR_HUMAN' && state.gates?.HANDOVER?.status === 'PASSED';
  out.acknowledged = await workItemAcknowledged(root, out.work_item_id);
  if (!await exists(path.join(loop, 'control', 'activation.json'))) {
    out.activation = 'LEGACY_UNMANAGED';
    out.problems.push({ code: 'CHILD_NOT_ACTIVATED', message: 'this root has no activation receipt; only a root activated through its own approval flow can be supervised' });
  } else {
    try { const binding = await verifyActivationBinding(root); out.activation = 'ACTIVE'; out.activation_digest = binding.setup_digest; }
    catch (error) { out.activation = 'INVALID'; out.problems.push({ code: error.code || 'CHILD_ACTIVATION_INVALID', message: error.message }); }
  }
  try {
    const config = await readJson(path.join(loop, 'host.local.json'), 'host.local.json');
    await verifyHostConfiguration(root, config);
    out.host = config.host; out.review_host = config.review_host; out.host_config_digest = jsonDigest(config); out.models = config.models ?? null; out.timeouts = config.timeouts ?? null;
  } catch (error) { out.problems.push({ code: error.code === 'HOST_UNTRUSTED' ? 'HOST_UNTRUSTED' : 'CHILD_HOST_UNAVAILABLE', message: error.message }); }
  const record = await readAuthorization(loop, out.work_item_id).catch(() => null);
  if (record?.invalid) out.authorization = 'INVALID';
  else if (record?.state === 'READY') out.authorization = authorizationExpired(record) ? 'EXPIRED' : 'READY';
  else if (record?.state === 'PAUSED') out.authorization = 'PAUSED';
  if (record && !record.invalid) { out.authorization_expires_at = record.expires_at ?? null; out.authorization_budget = record.budget ?? null; }
  return out;
}

// Why a package root may not be launched now. `pending` is something a person
// resolves in the ordinary way (approve, activate, authorize, release, answer);
// `blocked` needs a repair. The list is empty for a root that is activated,
// signed, READY and runnable. A root whose run already rests at a handover or
// was acknowledged is done, not blocked.
export function launchIssues(readiness) {
  const issues = [];
  const add = (kind, code, message, next) => issues.push({ kind, code, message, next });
  const where = readiness.root;
  if (readiness.activation === 'UNAVAILABLE') { add('blocked', 'CHILD_ROOT_UNAVAILABLE', readiness.problems[0]?.message ?? 'the package root is unavailable', 'restore the package root'); return issues; }
  if (readiness.held) add('pending', 'CHILD_ON_HOLD', `${where} is on hold`, `a person releases the hold of ${where} with RELEASE`);
  if (readiness.quarantined) add('blocked', 'CHILD_QUARANTINED', `${where} is quarantined`, `restore the quarantined paths of ${where}; never edit the quarantine record`);
  if (readiness.activation === 'NEEDS_SETUP') add('pending', 'CHILD_SETUP_REQUIRED', `${where} has no setup yet`, readiness.next[0]);
  if (readiness.activation === 'PENDING_APPROVAL') add('pending', 'CHILD_APPROVAL_REQUIRED', `the setup of ${where} waits for a person`, readiness.next[0]);
  if (readiness.activation === 'APPROVED_NOT_ACTIVATED') add('pending', 'CHILD_ACTIVATION_REQUIRED', `the approved setup of ${where} is not activated yet`, readiness.next[0]);
  if (readiness.activation === 'LEGACY_UNMANAGED') add('blocked', 'CHILD_NOT_ACTIVATED', readiness.problems.find((item) => item.code === 'CHILD_NOT_ACTIVATED').message, `prepare, approve and activate ${where} through its own approval flow`);
  if (readiness.activation === 'INVALID') add('blocked', 'CHILD_ACTIVATION_INVALID', readiness.problems[0]?.message ?? 'activation does not verify', `repair or rebind ${where}; a changed distribution needs rebind and a person's approval`);
  if (!readiness.initialized) return issues;
  if (!readiness.host_config_digest) add('blocked', 'CHILD_HOST_UNTRUSTED', readiness.problems.find((item) => /HOST/.test(item.code))?.message ?? 'provider configuration does not verify', `configure the provider of ${where} again locally`);
  if (readiness.handover_ready || (readiness.run_status === 'COMPLETED' && readiness.acknowledged)) return issues;
  const item = readiness.work_item_id;
  if (readiness.authorization === 'NONE' || readiness.authorization === 'PAUSED') add('pending', 'CHILD_AUTHORIZATION_REQUIRED', `${item} in ${where} has no READY authorization`, `a person authorizes ${item} in ${where} (AUTHORIZE on that root's confirmation page or terminal)`);
  if (readiness.authorization === 'EXPIRED') add('pending', 'CHILD_AUTHORIZATION_EXPIRED', `the authorization of ${item} in ${where} expired at ${readiness.authorization_expires_at}`, `a person authorizes ${item} in ${where} again`);
  if (readiness.authorization === 'INVALID') add('blocked', 'CHILD_AUTHORIZATION_INVALID', `the authorization record of ${item} in ${where} does not validate`, `ask a person to issue a valid authorization in ${where}`);
  if (readiness.run_status === 'BLOCKED') add('pending', 'CHILD_BLOCKED', `${item} in ${where} is BLOCKED`, `read the evidence and answer the blockers of ${where}, then resume the supervisor`);
  else if (readiness.run_status === 'CANCELLED') add('pending', 'CHILD_CANCELLED', `${item} in ${where} was cancelled`, `acknowledge the cancellation in ${where} and prepare a new work item`);
  else if (readiness.run_status === 'COMPLETED') add('pending', 'CHILD_COMPLETED_UNACKNOWLEDGED', `${item} in ${where} is COMPLETED without a recorded handover`, `prepare and authorize the next work item in ${where}`);
  else if (!['PAUSED', 'RUNNING'].includes(readiness.run_status) && !handoverNodePending({ run_status: readiness.run_status, phase: readiness.phase, gates: Object.fromEntries((readiness.gates || []).map((gate) => [gate.phase, gate])) })) add('pending', 'CHILD_WAITING', `${item} in ${where} is ${readiness.run_status}`, `look at ${where}`);
  return issues;
}

export function assertPlainArgs(args) { assertPlain(args, 'args'); return args; }
