// Scouting for work. A scout looks at the project and writes down what it
// thinks could be worth doing. It is a read-only errand: the provider runs in a
// disposable copy of the project with a clean environment, and the only thing
// the real project gains is a set of inert proposals under `.loop/inbox/`.
//
// A proposal is not a work item and never becomes one on its own. A person
// promotes it into the backlog, or discards it. The backlog is never touched
// here, and nothing is ever started.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyHostConfiguration } from './approval-store.mjs';
import { validateKind } from './loop-options.mjs';
import {
  ControlError, acquireDirLock, assertControlPath, assertPlain, atomicJson, atomicText, exactKeys,
  exists, now, readJson, sha256, stringValue,
} from './common.mjs';
import { activeJob, backlogAdd, readBacklog, workItemFile } from './backlog.mjs';
import { assertNotHeld } from './hold.mjs';
import { readNextSteps } from './notes.mjs';
import { bundleRoot, copyDisposableProject, runBounded } from './setup.mjs';

const PROVIDERS = ['claude', 'codex', 'mock'];
const PROPOSAL_LIMIT = 5;
const SCOUT_TIMEOUT_SECONDS = 900;
const DEFAULT_ENVIRONMENT_NAMES = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'];
const proposalIdPattern = /^P-\d{8}T\d{6}Z-\d{1,3}$/;
const itemIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const oneLine = (value) => String(value).replace(/[\r\n]+/g, ' ').trim();
const quoteBlock = (value) => String(value).split(/\r?\n/).map((line) => `> ${line}`).join('\n');
// Identifier-safe UTC stamp, for example 20260907T101530Z.
const stamp = () => now().replace(/[-:]/g, '');

export const inboxDirectory = (loop) => path.join(loop, 'inbox');
export const inboxIndexFile = (loop) => path.join(loop, 'inbox', 'index.json');
// Scheduler-owned logs. They live outside .loop/control on purpose: a scout
// or a triage decision may be recorded while a node is running, and every
// change under .loop/control during a node counts as provider tampering.
const scoutLogFile = (scheduler) => path.join(scheduler, 'scout.log');
const inboxLogFile = (scheduler) => path.join(scheduler, 'inbox.log');

// What a scout is asked to look for. The common list holds for every project;
// the profile adds what only makes sense for that kind of project.
const COMMON_CHECKS = [
  'Tests that fail, are skipped, or are missing for behaviour that already exists.',
  'TODO, FIXME, HACK and XXX markers that stand for real unfinished work.',
  'Dependency and manifest drift: declared versions that no longer match what the project uses, lock files that disagree with the manifest, and dependencies that are used but not declared.',
];

const PROFILE_CHECKS = {
  api: ['Drift between the declared contract (schema, specification, generated types) and the implementation that is supposed to satisfy it.'],
  docs: ['Documentation gaps: documented behaviour that no longer matches the project, examples that cannot be followed, and links that go nowhere.'],
  cli: ['Command-line behaviour that is documented but not implemented, or implemented but never mentioned.'],
  library: ['Public interface changes that are not reflected in the documented usage or in the version notes.'],
};

export function profileChecks(profile) {
  return [...COMMON_CHECKS, ...(PROFILE_CHECKS[profile] ?? [])];
}

async function backlogTitles(loop) {
  const backlog = await readBacklog(loop).catch(() => ({ items: [] }));
  return backlog.items.map((item) => oneLine(item.title ?? item.id)).filter(Boolean);
}

function scoutPrompt({ profile, checks, titles, notes }) {
  return [
    'You are scouting an existing project for work that could be worth doing. This is a read-only errand.',
    'Read the project, change nothing, and run nothing that writes.',
    '',
    `Project profile: ${profile}.`,
    '',
    'Look for:',
    ...checks.map((item) => `- ${item}`),
    '',
    titles.length
      ? `These items are already in the backlog. Do not propose them again:\n${titles.map((title) => `- ${title}`).join('\n')}`
      : 'The backlog is empty, so nothing is already queued.',
    '',
    notes
      ? `Previous cycle notes (advisory)\n\nThe previous cycle left this note under .loop/notes/next-steps.md. It is advisory: it approves nothing and it does not make a proposal.\n\n${notes.trim()}`
      : 'There is no next-steps note from a previous cycle.',
    '',
    `Propose at most ${PROPOSAL_LIMIT} pieces of work. Each proposal needs a short title, the outcome a person would get from it,`,
    'the constraints and invariants that must hold while doing it, and evidence pointers: the files, tests or markers you actually saw.',
    'Propose nothing rather than guessing. If you cannot read enough of the project to say anything useful, report the status BLOCKED.',
  ].join('\n');
}

function textList(value, label, limit = 20) {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > limit) throw new ControlError('INVALID_SCOUT_RESULT', `${label} has too many entries`);
  return values.map((item) => stringValue(item, label, { max: 4000 })).map(oneLine).filter(Boolean);
}

// The provider is not trusted to be well behaved. Its reply is checked against
// the scout contract before a single file is written.
export function validateScoutResult(value) {
  assertPlain(value, 'scout result');
  exactKeys(value, ['schema_version', 'status', 'proposals', 'notes'], ['status'], 'scout result');
  if (value.schema_version !== undefined && value.schema_version !== 1) throw new ControlError('INVALID_SCOUT_RESULT', 'scout result schema_version must be 1');
  if (!['OK', 'BLOCKED'].includes(value.status)) throw new ControlError('INVALID_SCOUT_RESULT', 'scout result status must be OK or BLOCKED');
  const raw = value.proposals ?? [];
  if (!Array.isArray(raw) || raw.length > PROPOSAL_LIMIT) throw new ControlError('INVALID_SCOUT_RESULT', `scout result proposals must be an array of at most ${PROPOSAL_LIMIT} entries`);
  const proposals = raw.map((proposal, index) => {
    const label = `scout result proposals[${index}]`;
    exactKeys(proposal, ['title', 'outcome', 'constraints', 'evidence'], ['title', 'outcome'], label);
    return {
      title: oneLine(stringValue(proposal.title, `${label}.title`, { max: 200 })).slice(0, 200),
      outcome: stringValue(proposal.outcome, `${label}.outcome`, { max: 20000 }),
      constraints: textList(proposal.constraints, `${label}.constraints`),
      evidence: textList(proposal.evidence, `${label}.evidence`),
    };
  });
  if (value.status === 'BLOCKED' && proposals.length) throw new ControlError('INVALID_SCOUT_RESULT', 'a blocked scout reports no proposals');
  return { status: value.status, proposals, notes: value.notes === undefined ? null : oneLine(stringValue(value.notes, 'scout result notes', { max: 4000 })) };
}

// The proposal file uses the shipped work-item template, so a promoted proposal
// and a hand-written backlog item read the same way.
async function renderProposal(id, proposal, meta) {
  const template = await fs.readFile(path.join(bundleRoot, 'template', 'work-items', 'WI-001-template.md'), 'utf8');
  const constraints = proposal.constraints.length ? proposal.constraints : ['No constraint was recorded by the scout; a person adds them before this runs.'];
  const evidence = proposal.evidence.length ? proposal.evidence : ['The scout recorded no evidence pointer.'];
  return template
    .replace(/^# .*$/m, `# ${id}: ${proposal.title}`)
    .replace(/^Kind: .*$/m, [
      `Kind: ${meta.work_kind}`,
      '',
      `Scout proposal written by the ${meta.provider} provider at ${meta.created_at} for the ${meta.profile} profile.`,
      'It is inert. It is not in the backlog, nothing runs it, and it becomes work only when a person promotes it.',
    ].join('\n'))
    .replace(/^## Outcome$/m, `## Outcome\n\n${quoteBlock(proposal.outcome)}`)
    .replace(/^## Constraints and invariants$/m, `## Constraints and invariants\n\n${constraints.map((item) => `- ${item}`).join('\n')}`)
    .replace(/^## Design$/m, `## Evidence pointers\n\n${evidence.map((item) => `- ${item}`).join('\n')}\n\n## Design`);
}

export async function readInboxIndex(loop) {
  const file = inboxIndexFile(loop);
  if (!await exists(file)) return { schema_version: 1, items: [] };
  const index = await readJson(file, 'inbox index');
  if (index.schema_version !== 1 || !Array.isArray(index.items)) throw new ControlError('INVALID_INBOX', 'inbox index.json must be a version 1 record with an items array');
  for (const item of index.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !proposalIdPattern.test(String(item.id))) throw new ControlError('INVALID_INBOX', 'inbox index.json contains an entry without a usable proposal id');
  }
  return index;
}

async function appendJsonLine(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

// Only a bundled wrapper is ever executed. The disposable copy and the clean
// environment keep the errand tidy; they do not contain an arbitrary program,
// because a program started with the user's own privileges can write to any
// absolute path whatever its working directory is. Containment therefore rests
// on the bundled read-only wrappers (Claude with Read, Glob and Grep only,
// Codex in its read-only sandbox) together with the copy — and on nothing else.
const hostsRoot = path.join(bundleRoot, 'hosts');
const bundledProvider = (id) => path.join(hostsRoot, id, 'provider.sh');

// A scout provider is named, never pathed. The name has to be one of the three
// this distribution ships, and the executable is the bundled wrapper for that
// name and nothing else — no configured path, no generated wrapper, no `..`.
function providerName(value, label) {
  const id = stringValue(value, label, { max: 16 });
  if (!PROVIDERS.includes(id)) throw new ControlError('INVALID_INPUT', `${label} must be one of ${PROVIDERS.join(', ')}`);
  return id;
}

async function bundledProviderPath(id) {
  const file = bundledProvider(id);
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new ControlError('PROVIDER_NOT_INSTALLED', 'the bundled scout provider is not an installed regular file');
  const canonical = await fs.realpath(file);
  if (canonical !== file || !canonical.startsWith(`${hostsRoot}${path.sep}`)) throw new ControlError('PROVIDER_NOT_INSTALLED', 'the bundled scout provider resolves outside this distribution');
  return file;
}

async function resolveProvider(root, loop, args) {
  if (args.provider !== undefined) {
    const id = providerName(args.provider, 'provider');
    return { provider: id, provider_path: await bundledProviderPath(id), source: 'argument' };
  }
  const configFile = path.join(loop, 'host.local.json');
  if (!await exists(configFile)) throw new ControlError('MISSING_INPUT', 'no provider is configured for this project; pass provider', { missing_inputs: ['provider'] });
  const config = await readJson(configFile, 'host.local.json');
  await verifyHostConfiguration(root, config);
  if (typeof config.host !== 'string' || !PROVIDERS.includes(config.host)) throw new ControlError('MISSING_INPUT', 'the configured host is not a scout provider; pass provider', { missing_inputs: ['provider'] });
  // Only the name is taken from the signed configuration. Its provider_path is
  // deliberately ignored: a scout runs the bundled read-only wrapper or nothing.
  return { provider: config.host, provider_path: await bundledProviderPath(config.host), source: 'bundled-wrapper' };
}

async function environmentNames(loop) {
  const adapter = await readJson(path.join(loop, 'project.adapter.json'), 'project adapter').catch(() => null);
  const names = adapter?.environment?.allow_names;
  return Array.isArray(names) && names.length ? [...new Set(['PATH', ...names])] : DEFAULT_ENVIRONMENT_NAMES;
}

async function projectProfile(loop, args) {
  if (args.profile !== undefined) return stringValue(args.profile, 'profile', { max: 64, pattern: /^[a-z][a-z0-9-]{0,63}$/ });
  const adapter = await readJson(path.join(loop, 'project.adapter.json'), 'project adapter').catch(() => null);
  return typeof adapter?.project_kind === 'string' ? adapter.project_kind : 'general';
}

export async function scout(root, args = {}, channel = 'mcp-user') {
  const { loop, scheduler } = await assertControlPath(root);
  // A held project is not scouted either: it spends a provider run and writes
  // proposals into the inbox, and a stopped project stops completely.
  await assertNotHeld(root, channel, 'scout');
  const running = await activeJob(root);
  if (running) throw new ControlError('JOB_ACTIVE', `job ${running.job_id} is active; a scout waits until the run is finished`, { job_id: running.job_id });
  const { provider, provider_path: providerPath, source } = await resolveProvider(root, loop, args);
  const profile = await projectProfile(loop, args);
  const workKind = validateKind(args.work_kind);
  const checks = profileChecks(profile);
  const titles = await backlogTitles(loop);
  const brief = {
    schema_version: 1,
    phase: 'SCOUT',
    read_only: true,
    profile,
    proposal_limit: PROPOSAL_LIMIT,
    looking_for: checks,
    backlog_titles: titles,
    prompt: scoutPrompt({ profile, checks, titles, notes: await readNextSteps(root) }),
  };

  // The provider never sees the real project. It reads a disposable copy, with
  // a clean environment and an isolated home and temporary directory, and the
  // copy is removed whatever happens.
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'build-loop-scout-')));
  let outcome;
  try {
    const isolatedRoot = await copyDisposableProject(root, temp);
    const briefFile = path.join(isolatedRoot, 'scout-brief.json');
    await fs.writeFile(briefFile, `${JSON.stringify(brief)}\n`, { mode: 0o600 });
    outcome = await runBounded(
      ['bash', '-c', 'exec "$1" < "$2"', 'scout', providerPath, briefFile],
      temp,
      SCOUT_TIMEOUT_SECONDS,
      await environmentNames(loop),
      isolatedRoot,
      { LOOP_PHASE: 'SCOUT', LOOP_ROOT: temp },
    );
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
  if (outcome.exit_code !== 0) throw new ControlError('SCOUT_PROVIDER_FAILED', `the scout provider exited with ${outcome.exit_code}`, { exit_code: outcome.exit_code, timed_out: outcome.timed_out });
  let parsed;
  try { parsed = JSON.parse(outcome.stdout); }
  catch { throw new ControlError('INVALID_SCOUT_RESULT', 'the scout provider did not return one JSON object'); }
  const result = validateScoutResult(parsed);

  const createdAt = now();
  const written = [];
  const release = await acquireDirLock(path.join(loop, 'inbox.lock'), { operation: 'scout' });
  try {
    const index = await readInboxIndex(loop);
    const prefix = `P-${stamp()}`;
    for (const [position, proposal] of result.proposals.entries()) {
      const id = `${prefix}-${position + 1}`;
      const file = path.join(inboxDirectory(loop), `${id}.md`);
      if (await exists(file)) throw new ControlError('PROPOSAL_EXISTS', `a proposal file already exists: ${id}`);
      await atomicText(file, await renderProposal(id, proposal, { provider, profile, created_at: createdAt, work_kind: workKind }));
      const entry = { id, title: proposal.title, created_at: createdAt, provider, file: `.loop/inbox/${id}.md` };
      index.items.push(entry);
      written.push(entry);
    }
    await atomicJson(inboxIndexFile(loop), index);
  } finally { await release(); }

  await appendJsonLine(scoutLogFile(scheduler), {
    at: createdAt, event: 'scout', provider, provider_source: source, profile,
    status: result.status, proposals: written.length, proposal_ids: written.map((item) => item.id),
    ...(result.notes ? { notes: result.notes } : {}),
  });
  return {
    ok: true, status: result.status, provider, profile, proposals: written.length,
    inbox: written, notes: result.notes, backlog_touched: false,
    next: written.length ? 'read the proposals, then promote or discard each one' : 'nothing was proposed',
  };
}

export async function inboxList(root) {
  const { loop } = await assertControlPath(root);
  const index = await readInboxIndex(loop);
  return { ok: true, inbox: { count: index.items.length, items: index.items } };
}

function section(text, heading) {
  const pattern = new RegExp(`^## ${heading}$([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm');
  return pattern.exec(text)?.[1] ?? '';
}

function proposalContent(text) {
  const outcome = section(text, 'Outcome').split(/\r?\n/).filter((line) => line.startsWith('> ')).map((line) => line.slice(2)).join('\n').trim();
  const bullets = (heading) => section(text, heading).split(/\r?\n/).filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim()).filter(Boolean);
  return { outcome, constraints: bullets('Constraints and invariants'), evidence: bullets('Evidence pointers') };
}

// The promoted work item keeps what the scout saw, so the person who picks it up
// later reads the same constraints and evidence pointers.
async function carryOverDetails(loop, itemId, content) {
  const file = workItemFile(loop, itemId);
  const text = await fs.readFile(file, 'utf8');
  const constraints = content.constraints.length ? `\n\n${content.constraints.map((item) => `- ${item}`).join('\n')}` : '';
  const evidence = content.evidence.length ? `## Evidence pointers\n\n${content.evidence.map((item) => `- ${item}`).join('\n')}\n\n## Design` : '## Design';
  const updated = text
    .replace(/^## Constraints and invariants$/m, `## Constraints and invariants${constraints}`)
    .replace(/^## Design$/m, evidence);
  await fs.writeFile(file, updated);
}

// What a person is promoting, resolved: which proposal, its title, and a
// fingerprint of the exact file content. A confirmation freezes this; promotion
// refuses if the proposal file changed after the person read it.
export async function proposalFingerprint(loop, proposalId) {
  stringValue(proposalId, 'proposal_id', { pattern: proposalIdPattern });
  const index = await readInboxIndex(loop);
  const entry = index.items.find((item) => item.id === proposalId);
  if (!entry) throw new ControlError('PROPOSAL_NOT_FOUND', `the inbox does not contain ${proposalId}`);
  const text = await fs.readFile(path.join(inboxDirectory(loop), `${proposalId}.md`), 'utf8').catch(() => null);
  if (text === null) throw new ControlError('PROPOSAL_NOT_FOUND', `the proposal file for ${proposalId} is missing`);
  return { proposal_id: proposalId, title: entry.title ?? null, proposal_sha256: sha256(text) };
}

export async function promote(root, args, channel, frozen = null) {
  const { loop, scheduler } = await assertControlPath(root);
  const proposalId = stringValue(args.proposal_id, 'proposal_id', { pattern: proposalIdPattern });
  if (args.id !== undefined) stringValue(args.id, 'id', { pattern: itemIdPattern });
  const workKind = validateKind(args.work_kind);
  const release = await acquireDirLock(path.join(loop, 'inbox.lock'), { operation: 'promote' });
  let result;
  try {
    const index = await readInboxIndex(loop);
    const entry = index.items.find((item) => item.id === proposalId);
    if (!entry) throw new ControlError('PROPOSAL_NOT_FOUND', `the inbox does not contain ${proposalId}`);
    const file = path.join(inboxDirectory(loop), `${proposalId}.md`);
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) throw new ControlError('PROPOSAL_NOT_FOUND', `the proposal file for ${proposalId} is missing`);
    if (frozen && (frozen.proposal_id !== proposalId || sha256(text) !== frozen.proposal_sha256)) {
      throw new ControlError('CONFIRMATION_STALE', `the proposal ${proposalId} changed since this promotion was confirmed; read it again and promote the current text`);
    }
    const content = proposalContent(text);
    if (!content.outcome) throw new ControlError('INVALID_PROPOSAL', `the proposal ${proposalId} has no outcome to promote`);
    const added = await backlogAdd(root, { ...(args.id ? { id: args.id } : {}), title: entry.title, work_kind: workKind, outcome: content.outcome });
    if (added.ok === false) throw new ControlError(added.error?.code || 'BACKLOG_ADD_FAILED', added.error?.message || 'the backlog item could not be written');
    await carryOverDetails(loop, added.item_id, content);
    const kept = path.join(inboxDirectory(loop), 'promoted', `${proposalId}.md`);
    await fs.mkdir(path.dirname(kept), { recursive: true });
    await fs.rename(file, kept);
    index.items = index.items.filter((item) => item.id !== proposalId);
    await atomicJson(inboxIndexFile(loop), index);
    result = {
      ok: true, proposal_id: proposalId, item_id: added.item_id, work_kind: added.work_kind,
      work_item: added.work_item, promoted_by: channel, started: false,
      next: 'authorize the item when a person decides it may run',
    };
  } finally { await release(); }
  await appendJsonLine(inboxLogFile(scheduler), { at: now(), event: 'promote', proposal_id: proposalId, item_id: result.item_id, channel });
  return result;
}

export async function discard(root, args, channel) {
  const { loop, scheduler } = await assertControlPath(root);
  const proposalId = stringValue(args.proposal_id, 'proposal_id', { pattern: proposalIdPattern });
  const release = await acquireDirLock(path.join(loop, 'inbox.lock'), { operation: 'discard' });
  let discarded;
  try {
    const index = await readInboxIndex(loop);
    const entry = index.items.find((item) => item.id === proposalId);
    if (!entry) throw new ControlError('PROPOSAL_NOT_FOUND', `the inbox does not contain ${proposalId}`);
    const file = path.join(inboxDirectory(loop), `${proposalId}.md`);
    if (await exists(file)) {
      const kept = path.join(inboxDirectory(loop), 'discarded', `${proposalId}.md`);
      await fs.mkdir(path.dirname(kept), { recursive: true });
      await fs.rename(file, kept);
    }
    index.items = index.items.filter((item) => item.id !== proposalId);
    await atomicJson(inboxIndexFile(loop), index);
    discarded = entry;
  } finally { await release(); }
  await appendJsonLine(inboxLogFile(scheduler), { at: now(), event: 'discard', proposal_id: proposalId, channel });
  return { ok: true, proposal_id: proposalId, title: discarded.title, discarded: true, file: `.loop/inbox/discarded/${proposalId}.md`, discarded_by: channel };
}
