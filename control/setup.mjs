import { validateKind, workKinds } from './loop-options.mjs';
import { signHostConfiguration, verifyApproval } from './approval-store.mjs';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ControlError, acquireDirLock, assertControlPath, atomicJson, atomicText, effectivePath, ensureRuntimeIgnore, exactKeys, exists, intValue, jsonDigest, nonce, now,
  readJson, safeRelativeArray, sha256, stringArray, stringValue,
} from './common.mjs';
import { validateAdapter, validateNegative } from './schemas.mjs';

export const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowSource = path.join(bundleRoot, 'core', 'workflow.json');
const evidenceKinds = ['acceptance', 'command', 'artifact', 'behavior', 'contract', 'installation', 'package', 'documentation', 'link-check'];

async function lstatOrNull(file) { return fs.lstat(file).catch(() => null); }

async function boundedInventory(root, maxFiles = 256, maxDepth = 4) {
  const files = []; const symlinks = []; let observed = 0; let truncated = false;
  async function walk(directory, relative, depth) {
    if (truncated) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!relative && ['.git', '.loop'].includes(entry.name)) continue;
      observed += 1;
      if (observed > maxFiles) { truncated = true; return; }
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) symlinks.push(rel);
      else if (entry.isFile()) files.push(rel);
      else if (entry.isDirectory() && depth + 1 < maxDepth) await walk(path.join(directory, entry.name), rel, depth + 1);
    }
  }
  await walk(root, '', 0);
  return { read_only: true, max_files: maxFiles, max_depth: maxDepth, entries_observed: observed, files_considered: files, symlinks_skipped: symlinks, truncated };
}

function firstByBase(files, base) { return files.find((file) => path.posix.basename(file) === base); }
function directoryOf(file) { const dir = path.posix.dirname(file); return dir === '' ? '.' : dir; }

export async function inspectProject(root) {
  const { loop } = await assertControlPath(root);
  const scan = await boundedInventory(root);
  const active = path.join(loop, 'project.adapter.json');
  const candidate = path.join(loop, 'candidate', 'project.adapter.json');
  let existingAdapter = null; let adapterSource = null; let adapterError = null;
  for (const [source, file] of [['active', active], ['candidate', candidate]]) {
    if (!await exists(file)) continue;
    try { existingAdapter = validateAdapter(await readJson(file), `${source} adapter`); adapterSource = source; break; }
    catch (error) { adapterError = { source, code: error.code || 'INVALID_ADAPTER', message: error.message }; }
  }
  let recommendation = null;
  if (existingAdapter) recommendation = structuredClone(existingAdapter);
  else {
    const py = firstByBase(scan.files_considered, 'pyproject.toml') || firstByBase(scan.files_considered, 'requirements.txt');
    const pkg = firstByBase(scan.files_considered, 'package.json');
    const gomod = firstByBase(scan.files_considered, 'go.mod');
    const cargo = firstByBase(scan.files_considered, 'Cargo.toml');
    const docsCheck = scan.files_considered.find((file) => file === 'tests/check-docs.sh' || file.endsWith('/tests/check-docs.sh'));
    let details = null;
    if (docsCheck && scan.files_considered.some((file) => file.startsWith(`${directoryOf(docsCheck) === '.' ? '' : `${directoryOf(docsCheck)}/`}docs/`))) {
      const cwd = docsCheck.endsWith('/tests/check-docs.sh') ? docsCheck.slice(0, -'/tests/check-docs.sh'.length) || '.' : '.';
      const artifact = scan.files_considered.find((file) => file.startsWith(`${cwd === '.' ? '' : `${cwd}/`}docs/`));
      details = { kind: 'docs', languages: [], runtimes: ['sh'], artifact: { id: 'documentation', kind: 'document-set', paths: [artifact] }, argv: ['tests/check-docs.sh'], cwd, evidence: ['command', 'documentation', 'link-check'], confidence: 'high' };
    } else if (gomod) details = { kind: 'other', languages: ['Go'], runtimes: ['go'], artifact: { id: 'module', kind: 'package', paths: [gomod] }, argv: ['go', 'test', './...'], cwd: directoryOf(gomod), evidence: ['command', 'behavior'], confidence: 'high' };
    else if (cargo) details = { kind: 'other', languages: ['Rust'], runtimes: ['cargo'], artifact: { id: 'package', kind: 'package', paths: [cargo] }, argv: ['cargo', 'test'], cwd: directoryOf(cargo), evidence: ['command', 'behavior'], confidence: 'high' };
    else if (pkg) {
      let hasTest = false;
      try { const p = await readJson(path.join(root, pkg), 'package.json'); hasTest = typeof p.scripts?.test === 'string' && p.scripts.test.trim() !== ''; } catch {}
      if (hasTest) details = { kind: 'other', languages: ['JavaScript'], runtimes: ['node'], artifact: { id: 'package', kind: 'package', paths: [pkg] }, argv: ['npm', 'test'], cwd: directoryOf(pkg), evidence: ['command', 'behavior'], confidence: 'medium' };
    } else if (py && scan.files_considered.some((file) => file.includes('tests/'))) {
      details = { kind: 'cli', languages: ['Python'], runtimes: ['python3'], artifact: { id: 'python-project', kind: 'package', paths: [py] }, argv: ['python3', '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-q'], cwd: directoryOf(py), evidence: ['command', 'behavior'], confidence: 'medium' };
    }
    if (details) {
      const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+|-+$/g, '') || 'project';
      recommendation = {
        schema_version: 1, adapter_id: `${slug.slice(0, 48)}-loop`, project_kind: details.kind,
        target: { languages: details.languages, runtimes: details.runtimes, platforms: [] }, artifacts: [details.artifact],
        commands: ['EXECUTE', 'VALIDATE'].map((phase) => ({ id: `verify-${phase.toLowerCase()}`, phase, cwd: details.cwd, argv: details.argv, timeout_seconds: 900, evidence_types: details.evidence })),
        validation: { required_evidence: details.evidence }, protected_paths: ['.loop/**', ...(py || pkg || gomod || cargo ? [py || pkg || gomod || cargo] : [])], environment: { allow_names: ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'] },
        _recommendation: { confidence: details.confidence, commands_discovered_only: true },
      };
    }
  }
  const missing = [];
  if (!recommendation) missing.push('adapter or a recognized project manifest and verifier');
  else if (!existingAdapter && recommendation.target.platforms.length === 0) missing.push('adapter_overrides.platforms');
  if (!existingAdapter) missing.push('negative_control with exact expected exit code and output');
  missing.push('request', 'acceptance_criteria', 'out_of_scope', 'allowed_paths');
  return { ok: true, initialized: await exists(active), adapter_source: adapterSource, adapter_error: adapterError, scan, recommendation, missing_inputs: [...new Set(missing)] };
}

function applyOverrides(adapter, overrides = {}) {
  const clean = structuredClone(adapter);
  delete clean._recommendation;
  if (overrides.platforms) clean.target.platforms = overrides.platforms;
  if (overrides.protected_paths) clean.protected_paths = overrides.protected_paths;
  if (overrides.commands) clean.commands = overrides.commands;
  if (overrides.artifacts) clean.artifacts = overrides.artifacts;
  if (overrides.required_evidence) clean.validation.required_evidence = overrides.required_evidence;
  return clean;
}

function gates() {
  return Object.fromEntries(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER'].map((phase) => [phase, { status: 'PENDING', evidence_ids: [] }]));
}

const quoteBlock = (value) => value.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
const oneLine = (value) => value.replace(/[\r\n]+/g, ' ').trim();

function workItem({ id, request, acceptance_criteria, out_of_scope, allowed_paths, frozen_paths = [], work_kind = 'feature' }) {
  const title = request.split(/\r?\n/, 1)[0].slice(0, 120);
  return `# ${id}: ${oneLine(title)}\n\nKind: ${validateKind(work_kind)}\n\n## Outcome\n\n${quoteBlock(request)}\n\n## Acceptance criteria\n\n${acceptance_criteria.map((item, i) => `- AC-${i + 1}: ${oneLine(item)}`).join('\n')}\n\n## Out of scope\n\n${out_of_scope.map((item) => `- ${oneLine(item)}`).join('\n')}\n\n## Constraints and invariants\n\n- Follow the project adapter and universal loop contract.\n- ${workKinds[validateKind(work_kind)].guidance}\n\n## Design\n\n## Execution slices\n\n| Slice | Allowed paths | Frozen paths | Verifier IDs | Proof |\n|---|---|---|---|---|\n| 1 | ${allowed_paths.map((item) => `\`${item}\``).join(', ')} | ${frozen_paths.map((item) => `\`${item}\``).join(', ') || 'none'} | configured adapter commands | configured runner evidence |\n\n## Independent review\n\n## Validation\n\n## Handover\n`;
}

export async function distributionHashes() {
  const names = ['VERSION', 'core/CONTRACT.md', 'core/WORKFLOW.md', 'core/workflow.json', 'spec/schemas/project-adapter.schema.json', 'spec/schemas/state.schema.json'];
  async function collect(directory, prefix = directory) {
    const absolute = path.join(bundleRoot, directory); if (!await exists(absolute)) return;
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await collect(path.join(directory, entry.name), rel);
      else if (entry.isFile() && /\.(?:mjs|js|sh|json)$/.test(entry.name)) names.push(rel);
    }
  }
  for (const directory of ['control', 'bin', 'engine', 'hosts']) await collect(directory);
  names.sort();
  const hashes = {};
  for (const name of names) hashes[name] = sha256(await fs.readFile(path.join(bundleRoot, name)));
  return hashes;
}

async function validateCopiedSymlink(root, source) {
  const link = await fs.readlink(source); const destination = await fs.realpath(source).catch(() => null);
  const targetRel = destination ? path.relative(root, destination) : '..';
  if (path.isAbsolute(link) || path.isAbsolute(targetRel) || targetRel === '..' || targetRel.startsWith(`..${path.sep}`) || ['.git', '.loop'].some(dir => targetRel === dir || targetRel.startsWith(`${dir}${path.sep}`))) throw new ControlError('UNSAFE_PROBE_SYMLINK', 'probe symlink must resolve within copied project inputs');
}

async function sourceManifest(root) {
  const records = [];
  async function walk(dir, rel = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!rel && ['.git', '.loop'].includes(entry.name)) continue;
      const itemRel = rel ? `${rel}/${entry.name}` : entry.name; const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) records.push({ path: itemRel, kind: 'symlink', target: await fs.readlink(abs) });
      else if (entry.isDirectory()) await walk(abs, itemRel);
      else if (entry.isFile()) { const stat = await fs.stat(abs); records.push({ path: itemRel, kind: 'file', mode: stat.mode & 0o777, sha256: sha256(await fs.readFile(abs)) }); }
    }
  }
  await walk(root); return { files: records, digest: jsonDigest(records) };
}

export async function prepareProject(root, args) {
  const { loop, control } = await assertControlPath(root);
  if (await exists(path.join(loop, 'state.json'))) throw new ControlError('ALREADY_INITIALIZED', 'active loop already exists; use task after handover');
  const replacing = await exists(path.join(loop, 'candidate'));
  if (replacing && args.replace_candidate !== true) throw new ControlError('CANDIDATE_EXISTS', 'a setup candidate already exists; pass replace_candidate:true to archive it and prepare a new candidate');
  stringValue(args.request, 'request', { max: 20000 });
  stringArray(args.acceptance_criteria, 'acceptance_criteria', { min: 1 }); stringArray(args.out_of_scope, 'out_of_scope', { min: 1 });
  safeRelativeArray(args.allowed_paths, 'allowed_paths', 1); safeRelativeArray(args.frozen_paths || [], 'frozen_paths'); validateNegative(args.negative_control);
  if (args.adapter_overrides) exactKeys(args.adapter_overrides, ['platforms', 'protected_paths', 'commands', 'artifacts', 'required_evidence'], [], 'adapter_overrides');
  if (args.max_rounds !== undefined) intValue(args.max_rounds, 'max_rounds', 6, 500);
  if (args.max_gate_failures !== undefined) intValue(args.max_gate_failures, 'max_gate_failures', 1, 20);
  if (args.max_wall_seconds !== undefined) intValue(args.max_wall_seconds, 'max_wall_seconds', 60, 604800);
  if (args.autonomy !== undefined && !['supervised', 'guarded', 'autonomous'].includes(args.autonomy)) throw new ControlError('INVALID_INPUT', 'autonomy is invalid');
  if (args.replace_candidate !== undefined && typeof args.replace_candidate !== 'boolean') throw new ControlError('INVALID_INPUT', 'replace_candidate must be boolean');
  let adapter = args.adapter;
  let adapterSource = 'explicit';
  if (!adapter) {
    const inspection = await inspectProject(root);
    if (!inspection.recommendation) throw new ControlError('MISSING_INPUT', 'no complete adapter can be recommended', { missing_inputs: inspection.missing_inputs });
    adapter = applyOverrides(inspection.recommendation, args.adapter_overrides || {}); adapterSource = inspection.adapter_source ? `existing-${inspection.adapter_source}` : 'accepted-recommendation-with-overrides';
  } else if (args.adapter_overrides) adapter = applyOverrides(adapter, args.adapter_overrides);
  validateAdapter(adapter);
  const id = args.work_item_id || 'WI-001'; stringValue(id, 'work_item_id', { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ });
  const created = now(); const workflow = await readJson(workflowSource, 'bundled workflow');
  const state = { schema_version: 1, work_item_id: id, phase: 'DEFINE', run_status: 'PAUSED', step: 'bootstrap-confirmation', round: 0, max_rounds: args.max_rounds || 40, gate_failures_here: 0, max_gate_failures: args.max_gate_failures || 3, autonomy: args.autonomy || 'supervised', started_epoch: 0, max_wall_seconds: args.max_wall_seconds || 14400, gates: gates(), last_result: 'Candidate generated; not activated.', next_action: 'Request human setup approval, then activate through disposable positive and negative probes.', updated_at: created };
  const work = workItem({ id, ...args, frozen_paths: args.frozen_paths || [] });
  const source = await sourceManifest(root);
  const sourceSymlinks = source.files.filter((item) => item.kind === 'symlink').map((item) => item.path);
  for (const link of sourceSymlinks) await validateCopiedSymlink(root, path.join(root, link));
  const distribution = await distributionHashes();
  const configHashes = { adapter_sha256: jsonDigest(adapter), workflow_sha256: jsonDigest(workflow), state_sha256: jsonDigest(state), work_item_sha256: sha256(work), negative_control_sha256: jsonDigest(args.negative_control) };
  const setupDigest = jsonDigest({ source_digest: source.digest, distribution, configHashes });
  const candidate = path.join(loop, 'candidate');
  if (replacing) { const archived = path.join(control, 'abandoned-candidates', `${Date.now()}-${nonce(5)}`); await fs.mkdir(path.dirname(archived), { recursive: true }); await fs.rename(candidate, archived); }
  await ensureRuntimeIgnore(root);
  await fs.mkdir(path.join(candidate, 'work-items'), { recursive: true }); await fs.mkdir(control, { recursive: true });
  await atomicJson(path.join(candidate, 'project.adapter.json'), adapter); await atomicJson(path.join(candidate, 'state.json'), state);
  await atomicJson(path.join(candidate, 'workflow.json'), workflow); await atomicText(path.join(candidate, 'work-items', `${id}.md`), work);
  await atomicJson(path.join(candidate, 'setup.plan.json'), { schema_version: 1, setup_digest: setupDigest, created_at: created, adapter_source: adapterSource, source, distribution, config_hashes: configHashes, negative_control: args.negative_control, requested_scope: { request: args.request, acceptance_criteria: args.acceptance_criteria, out_of_scope: args.out_of_scope, allowed_paths: args.allowed_paths, frozen_paths: args.frozen_paths || [] }, approval_status: 'PENDING' });
  return { ok: true, status: 'PAUSED', candidate: '.loop/candidate', setup_digest: setupDigest, approval_required: true, next: 'request_approval' };
}

// Re-activation after the build-loop package itself changed. The activation
// record binds the package files it was approved with (distributionHashes), so an
// update makes every start fail with DISTRIBUTION_CHANGED. A rebind plan keeps
// the active adapter, workflow, state and work items exactly as they are and
// binds them to the current package: the human reviews the changed package
// files, the same disposable probes run again, and only activation.json is
// rewritten.
function distributionChanges(previous, current) {
  const names = new Set([...Object.keys(previous || {}), ...Object.keys(current)]);
  const changes = { added: [], removed: [], changed: [] };
  for (const name of [...names].sort()) {
    if (!(name in (previous || {}))) changes.added.push(name);
    else if (!(name in current)) changes.removed.push(name);
    else if (previous[name] !== current[name]) changes.changed.push(name);
  }
  return changes;
}

async function rebindInputs(root, negativeControl) {
  const { loop, control } = await assertControlPath(root);
  if (!await exists(path.join(loop, 'state.json'))) throw new ControlError('NOT_INITIALIZED', 'rebind needs an initialized project; use prepare for a first setup');
  const activationFile = path.join(control, 'activation.json');
  if (!await exists(activationFile)) throw new ControlError('NOT_MANAGED', 'rebind needs a managed activation record');
  const activation = await readJson(activationFile, 'activation receipt');
  const adapterBytes = await fs.readFile(path.join(loop, 'project.adapter.json')); const workflowBytes = await fs.readFile(path.join(loop, 'workflow.json'));
  if (sha256(adapterBytes) !== activation.adapter_file_sha256 || sha256(workflowBytes) !== activation.workflow_file_sha256) throw new ControlError('ACTIVATION_BINDING_CHANGED', 'active adapter or workflow no longer matches approved activation; rebind cannot repair that');
  const adapter = JSON.parse(adapterBytes.toString('utf8')); validateAdapter(adapter);
  const workflow = JSON.parse(workflowBytes.toString('utf8'));
  if (jsonDigest(workflow) !== jsonDigest(await readJson(workflowSource, 'bundled workflow'))) throw new ControlError('WORKFLOW_CHANGED', 'the bundled workflow changed; finish the current work item and set the project up again');
  validateNegative(negativeControl);
  const state = await readJson(path.join(loop, 'state.json'), 'state');
  const source = await sourceManifest(root);
  for (const link of source.files.filter((item) => item.kind === 'symlink').map((item) => item.path)) await validateCopiedSymlink(root, path.join(root, link));
  const distribution = await distributionHashes();
  const configHashes = { kind: 'rebind', previous_setup_digest: activation.setup_digest, adapter_file_sha256: activation.adapter_file_sha256, workflow_file_sha256: activation.workflow_file_sha256, negative_control_sha256: jsonDigest(negativeControl) };
  const digest = jsonDigest({ source_digest: source.digest, distribution, configHashes });
  return { digest, source, distribution, configHashes, adapter, workflow, state, activation, rebind: true };
}

export async function prepareRebind(root, args) {
  const { loop, control } = await assertControlPath(root);
  exactKeys(args, ['negative_control'], ['negative_control'], 'rebind');
  const current = await rebindInputs(root, args.negative_control);
  if (current.state.run_status === 'RUNNING') throw new ControlError('RUN_ACTIVE', 'pause or cancel the running work item before rebinding');
  if (jsonDigest(current.distribution) === jsonDigest(current.activation.distribution)) throw new ControlError('DISTRIBUTION_UNCHANGED', 'the build-loop package matches the activation; nothing to rebind');
  const changes = distributionChanges(current.activation.distribution, current.distribution);
  const version = (await fs.readFile(path.join(bundleRoot, 'VERSION'), 'utf8')).trim();
  const candidate = path.join(loop, 'candidate');
  if (await exists(candidate)) { const archived = path.join(control, 'abandoned-candidates', `${Date.now()}-${nonce(5)}`); await fs.mkdir(path.dirname(archived), { recursive: true }); await fs.rename(candidate, archived); }
  await ensureRuntimeIgnore(root); await fs.mkdir(candidate, { recursive: true });
  await atomicJson(path.join(candidate, 'setup.plan.json'), { schema_version: 1, kind: 'rebind', setup_digest: current.digest, created_at: now(), previous_setup_digest: current.activation.setup_digest, package_version: version, distribution_changes: changes, source: current.source, distribution: current.distribution, config_hashes: current.configHashes, negative_control: args.negative_control, approval_status: 'PENDING' });
  return { ok: true, status: current.state.run_status, kind: 'rebind', candidate: '.loop/candidate', setup_digest: current.digest, package_version: version, distribution_changes: changes, approval_required: true, next: 'request_approval' };
}

function matchOutput(output, expectation) {
  const source = expectation.stream === 'stdout' ? output.stdout : expectation.stream === 'stderr' ? output.stderr : `${output.stdout}${output.stderr}`;
  if (expectation.match === 'equals') return source === expectation.value;
  if (expectation.match === 'includes') return source.includes(expectation.value);
  throw new ControlError('INVALID_OUTPUT_MATCH', 'negative output matching supports equals or includes');
}

export async function runBounded(argv, cwd, seconds, envNames = ['PATH'], isolatedRoot = null, extraEnv = null) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(envNames.filter((name) => Object.hasOwn(process.env, name)).map((name) => [name, process.env[name]]));
    if (envNames.includes('PATH')) env.PATH = effectivePath();
    if (isolatedRoot) {
      env.HOME = path.join(isolatedRoot, 'home');
      env.TMPDIR = path.join(isolatedRoot, 'tmp');
    }
    // Loop identifiers a bounded child needs. They never widen the environment
    // beyond the allowed names plus the isolated home and temporary directory.
    if (extraEnv) Object.assign(env, extraEnv);
    let stdout = '', stderr = '', timedOut = false, settled = false, timer, killTimer;
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code, signal, error) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer);
      child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error); else resolve({ exit_code: timedOut ? 124 : code, signal, timed_out: timedOut, stdout, stderr });
    };
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(0, 131072); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 131072); });
    child.on('error', error => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal));
    const target = () => process.platform === 'win32' ? child.pid : -child.pid;
    timer = setTimeout(() => {
      timedOut = true; try { process.kill(target(), 'SIGTERM'); } catch {}
      killTimer = setTimeout(() => {
        try { process.kill(target(), 'SIGKILL'); } catch {}
        // A detached descendant may keep inherited pipes open. It must not
        // extend this operation beyond its approved deadline.
        finish(124, 'SIGKILL');
      }, 500);
    }, seconds * 1000);
  });
}

async function verifyCurrentPlan(root, plan) {
  if (plan.kind === 'rebind') return await rebindInputs(root, plan.negative_control);
  const source = await sourceManifest(root); const distribution = await distributionHashes();
  const adapter = await readJson(path.join(root, '.loop', 'candidate', 'project.adapter.json'));
  validateAdapter(adapter); validateNegative(plan.negative_control);
  const state = await readJson(path.join(root, '.loop', 'candidate', 'state.json'));
  stringValue(state.work_item_id, 'work_item_id', { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ });
  const workflow = await readJson(path.join(root, '.loop', 'candidate', 'workflow.json'));
  if (jsonDigest(workflow) !== jsonDigest(await readJson(workflowSource))) throw new ControlError('INVALID_WORKFLOW', 'candidate must use the fixed bundled workflow');
  const stateValidation = await runBounded(['bash', '-c', 'source "$1"; loop_validate_state "$2"', 'validate-state', path.join(bundleRoot, 'engine', 'common.sh'), path.join(root, '.loop', 'candidate', 'state.json')], bundleRoot, 5);
  if (stateValidation.exit_code !== 0 || state.run_status !== 'PAUSED' || state.phase !== 'DEFINE' || state.round !== 0 || state.started_epoch !== 0 || Object.values(state.gates).some(gate => gate.status !== 'PENDING' || gate.evidence_ids.length)) throw new ControlError('INVALID_CANDIDATE_STATE', 'candidate must contain a valid untouched PAUSED DEFINE state');
  const workFile = path.join(root, '.loop', 'candidate', 'work-items', `${state.work_item_id}.md`); const work = await fs.readFile(workFile, 'utf8');
  const configHashes = { adapter_sha256: jsonDigest(adapter), workflow_sha256: jsonDigest(workflow), state_sha256: jsonDigest(state), work_item_sha256: sha256(work), negative_control_sha256: jsonDigest(plan.negative_control) };
  const digest = jsonDigest({ source_digest: source.digest, distribution, configHashes });
  return { digest, source, distribution, configHashes, adapter, state, workflow, work, workFile };
}

// The containment every disposable run shares: project inputs are copied
// without the repository history and without the loop's own control directory,
// symlinks may not point out of the copy, and the run gets its own home and
// temporary directory inside the copy. Activation probes and the scout both
// use it; neither ever touches the real project.
export async function copyDisposableProject(root, temp) {
  await fs.cp(root, temp, { recursive: true, verbatimSymlinks: true, filter: async (source) => { const rel = path.relative(root, source).replaceAll(path.sep, '/'); if (rel === '.git' || rel.startsWith('.git/') || rel === '.loop') return false; if ((await fs.lstat(source)).isSymbolicLink()) await validateCopiedSymlink(root, source); return true; } });
  const isolatedRoot = path.join(temp, '.loop-probe-runtime');
  await fs.mkdir(path.join(isolatedRoot, 'home'), { recursive: true });
  await fs.mkdir(path.join(isolatedRoot, 'tmp'), { recursive: true });
  return isolatedRoot;
}

async function assertProbeBoundary(copyRoot, command) {
  const cwd = await fs.realpath(path.join(copyRoot, command.cwd)).catch(() => null);
  if (!cwd || !(cwd === copyRoot || cwd.startsWith(`${copyRoot}${path.sep}`))) throw new ControlError('UNSAFE_PROBE_CWD', `probe cwd escapes disposable copy: ${command.cwd}`);
  if (command.argv[0].includes('/')) {
    const rawExecutable = path.isAbsolute(command.argv[0]) ? command.argv[0] : path.join(cwd, command.argv[0]);
    const executableStat = await fs.lstat(rawExecutable).catch(() => null); const executable = await fs.realpath(rawExecutable).catch(() => null);
    if (!executableStat || executableStat.isSymbolicLink() || (!path.isAbsolute(command.argv[0]) && (!executable || !executable.startsWith(`${copyRoot}${path.sep}`)))) throw new ControlError('UNSAFE_PROBE_EXECUTABLE', `probe executable is missing, symlinked, or escapes the disposable copy: ${command.argv[0]}`);
  }
  return cwd;
}

export async function activateProject(root) {
  const { control } = await assertControlPath(root);
  const release = await acquireDirLock(path.join(control, 'activation.lock'), { operation: 'activate' });
  try { return await activateLocked(root); } finally { await release(); }
}

async function activateLocked(root) {
  const { loop, control } = await assertControlPath(root); const candidate = path.join(loop, 'candidate');
  const plan = await readJson(path.join(candidate, 'setup.plan.json'), 'setup plan');
  const current = await verifyCurrentPlan(root, plan);
  if (current.digest !== plan.setup_digest) throw new ControlError('SETUP_CHANGED', 'source or setup plan changed after preparation; prepare and approve the exact new plan', { expected: plan.setup_digest, actual: current.digest });
  const receiptFile = path.join(control, 'approvals', `${plan.setup_digest}.json`);
  const receipt = await readJson(receiptFile, 'approval receipt').catch((error) => { if (error.code === 'INVALID_JSON' && error.details?.cause?.includes('ENOENT')) throw new ControlError('APPROVAL_REQUIRED', 'no trusted approval receipt exists for the current setup digest'); throw error; });
  await verifyApproval(root, receipt);
  if (receipt.setup_digest !== plan.setup_digest || receipt.decision !== 'APPROVE' || !['local-http-user', 'interactive-tty'].includes(receipt.channel)) throw new ControlError('APPROVAL_INVALID', 'approval receipt is not valid for this setup digest');
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'build-loop-activation-')));
  const evidence = { schema_version: 1, setup_digest: plan.setup_digest, approval_id: receipt.approval_id, started_at: now(), disposable_root: path.basename(temp), containment: { disposable_copy: true, clean_environment: true, isolated_home_and_tmp: true, network_isolation: false, os_sandbox: false }, positive: [], negative: null, status: 'FAILED' };
  try {
    const isolatedRoot = await copyDisposableProject(root, temp);
    for (const command of current.adapter.commands) {
      const cwd = await assertProbeBoundary(temp, command); const result = await runBounded(command.argv, cwd, command.timeout_seconds, current.adapter.environment.allow_names, isolatedRoot);
      evidence.positive.push({ id: command.id, phase: command.phase, argv: command.argv, cwd: command.cwd, exit_code: result.exit_code, timed_out: result.timed_out, stdout_sha256: sha256(result.stdout), stderr_sha256: sha256(result.stderr), passed: result.exit_code === 0 });
      if (result.exit_code !== 0) throw new ControlError('POSITIVE_PROBE_FAILED', `positive probe failed: ${command.id}`, { command_id: command.id, exit_code: result.exit_code });
    }
    const negative = plan.negative_control; const negativeCwd = await assertProbeBoundary(temp, negative); const result = await runBounded(negative.argv, negativeCwd, negative.timeout_seconds, current.adapter.environment.allow_names, isolatedRoot);
    const outputMatched = matchOutput(result, negative.expected_output);
    evidence.negative = { argv: negative.argv, cwd: negative.cwd, exit_code: result.exit_code, expected_exit_code: negative.expected_exit_code, timed_out: result.timed_out, output_matched: outputMatched, stdout_sha256: sha256(result.stdout), stderr_sha256: sha256(result.stderr), passed: result.exit_code === negative.expected_exit_code && outputMatched };
    if (!evidence.negative.passed) throw new ControlError('NEGATIVE_CONTROL_FAILED', 'negative control did not match its exact expected exit code and output', { exit_code: result.exit_code, expected_exit_code: negative.expected_exit_code, output_matched: outputMatched });
    const afterProbe = await verifyCurrentPlan(root, plan);
    if (afterProbe.digest !== current.digest) throw new ControlError('TARGET_CHANGED_DURING_PROBE', 'the real target, candidate, or control distribution changed while disposable probes ran');
    evidence.target_unchanged = true; evidence.status = 'PASSED'; evidence.finished_at = now();
    await atomicJson(path.join(control, 'setup-evidence', `${plan.setup_digest}.json`), evidence);
    if (current.rebind) {
      const state = await readJson(path.join(loop, 'state.json'), 'state');
      if (state.run_status === 'RUNNING') throw new ControlError('RUN_ACTIVE', 'a run started while rebind probes ran');
      await atomicJson(path.join(control, 'activation.json'), { schema_version: 1, setup_digest: plan.setup_digest, activated_at: now(), distribution: current.distribution, adapter_sha256: jsonDigest(current.adapter), workflow_sha256: jsonDigest(current.workflow), adapter_file_sha256: current.configHashes.adapter_file_sha256, workflow_file_sha256: current.configHashes.workflow_file_sha256, setup_evidence: `.loop/control/setup-evidence/${plan.setup_digest}.json`, rebound_from: plan.previous_setup_digest });
      return { ok: true, activated: true, rebind: true, setup_digest: plan.setup_digest, previous_setup_digest: plan.previous_setup_digest, status: state.run_status, evidence: `.loop/control/setup-evidence/${plan.setup_digest}.json` };
    }
    if (await exists(path.join(loop, 'state.json'))) throw new ControlError('ALREADY_INITIALIZED', 'active state appeared during activation');
    await fs.mkdir(path.join(loop, 'work-items'), { recursive: true });
    await atomicJson(path.join(loop, 'project.adapter.json'), current.adapter);
    await atomicJson(path.join(loop, 'workflow.json'), current.workflow); await atomicText(path.join(loop, 'work-items', `${current.state.work_item_id}.md`), current.work);
    await atomicJson(path.join(control, 'activation.json'), { schema_version: 1, setup_digest: plan.setup_digest, activated_at: now(), distribution: current.distribution, adapter_sha256: current.configHashes.adapter_sha256, workflow_sha256: current.configHashes.workflow_sha256, adapter_file_sha256: sha256(await fs.readFile(path.join(loop, 'project.adapter.json'))), workflow_file_sha256: sha256(await fs.readFile(path.join(loop, 'workflow.json'))), setup_evidence: `.loop/control/setup-evidence/${plan.setup_digest}.json` });
    const stateTemp = path.join(loop, `.state-${nonce(8)}.tmp`);
    await atomicJson(stateTemp, current.state);
    try { await fs.link(stateTemp, path.join(loop, 'state.json')); } finally { await fs.rm(stateTemp, { force: true }); }
    return { ok: true, activated: true, setup_digest: plan.setup_digest, status: 'PAUSED', evidence: `.loop/control/setup-evidence/${plan.setup_digest}.json` };
  } catch (error) {
    evidence.finished_at = now(); evidence.failure = { code: error.code || 'PROBE_ERROR', message: error.message };
    await atomicJson(path.join(control, 'setup-evidence', `${plan.setup_digest}.${Date.now()}.failed.json`), evidence);
    throw error;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

export async function createDemo(root, kind) {
  const marker = path.join(root, '.loop-demo.json');
  const entries = (await fs.readdir(root)).filter((name) => name !== '.DS_Store');
  if (entries.length && !(entries.length === 1 && entries[0] === '.loop-demo.json')) throw new ControlError('DEMO_ROOT_NOT_EMPTY', 'demo requires an empty selected directory');
  if (kind === 'docs') {
    await fs.mkdir(path.join(root, 'docs'), { recursive: true }); await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await atomicText(path.join(root, 'docs', 'guide.md'), '# Demo guide\n\nThe build loop demo is ready.\n');
    await atomicText(path.join(root, 'tests', 'invalid-guide.md'), 'This fixture deliberately has no heading.\n');
    await atomicText(path.join(root, 'tests', 'check-docs.mjs'), `import fs from 'node:fs';\nconst file=process.argv[2]||'docs/guide.md';\nconst text=fs.readFileSync(file,'utf8');\nif(!text.startsWith('# ')){console.error('DOCS_HEADING_MISSING');process.exit(42)}\nconsole.log('DOCS_OK');\n`);
  } else {
    await fs.mkdir(path.join(root, 'src'), { recursive: true }); await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await atomicText(path.join(root, 'src', 'greet.py'), `def greeting(name: str) -> str:\n    return f"Hello, {name}!"\n`);
    await atomicText(path.join(root, 'tests', 'test_greet.py'), `import pathlib\nimport sys\nimport unittest\n\nsys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "src"))\nfrom greet import greeting\n\nif "--invalid-expectation" in sys.argv:\n    if greeting("Loop") != "Wrong":\n        print("GREETING_EXPECTATION_MISMATCH", file=sys.stderr)\n        raise SystemExit(42)\n\nclass TestGreeting(unittest.TestCase):\n    def test_greeting(self):\n        self.assertEqual(greeting("Loop"), "Hello, Loop!")\n\nif __name__ == "__main__":\n    unittest.main()\n`);
  }
  await atomicJson(marker, { schema_version: 1, kind, created_at: now() });
  const testPath = kind === 'docs' ? 'tests/check-docs.mjs' : 'tests/test_greet.py'; const artifactPath = kind === 'docs' ? 'docs/guide.md' : 'src/greet.py';
  const evidence = kind === 'docs' ? ['command', 'documentation'] : ['command', 'behavior'];
  const runtime = kind === 'docs' ? 'node' : 'python3';
  const positiveArgv = kind === 'docs' ? [runtime, testPath] : [runtime, '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-q'];
  const negativeArgv = kind === 'docs' ? [runtime, testPath, 'tests/invalid-guide.md'] : [runtime, '-B', testPath, '--invalid-expectation'];
  const negativeMessage = kind === 'docs' ? 'DOCS_HEADING_MISSING' : 'GREETING_EXPECTATION_MISMATCH';
  const frozen = kind === 'docs' ? [testPath, 'tests/invalid-guide.md'] : [testPath];
  const adapter = { schema_version: 1, adapter_id: `demo-${kind}`, project_kind: kind === 'docs' ? 'docs' : 'cli', target: { languages: kind === 'docs' ? ['Markdown'] : ['Python'], runtimes: [kind === 'docs' ? 'node>=22' : 'python3'], platforms: [process.platform] }, artifacts: [{ id: 'demo-artifact', kind: kind === 'docs' ? 'document-set' : 'executable', paths: [artifactPath] }], commands: ['EXECUTE', 'VALIDATE'].map((phase) => ({ id: `demo-${phase.toLowerCase()}`, phase, cwd: '.', argv: positiveArgv, timeout_seconds: 20, evidence_types: evidence })), validation: { required_evidence: evidence }, protected_paths: ['.loop/**', ...frozen, '.loop-demo.json'], environment: { allow_names: ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'] } };
  const result = await prepareProject(root, { work_kind: kind === 'docs' ? 'documentation' : 'feature', request: `Complete the ${kind} demonstration through all six phases.`, acceptance_criteria: ['The bundled demo verifier exits zero for the unchanged artifact.', 'Independent review and validation evidence pass before handover.'], out_of_scope: ['Publishing, deployment, and external state changes.'], allowed_paths: [artifactPath], frozen_paths: frozen, adapter, negative_control: { argv: negativeArgv, cwd: '.', timeout_seconds: 20, expected_exit_code: 42, expected_output: { stream: 'stderr', match: 'includes', value: negativeMessage } }, max_wall_seconds: 1800 });
  const wrapper = path.join(root, '.loop', 'control', 'demo-provider.sh');
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await atomicText(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(bundleRoot, 'control', 'demo-provider.mjs'))}\n`, 0o700);
  await fs.chmod(wrapper, 0o700);
  const demoHost = { schema_version: 1, host: 'mock', provider_path: wrapper, review_host: 'mock', review_provider_path: wrapper, auth_check: null, updated_at: now() };
  demoHost.host_signature = await signHostConfiguration(root, demoHost);
  await atomicJson(path.join(root, '.loop', 'host.local.json'), demoHost);
  return { ...result, demo: { kind, provider_configured: true, next_steps: ['request-approval', 'activate', 'start'] } };
}

export async function verifyPlanForApproval(root) {
  const plan = await readJson(path.join(root, '.loop', 'candidate', 'setup.plan.json'), 'setup plan');
  const current = await verifyCurrentPlan(root, plan);
  if (current.digest !== plan.setup_digest) throw new ControlError('SETUP_CHANGED', 'candidate/source changed; approval request refused', { expected: plan.setup_digest, actual: current.digest });
  return plan;
}
