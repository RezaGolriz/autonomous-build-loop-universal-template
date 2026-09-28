// Team registry: which agents build, review and analyse, where each of them
// executes, and under which model, tool, data and budget limits.
//
// Configuring a team runs nothing. team_configure validates the config,
// normalizes its defaults, and writes one paused proposal to
// .loop/control/team.json, signed with the local host key. The proposal's
// digest covers the whole normalized config and its id is derived from that
// digest, so the later human approval binds exactly this team: a receipt in
// .loop/control/team.approval.json, signed by the same host key, whose
// approval_id is the proposal id and whose setup_digest is the team digest.
// That receipt is written only by the human confirmation flow; this module
// never writes one and there is no flag that stands in for it. A changed team
// is a new proposal, and the old approval no longer matches it.
//
// Readiness is a fact about a member, not about the config. team_status never
// calls a provider. It reports configured_unverified until the managed API
// runtime has seen a real provider response that reported an approved model,
// verified while that signed record is fresh, expired once it is not, and
// failed when the last response was refused or a named credential is absent.
// Native and CLI members are reported as explicitly unverified: nothing here
// checks what a host or an agent CLI will actually do.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { signHostConfiguration, verifyApproval, verifyHostConfiguration } from './approval-store.mjs';
import {
  ControlError, acquireDirLock, assertControlPath, assertNoEngineLock, atomicJson, exactKeys, exists, intValue, jsonDigest, now, readJson,
  safeRelative, stringArray, stringValue,
} from './common.mjs';
import { MODEL_NAME_PATTERN } from './schemas.mjs';

export const TEAM_MODES = Object.freeze(['sequential', 'parallel']);
export const EXECUTION_POLICIES = Object.freeze(['native_only', 'api_only', 'hybrid']);
export const TEAM_ROLES = Object.freeze(['coordinator', 'builder', 'reviewer', 'analyst']);
export const TEAM_PROVIDERS = Object.freeze(['openai', 'anthropic', 'local', 'host', 'mock']);
export const EXECUTION_KINDS = Object.freeze(['native', 'managed_api', 'cli']);
export const TEAM_TOOLS = Object.freeze(['list_files', 'read_file', 'write_file']);
export const READINESS_STATES = Object.freeze(['configured_unverified', 'verified', 'expired', 'failed']);
export const READINESS_TTL_SECONDS = 24 * 3600;

// Which provider may run under which execution kind.
const KIND_PROVIDERS = Object.freeze({
  native: ['host'],
  cli: ['openai', 'anthropic'],
  managed_api: ['openai', 'anthropic', 'local', 'mock'],
});
export const DEFAULT_ENDPOINTS = Object.freeze({ openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1' });

// Names a credential reference may never point at: they are not credentials,
// and several of them are what the loop and its providers run on.
const RESERVED_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'PWD', 'NODE_OPTIONS', 'NODE_PATH']);
const RESERVED_ENV_PREFIX = /^(?:LOOP_|BUILD_LOOP_|PROVIDER_TIMEOUT|CODEX_|CLAUDE_|MOCK_|API_TEAM_)/;

const TEAM_KEYS = ['schema_version', 'team_id', 'mode', 'max_active_packages', 'max_active_agents', 'execution_policy', 'members'];
const MEMBER_KEYS = ['id', 'role', 'provider', 'execution_kind', 'requested_model', 'allowed_resolved_models', 'tool_scope', 'data_scope', 'credential_env', 'endpoint', 'budget'];
const MEMBER_REQUIRED = ['id', 'role', 'provider', 'execution_kind', 'requested_model', 'tool_scope', 'data_scope'];
const RECORD_KEYS = ['schema_version', 'kind', 'proposal_id', 'team_digest', 'status', 'created_at', 'config', 'host_signature'];
const READINESS_KEYS = ['schema_version', 'member_id', 'team_digest', 'state', 'source', 'checked_at', 'expires_at', 'resolved_model', 'detail', 'host_signature'];

const modelPattern = new RegExp(MODEL_NAME_PATTERN);
const memberIdPattern = /^[a-z][a-z0-9-]{0,31}$/;

export const teamFiles = (control) => ({ proposal: path.join(control, 'team.json'), approval: path.join(control, 'team.approval.json') });
export const readinessFile = (scheduler, memberId) => path.join(scheduler, 'team', 'readiness', `${memberId}.json`);
export const proposalIdFor = (digest) => `team-${digest.slice(0, 32)}`;

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new ControlError('INVALID_INPUT', `${label} must be one of ${allowed.join(', ')}`);
  return value;
}

// An https URL, or plain http only to this machine. No userinfo, query or
// fragment: the key travels in a header and nowhere else.
export function validateEndpoint(value, label) {
  stringValue(value, label, { max: 2048 });
  let url;
  try { url = new URL(value); } catch { throw new ControlError('INVALID_INPUT', `${label} must be an absolute URL`); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new ControlError('INVALID_INPUT', `${label} must use https, or http on a loopback address`);
  if (url.username || url.password || url.search || url.hash) throw new ControlError('INVALID_INPUT', `${label} must not carry credentials, a query or a fragment`);
  return { url: url.href.replace(/\/+$/, ''), loopback };
}

function validateCredentialEnv(value, label) {
  // The message never repeats the value: somebody may have pasted a key here.
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(value)) throw new ControlError('INVALID_INPUT', `${label} must be the name of an environment variable (A-Z, 0-9, _), never a credential value`);
  if (RESERVED_ENV.has(value) || RESERVED_ENV_PREFIX.test(value)) throw new ControlError('INVALID_INPUT', `${label} names a reserved variable, not a credential`);
  return value;
}

function globArray(value, label) {
  return stringArray(value, label, { max: 128 }).map((item, index) => safeRelative(item, `${label}[${index}]`));
}

function validateMember(value, label) {
  exactKeys(value, MEMBER_KEYS, MEMBER_REQUIRED, label);
  const id = stringValue(value.id, `${label}.id`, { pattern: memberIdPattern });
  const role = oneOf(value.role, TEAM_ROLES, `${label}.role`);
  const provider = oneOf(value.provider, TEAM_PROVIDERS, `${label}.provider`);
  const kind = oneOf(value.execution_kind, EXECUTION_KINDS, `${label}.execution_kind`);
  if (!KIND_PROVIDERS[kind].includes(provider)) throw new ControlError('INVALID_INPUT', `${label}: execution_kind ${kind} requires provider ${KIND_PROVIDERS[kind].join(' or ')}`);
  const requested = stringValue(value.requested_model, `${label}.requested_model`, { max: 80, pattern: modelPattern });
  const allowed = stringArray(value.allowed_resolved_models ?? [], `${label}.allowed_resolved_models`, { max: 16, pattern: modelPattern });
  const tools = stringArray(value.tool_scope, `${label}.tool_scope`, { max: TEAM_TOOLS.length });
  tools.forEach((tool, index) => oneOf(tool, TEAM_TOOLS, `${label}.tool_scope[${index}]`));
  exactKeys(value.data_scope, ['read_paths', 'write_paths'], ['read_paths', 'write_paths'], `${label}.data_scope`);
  const readPaths = globArray(value.data_scope.read_paths, `${label}.data_scope.read_paths`);
  const writePaths = globArray(value.data_scope.write_paths, `${label}.data_scope.write_paths`);
  // Only a builder changes anything. A reviewer in particular is read-only, so
  // it cannot repair what it is judging.
  if (tools.includes('write_file') && role !== 'builder') throw new ControlError('INVALID_INPUT', `${label}: only a builder may hold write_file; a ${role} is read-only`);
  if (writePaths.length && !tools.includes('write_file')) throw new ControlError('INVALID_INPUT', `${label}.data_scope.write_paths must be empty without write_file`);
  if (tools.includes('write_file') && !writePaths.length) throw new ControlError('INVALID_INPUT', `${label}: write_file needs at least one write path`);
  if ((tools.includes('read_file') || tools.includes('list_files')) && !readPaths.length) throw new ControlError('INVALID_INPUT', `${label}: read tools need at least one read path`);

  let credential = value.credential_env ?? null;
  let endpoint = value.endpoint ?? null;
  let budget = value.budget ?? null;
  if (kind === 'managed_api') {
    if (['openai', 'anthropic'].includes(provider)) {
      if (credential === null) throw new ControlError('INVALID_INPUT', `${label}.credential_env must name the environment variable that holds the ${provider} key`);
    }
    if (credential !== null) credential = validateCredentialEnv(credential, `${label}.credential_env`);
    if (endpoint === null && ['local', 'mock'].includes(provider)) throw new ControlError('INVALID_INPUT', `${label}.endpoint is required for provider ${provider}`);
    if (endpoint !== null) {
      const checked = validateEndpoint(endpoint, `${label}.endpoint`);
      if (['local', 'mock'].includes(provider) && !checked.loopback) throw new ControlError('INVALID_INPUT', `${label}.endpoint for provider ${provider} must be a loopback address`);
      endpoint = checked.url;
    }
    if (budget === null) throw new ControlError('MISSING_INPUT', `${label}.budget is required for managed_api`, { missing_inputs: [`${label}.budget`] });
    exactKeys(budget, ['max_turns', 'max_total_tokens', 'max_seconds'], ['max_turns', 'max_total_tokens', 'max_seconds'], `${label}.budget`);
    budget = {
      max_turns: intValue(budget.max_turns, `${label}.budget.max_turns`, 1, 64),
      max_total_tokens: intValue(budget.max_total_tokens, `${label}.budget.max_total_tokens`, 1000, 4000000),
      max_seconds: intValue(budget.max_seconds, `${label}.budget.max_seconds`, 10, 86400),
    };
  } else {
    // A host or an agent CLI keeps its own credentials and limits; naming them
    // here would suggest build-loop checks or enforces them, which it does not.
    if (credential !== null) throw new ControlError('INVALID_INPUT', `${label}.credential_env is only for managed_api members`);
    if (endpoint !== null) throw new ControlError('INVALID_INPUT', `${label}.endpoint is only for managed_api members`);
    if (budget !== null) throw new ControlError('INVALID_INPUT', `${label}.budget is only enforced for managed_api members`);
  }
  return {
    id, role, provider, execution_kind: kind, requested_model: requested, allowed_resolved_models: allowed,
    tool_scope: TEAM_TOOLS.filter((tool) => tools.includes(tool)),
    data_scope: { read_paths: readPaths, write_paths: writePaths },
    credential_env: credential, endpoint, budget,
  };
}

// Validates a team config and returns it normalized: every optional field is
// present with its default, so equal teams have equal digests.
export function validateTeam(config) {
  exactKeys(config, TEAM_KEYS, ['schema_version', 'team_id', 'mode', 'execution_policy', 'members'], 'team');
  if (config.schema_version !== 1) throw new ControlError('INVALID_INPUT', 'team.schema_version must be 1');
  const teamId = stringValue(config.team_id, 'team.team_id', { pattern: /^[a-z][a-z0-9-]{1,63}$/ });
  const mode = oneOf(config.mode, TEAM_MODES, 'team.mode');
  const packages = intValue(config.max_active_packages ?? 1, 'team.max_active_packages', 1, 8);
  const agents = intValue(config.max_active_agents ?? 2, 'team.max_active_agents', 1, 16);
  if (mode === 'sequential' && packages !== 1) throw new ControlError('INVALID_INPUT', 'team.mode sequential allows exactly one active package');
  const policy = oneOf(config.execution_policy, EXECUTION_POLICIES, 'team.execution_policy');
  if (!Array.isArray(config.members) || config.members.length < 2 || config.members.length > 16) throw new ControlError('INVALID_INPUT', 'team.members must hold 2-16 members');
  const members = config.members.map((member, index) => validateMember(member, `team.members[${index}]`));
  if (new Set(members.map(({ id }) => id)).size !== members.length) throw new ControlError('INVALID_INPUT', 'team.members ids must be unique');
  for (const role of ['builder', 'reviewer']) {
    if (!members.some((member) => member.role === role)) throw new ControlError('INVALID_INPUT', `team.members needs at least one ${role}`);
  }
  for (const member of members) {
    if (policy === 'native_only' && member.execution_kind !== 'native') throw new ControlError('INVALID_INPUT', `team.execution_policy native_only does not allow ${member.execution_kind} member ${member.id}`);
    if (policy === 'api_only' && member.execution_kind !== 'managed_api') throw new ControlError('INVALID_INPUT', `team.execution_policy api_only does not allow ${member.execution_kind} member ${member.id}; no agent CLI or host runs under it`);
  }
  return { schema_version: 1, team_id: teamId, mode, max_active_packages: packages, max_active_agents: agents, execution_policy: policy, members };
}

export const teamDigest = (normalized) => jsonDigest(normalized);

// What the host key signs. Its own kind keeps a team signature from ever
// standing in for a signed host configuration, and the digest covers the config.
const proposalSigned = (record) => ({ kind: 'team-proposal-v1', proposal_id: record.proposal_id, team_digest: record.team_digest, created_at: record.created_at, status: record.status });
const readinessSigned = (record) => ({ kind: 'team-readiness-v1', ...Object.fromEntries(READINESS_KEYS.filter((key) => key !== 'host_signature').map((key) => [key, record[key]])) });

async function signed(root, view) { return signHostConfiguration(root, view); }
async function signatureValid(root, view, signature) {
  try { await verifyHostConfiguration(root, { ...view, host_signature: signature }); return true; } catch { return false; }
}

async function teamPaths(root) {
  const { control, scheduler } = await assertControlPath(root);
  return { control, scheduler, ...teamFiles(control) };
}

// Reads and checks the stored proposal: shape, digest, derived id, a fresh
// validation of the config, and the host signature. Returns null when no team
// is configured; throws TEAM_UNTRUSTED for anything that does not hold.
export async function loadTeam(root) {
  const { proposal } = await teamPaths(root);
  if (!await exists(proposal)) return null;
  const untrusted = (why) => new ControlError('TEAM_UNTRUSTED', `the stored team proposal ${why}; run team_configure again and ask for a new approval`);
  const record = await readJson(proposal, 'team proposal').catch(() => { throw untrusted('cannot be read'); });
  try { exactKeys(record, RECORD_KEYS, RECORD_KEYS, 'team proposal'); } catch { throw untrusted('does not have the expected shape'); }
  if (record.schema_version !== 1 || record.kind !== 'team-proposal' || record.status !== 'PAUSED') throw untrusted('does not have the expected shape');
  let normalized;
  try { normalized = validateTeam(record.config); } catch (error) { throw untrusted(`no longer validates (${error.message})`); }
  const digest = teamDigest(normalized);
  if (digest !== record.team_digest || jsonDigest(record.config) !== digest || record.proposal_id !== proposalIdFor(digest)) throw untrusted('was changed after it was configured');
  if (!/^[a-f0-9]{64}$/.test(record.host_signature) || !await signatureValid(root, proposalSigned(record), record.host_signature)) throw untrusted('is not signed by this host');
  return { proposal_id: record.proposal_id, team_digest: digest, created_at: record.created_at, config: normalized };
}

// Stores a paused, signed proposal. Nothing is executed, probed or called.
export async function teamConfigure(root, args) {
  exactKeys(args, ['config', 'replace'], ['config'], 'team_configure');
  if (args.replace !== undefined && typeof args.replace !== 'boolean') throw new ControlError('INVALID_INPUT', 'replace must be true or false');
  const normalized = validateTeam(args.config);
  const digest = teamDigest(normalized);
  const proposalId = proposalIdFor(digest);
  const { proposal } = await teamPaths(root);
  await assertNoEngineLock(root);
  const { loop } = await assertControlPath(root);
  await fs.mkdir(loop, { recursive: true });
  const release = await acquireDirLock(path.join(loop, 'orchestrator.lock'), { operation: 'team-configure' });
  try {
  if (await exists(proposal)) {
    const current = await loadTeam(root).catch(() => null);
    if (current?.team_digest === digest) return { ok: true, status: 'PAUSED', unchanged: true, proposal_id: proposalId, team_digest: digest, approval_required: true, executed: false, next: 'request human approval of this exact team digest' };
    if (args.replace !== true) throw new ControlError('TEAM_EXISTS', 'a different team proposal is already stored; pass replace:true to replace it (its approval will not carry over)');
  }
  const record = { schema_version: 1, kind: 'team-proposal', proposal_id: proposalId, team_digest: digest, status: 'PAUSED', created_at: now(), config: normalized };
  record.host_signature = await signed(root, proposalSigned(record));
  await atomicJson(proposal, record);
  return { ok: true, status: 'PAUSED', unchanged: false, proposal_id: proposalId, team_digest: digest, approval_required: true, executed: false, next: 'request human approval of this exact team digest' };
  } finally { await release(); }
}

// The approval the human confirmation flow is expected to write. Its
// approval_id and setup_digest are the only two fields that bind it.
export function teamApprovalBinding(team) {
  return { approval_id: team.proposal_id, setup_digest: team.team_digest };
}

async function approvalState(root, team) {
  const { approval } = await teamPaths(root);
  if (!await exists(approval)) return { state: 'PENDING' };
  let receipt;
  try { receipt = await readJson(approval, 'team approval'); } catch { return { state: 'UNTRUSTED', detail: 'the approval record cannot be read' }; }
  if (receipt.approval_id !== team.proposal_id || receipt.setup_digest !== team.team_digest) return { state: 'STALE', detail: 'the approval was given for a different team proposal' };
  try { await verifyApproval(root, receipt); } catch (error) { return { state: 'UNTRUSTED', detail: error.message }; }
  return { state: 'APPROVED', channel: receipt.channel, approved_at: receipt.approved_at };
}

// The only way to use a team: the stored proposal is intact and signed, and a
// host-signed human approval names exactly its id and digest.
export async function verifyTeamBinding(root) {
  const team = await loadTeam(root);
  if (!team) throw new ControlError('TEAM_NOT_CONFIGURED', 'no team is configured; run team_configure and ask a person to approve it');
  const approval = await approvalState(root, team);
  if (approval.state === 'PENDING') throw new ControlError('TEAM_APPROVAL_REQUIRED', 'the team proposal is paused until a person approves this exact team digest', { proposal_id: team.proposal_id, team_digest: team.team_digest });
  if (approval.state === 'STALE') throw new ControlError('TEAM_APPROVAL_STALE', `${approval.detail}; the current proposal needs its own approval`, { proposal_id: team.proposal_id, team_digest: team.team_digest });
  if (approval.state !== 'APPROVED') throw new ControlError('TEAM_APPROVAL_UNTRUSTED', `the team approval does not verify: ${approval.detail}`);
  return { ok: true, bound: true, proposal_id: team.proposal_id, team_digest: team.team_digest, approved_at: approval.approved_at, channel: approval.channel, config: team.config };
}

// Written by the managed API runtime after a real provider response. Signed,
// so an agent that can write the scheduler directory cannot mint "verified".
export async function recordReadiness(root, { member_id, team_digest, state, source, resolved_model = null, detail }) {
  stringValue(member_id, 'member_id', { pattern: memberIdPattern });
  oneOf(state, ['verified', 'failed'], 'state'); oneOf(source, ['provider-response', 'provider-error'], 'source');
  const checked = new Date();
  const record = {
    schema_version: 1, member_id, team_digest, state, source,
    checked_at: checked.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expires_at: new Date(checked.getTime() + READINESS_TTL_SECONDS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    resolved_model, detail: String(detail).slice(0, 500),
  };
  record.host_signature = await signed(root, readinessSigned(record));
  const { scheduler } = await teamPaths(root);
  await atomicJson(readinessFile(scheduler, member_id), record);
  return record;
}

async function memberReadiness(root, scheduler, team, member, env, nowMs) {
  const unverified = (detail) => ({ state: 'configured_unverified', source: 'none', checked_at: null, expires_at: null, detail });
  if (member.execution_kind === 'native') return unverified('native host support is explicitly unverified; build-loop does not check what the host will do');
  if (member.execution_kind === 'cli') return unverified('agent CLI support is explicitly unverified here; doctor checks the configured CLI, not this team member');
  if (member.credential_env && !env[member.credential_env]) {
    return { state: 'failed', source: 'environment', checked_at: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'), expires_at: null, detail: `the credential variable ${member.credential_env} is not set` };
  }
  const file = readinessFile(scheduler, member.id);
  if (!await exists(file)) return unverified('no provider response has been recorded for this member yet');
  let record;
  try {
    record = await readJson(file, 'readiness');
    exactKeys(record, READINESS_KEYS, READINESS_KEYS, 'readiness');
  } catch { return unverified('the readiness record cannot be read'); }
  if (record.member_id !== member.id || record.team_digest !== team.team_digest) return unverified('the readiness record belongs to another team proposal');
  if (!await signatureValid(root, readinessSigned(record), record.host_signature)) return unverified('the readiness record is not signed by this host');
  const base = { source: record.source, checked_at: record.checked_at, expires_at: record.expires_at, resolved_model: record.resolved_model, detail: record.detail };
  if (record.state === 'failed') return { state: 'failed', ...base };
  if (!(Date.parse(record.expires_at) > nowMs)) return { state: 'expired', ...base };
  return { state: 'verified', ...base };
}

// Read-only. Never calls a provider and never prints a credential, only
// whether the named variable is set.
export async function teamStatus(root, { env = process.env } = {}) {
  const { scheduler } = await teamPaths(root);
  let team;
  try { team = await loadTeam(root); } catch (error) {
    return { ok: true, configured: true, integrity: 'failed', ready: false, detail: error.message, next: 'run team_configure again and ask for a new approval' };
  }
  if (!team) return { ok: true, configured: false, ready: false, next: 'team_configure writes a paused team proposal; nothing runs until a person approves it' };
  const approval = await approvalState(root, team);
  const nowMs = Date.now();
  const members = [];
  for (const member of team.config.members) {
    members.push({
      id: member.id, role: member.role, provider: member.provider, execution_kind: member.execution_kind,
      requested_model: member.requested_model, allowed_resolved_models: member.allowed_resolved_models,
      credential: member.credential_env ? { env: member.credential_env, present: Boolean(env[member.credential_env]) } : null,
      endpoint: member.execution_kind === 'managed_api' ? (member.endpoint ?? DEFAULT_ENDPOINTS[member.provider]) : null,
      readiness: await memberReadiness(root, scheduler, team, member, env, nowMs),
    });
  }
  const ready = approval.state === 'APPROVED' && members.every((member) => member.readiness.state === 'verified');
  return {
    ok: true, configured: true, integrity: 'ok', proposal_id: team.proposal_id, team_digest: team.team_digest, created_at: team.created_at,
    approval, team_id: team.config.team_id, mode: team.config.mode, execution_policy: team.config.execution_policy,
    limits: { max_active_packages: team.config.max_active_packages, max_active_agents: team.config.max_active_agents },
    members, ready,
    next: approval.state !== 'APPROVED' ? 'a person approves this exact team digest before any member runs'
      : ready ? 'every member has a fresh verified provider response' : 'members that are not verified have not yet shown a provider response with an approved model',
  };
}
