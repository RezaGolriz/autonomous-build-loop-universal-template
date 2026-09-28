// Team registry. Configuring a team stores a paused, host-signed proposal and
// runs nothing; only a host-signed human approval of that exact digest binds
// it, and readiness is reported from signed provider evidence, never assumed.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { signApproval, signHostConfiguration } from '../control/approval-store.mjs';
import {
  EXECUTION_KINDS, EXECUTION_POLICIES, TEAM_MODES, TEAM_PROVIDERS, TEAM_ROLES, TEAM_TOOLS,
  loadTeam, recordReadiness, teamConfigure, teamStatus, validateTeam, verifyTeamBinding,
} from '../control/team.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'team-approval-store-')));
await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async (file) => fs.stat(file).then(() => true, () => false);
const proposalFile = (root) => path.join(root, '.loop', 'control', 'team.json');
const approvalFile = (root) => path.join(root, '.loop', 'control', 'team.approval.json');

async function project() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'team-test-')));
  await fs.mkdir(path.join(root, '.loop'), { recursive: true });
  return root;
}

const budget = { max_turns: 4, max_total_tokens: 10000, max_seconds: 30 };
const builder = (extra = {}) => ({
  id: 'builder-1', role: 'builder', provider: 'openai', execution_kind: 'managed_api', requested_model: 'gpt-test',
  allowed_resolved_models: ['gpt-test-2026-01-01'], tool_scope: ['list_files', 'read_file', 'write_file'],
  data_scope: { read_paths: ['**'], write_paths: ['src/**'] }, credential_env: 'TEAM_TEST_OPENAI_KEY', budget, ...extra,
});
const reviewer = (extra = {}) => ({
  id: 'reviewer-1', role: 'reviewer', provider: 'anthropic', execution_kind: 'managed_api', requested_model: 'claude-test',
  tool_scope: ['list_files', 'read_file'], data_scope: { read_paths: ['**'], write_paths: [] }, credential_env: 'TEAM_TEST_ANTHROPIC_KEY', budget, ...extra,
});
const apiTeam = (extra = {}) => ({ schema_version: 1, team_id: 'demo-team', mode: 'sequential', execution_policy: 'api_only', members: [builder(), reviewer()], ...extra });

async function approve(root, { channel = 'local-http-user' } = {}) {
  const team = await loadTeam(root);
  const receipt = { approval_id: team.proposal_id, setup_digest: team.team_digest, channel, approved_at: '2026-01-01T00:00:00Z', decision: 'APPROVE' };
  receipt.host_signature = await signApproval(root, receipt);
  await fs.writeFile(approvalFile(root), JSON.stringify(receipt));
  return receipt;
}

const refuses = (fn, code, pattern) => assert.throws(fn, (error) => error.code === code && (!pattern || pattern.test(error.message)));

test('validateTeam fills every default so equal teams normalize equally', () => {
  const normalized = validateTeam(apiTeam());
  assert.equal(normalized.max_active_packages, 1);
  assert.equal(normalized.max_active_agents, 2);
  assert.deepEqual(normalized.members[1].allowed_resolved_models, []);
  assert.equal(normalized.members[0].endpoint, null);
  const native = validateTeam({ schema_version: 1, team_id: 'native-team', mode: 'parallel', max_active_packages: 8, max_active_agents: 16, execution_policy: 'native_only', members: [
    { id: 'b', role: 'builder', provider: 'host', execution_kind: 'native', requested_model: 'host-default', tool_scope: [], data_scope: { read_paths: [], write_paths: [] } },
    { id: 'r', role: 'reviewer', provider: 'host', execution_kind: 'native', requested_model: 'host-default', tool_scope: [], data_scope: { read_paths: [], write_paths: [] } },
  ] });
  assert.equal(native.members[0].credential_env, null);
  assert.equal(native.members[0].budget, null);
  assert.deepEqual(validateTeam(native), native, 'validating a normalized team changes nothing');
});

test('validateTeam refuses unsafe or incoherent teams', () => {
  refuses(() => validateTeam(apiTeam({ max_active_packages: 2 })), 'INVALID_INPUT', /sequential/);
  refuses(() => validateTeam(apiTeam({ mode: 'parallel', max_active_packages: 9 })), 'INVALID_INPUT');
  refuses(() => validateTeam(apiTeam({ max_active_agents: 17 })), 'INVALID_INPUT');
  refuses(() => validateTeam(apiTeam({ max_active_agents: 0 })), 'INVALID_INPUT');
  refuses(() => validateTeam(apiTeam({ mode: 'round-robin' })), 'INVALID_INPUT');
  refuses(() => validateTeam(apiTeam({ execution_policy: 'anything' })), 'INVALID_INPUT');
  // There is no money budget and no generic authorization flag to set.
  refuses(() => validateTeam(apiTeam({ max_cost_eur: 5 })), 'UNKNOWN_FIELD');
  refuses(() => validateTeam(apiTeam({ authorized: true })), 'UNKNOWN_FIELD');
  refuses(() => validateTeam(apiTeam({ members: [builder({ budget: { ...budget, max_cost_eur: 5 } }), reviewer()] })), 'UNKNOWN_FIELD');
  // A reviewer is read-only; only a builder writes.
  refuses(() => validateTeam(apiTeam({ members: [builder(), reviewer({ tool_scope: ['read_file', 'write_file'], data_scope: { read_paths: ['**'], write_paths: ['src/**'] } })] })), 'INVALID_INPUT', /only a builder/);
  refuses(() => validateTeam(apiTeam({ members: [builder(), reviewer({ data_scope: { read_paths: ['**'], write_paths: ['src/**'] } })] })), 'INVALID_INPUT', /write_paths/);
  refuses(() => validateTeam(apiTeam({ members: [builder({ data_scope: { read_paths: ['**'], write_paths: [] } }), reviewer()] })), 'INVALID_INPUT', /write path/);
  // Roles, ids and paths.
  refuses(() => validateTeam(apiTeam({ members: [builder(), builder({ id: 'builder-2' })] })), 'INVALID_INPUT', /reviewer/);
  refuses(() => validateTeam(apiTeam({ members: [builder(), reviewer({ id: 'builder-1' })] })), 'INVALID_INPUT', /unique/);
  refuses(() => validateTeam(apiTeam({ members: [builder({ role: 'boss' }), reviewer()] })), 'INVALID_INPUT');
  refuses(() => validateTeam(apiTeam({ members: [builder({ data_scope: { read_paths: ['../secrets/**'], write_paths: ['src/**'] } }), reviewer()] })), 'UNSAFE_PATH');
  refuses(() => validateTeam(apiTeam({ members: [builder({ tool_scope: ['shell'] }), reviewer()] })), 'INVALID_INPUT');
  refuses(() => validateTeam(apiTeam({ members: [builder({ requested_model: 'bad model name' }), reviewer()] })), 'INVALID_INPUT');
  // Execution policy against execution kind.
  const cliReviewer = reviewer({ execution_kind: 'cli', credential_env: undefined, budget: undefined });
  refuses(() => validateTeam(apiTeam({ members: [builder(), cliReviewer] })), 'INVALID_INPUT', /api_only/);
  assert.equal(validateTeam(apiTeam({ execution_policy: 'hybrid', members: [builder(), cliReviewer] })).members[1].execution_kind, 'cli');
  refuses(() => validateTeam(apiTeam({ execution_policy: 'native_only' })), 'INVALID_INPUT', /native_only/);
  refuses(() => validateTeam(apiTeam({ execution_policy: 'hybrid', members: [builder({ provider: 'host' }), reviewer()] })), 'INVALID_INPUT', /managed_api requires/);
  refuses(() => validateTeam(apiTeam({ execution_policy: 'hybrid', members: [builder(), reviewer({ execution_kind: 'native', credential_env: undefined, budget: undefined })] })), 'INVALID_INPUT', /native requires/);
  // Credentials, endpoints and budgets.
  refuses(() => validateTeam(apiTeam({ members: [builder({ credential_env: undefined }), reviewer()] })), 'INVALID_INPUT', /credential_env/);
  refuses(() => validateTeam(apiTeam({ members: [builder({ credential_env: 'PATH' }), reviewer()] })), 'INVALID_INPUT', /reserved/);
  refuses(() => validateTeam(apiTeam({ members: [builder({ credential_env: 'LOOP_ROOT' }), reviewer()] })), 'INVALID_INPUT', /reserved/);
  refuses(() => validateTeam(apiTeam({ members: [builder({ endpoint: 'http://api.example.com/v1' }), reviewer()] })), 'INVALID_INPUT', /loopback/);
  refuses(() => validateTeam(apiTeam({ members: [builder({ endpoint: ['https://user', 'pw@api.example.com/v1'].join(':') }), reviewer()] })), 'INVALID_INPUT', /credentials/);
  refuses(() => validateTeam(apiTeam({ members: [builder({ provider: 'local', endpoint: 'https://api.example.com/v1' }), reviewer()] })), 'INVALID_INPUT', /loopback/);
  refuses(() => validateTeam(apiTeam({ members: [builder({ provider: 'local', credential_env: null }), reviewer()] })), 'INVALID_INPUT', /endpoint is required/);
  refuses(() => validateTeam(apiTeam({ members: [builder({ budget: undefined }), reviewer()] })), 'MISSING_INPUT');
  refuses(() => validateTeam(apiTeam({ members: [builder({ budget: { ...budget, max_turns: 65 } }), reviewer()] })), 'INVALID_INPUT');
  refuses(() => validateTeam(apiTeam({ execution_policy: 'hybrid', members: [builder(), reviewer({ execution_kind: 'cli', credential_env: undefined })] })), 'INVALID_INPUT', /budget/);
  refuses(() => validateTeam(apiTeam({ execution_policy: 'hybrid', members: [builder(), reviewer({ execution_kind: 'cli', budget: undefined })] })), 'INVALID_INPUT', /credential_env/);
  const local = validateTeam(apiTeam({ members: [builder({ provider: 'local', credential_env: null, endpoint: 'http://127.0.0.1:9/v1/' }), reviewer()] }));
  assert.equal(local.members[0].endpoint, 'http://127.0.0.1:9/v1');
});

test('a pasted key is refused as a credential reference and never repeated', () => {
  const secret = `sk-${'A1b2C3d4'.repeat(5)}`;
  for (const config of [
    apiTeam({ members: [builder({ credential_env: secret }), reviewer()] }),
    apiTeam({ members: [builder({ api_key: secret }), reviewer()] }),
  ]) {
    assert.throws(() => validateTeam(config), (error) => !error.message.includes(secret) && !JSON.stringify(error.details ?? {}).includes(secret));
  }
});

test('the published team schema names exactly the values validateTeam accepts', async () => {
  const schema = await readJson(path.join(repo, 'spec', 'schemas', 'team.schema.json'));
  const member = schema.$defs.member.properties;
  assert.deepEqual(schema.properties.mode.enum, [...TEAM_MODES]);
  assert.deepEqual(schema.properties.execution_policy.enum, [...EXECUTION_POLICIES]);
  assert.deepEqual(member.role.enum, [...TEAM_ROLES]);
  assert.deepEqual(member.provider.enum, [...TEAM_PROVIDERS]);
  assert.deepEqual(member.execution_kind.enum, [...EXECUTION_KINDS]);
  assert.deepEqual(member.tool_scope.items.enum, [...TEAM_TOOLS]);
  assert.equal(schema.properties.max_active_packages.default, 1);
  assert.equal(schema.properties.max_active_packages.maximum, 8);
  assert.equal(schema.properties.max_active_agents.default, 2);
  assert.equal(schema.properties.max_active_agents.maximum, 16);
  assert.deepEqual(Object.keys(member.budget.properties).sort(), ['max_seconds', 'max_total_tokens', 'max_turns']);
  const proposal = await readJson(path.join(repo, 'spec', 'schemas', 'team-proposal.schema.json'));
  assert.equal(proposal.properties.status.const, 'PAUSED');
  assert.ok(!Object.keys(proposal.properties).some((key) => /authori[sz]ed|approved|confirmed/.test(key)), 'no approval flag in the proposal');
  const readiness = await readJson(path.join(repo, 'spec', 'schemas', 'team-readiness.schema.json'));
  assert.deepEqual(readiness.properties.state.enum, ['verified', 'failed']);
});

test('team_configure stores a paused signed proposal and executes nothing', async () => {
  const root = await project();
  let calls = 0;
  const server = http.createServer((req, res) => { calls++; res.writeHead(500); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
    const config = apiTeam({ members: [builder({ endpoint }), reviewer({ endpoint })] });
    const result = await teamConfigure(root, { config });
    assert.equal(result.status, 'PAUSED');
    assert.equal(result.executed, false);
    assert.equal(result.approval_required, true);
    assert.match(result.team_digest, /^[a-f0-9]{64}$/);
    assert.equal(result.proposal_id, `team-${result.team_digest.slice(0, 32)}`);
    const record = await readJson(proposalFile(root));
    assert.equal(record.status, 'PAUSED');
    assert.equal(record.kind, 'team-proposal');
    assert.match(record.host_signature, /^[a-f0-9]{64}$/);
    assert.deepEqual(record.config, validateTeam(config));
    assert.equal(await exists(approvalFile(root)), false, 'configure never writes an approval');
    await teamStatus(root, { env: {} });
    assert.equal(calls, 0, 'neither configure nor status contacts a provider');

    const again = await teamConfigure(root, { config });
    assert.equal(again.unchanged, true);
    assert.equal(again.team_digest, result.team_digest);
    const changed = apiTeam({ team_id: 'other-team', members: [builder({ endpoint }), reviewer({ endpoint })] });
    await assert.rejects(teamConfigure(root, { config: changed }), { code: 'TEAM_EXISTS' });
    const replaced = await teamConfigure(root, { config: changed, replace: true });
    assert.notEqual(replaced.team_digest, result.team_digest);
    await assert.rejects(teamConfigure(root, { config, approve: true }), { code: 'UNKNOWN_FIELD' });
  } finally { server.close(); }
});

test('team_configure refuses while a node holds the workspace lock', async () => {
  const root = await project();
  await fs.writeFile(path.join(root, '.loop', 'engine.lock'), '');
  await assert.rejects(teamConfigure(root, { config: apiTeam() }), { code: 'WORKSPACE_LOCKED' });
  assert.equal(await exists(proposalFile(root)), false);
});

test('only a host-signed approval of the exact digest binds the team', async () => {
  const root = await project();
  await assert.rejects(verifyTeamBinding(root), { code: 'TEAM_NOT_CONFIGURED' });
  const first = await teamConfigure(root, { config: apiTeam() });
  await assert.rejects(verifyTeamBinding(root), { code: 'TEAM_APPROVAL_REQUIRED' });

  // A plain flag, or a receipt nobody signed, is not an approval.
  await fs.writeFile(approvalFile(root), JSON.stringify({ authorized: true }));
  await assert.rejects(verifyTeamBinding(root), { code: 'TEAM_APPROVAL_STALE' });
  await fs.writeFile(approvalFile(root), JSON.stringify({ approval_id: first.proposal_id, setup_digest: first.team_digest, channel: 'local-http-user', approved_at: '2026-01-01T00:00:00Z', decision: 'APPROVE', host_signature: 'a'.repeat(64) }));
  await assert.rejects(verifyTeamBinding(root), { code: 'TEAM_APPROVAL_UNTRUSTED' });
  await fs.writeFile(approvalFile(root), JSON.stringify({ approval_id: first.proposal_id, setup_digest: first.team_digest, channel: 'mcp-user', approved_at: '2026-01-01T00:00:00Z', decision: 'APPROVE', host_signature: 'a'.repeat(64) }));
  await assert.rejects(verifyTeamBinding(root), { code: 'TEAM_APPROVAL_UNTRUSTED' });

  await approve(root);
  const bound = await verifyTeamBinding(root);
  assert.equal(bound.bound, true);
  assert.equal(bound.team_digest, first.team_digest);
  assert.equal(bound.channel, 'local-http-user');
  await approve(root, { channel: 'interactive-tty' });
  assert.equal((await verifyTeamBinding(root)).channel, 'interactive-tty');

  // A changed team does not inherit the approval.
  await teamConfigure(root, { config: apiTeam({ team_id: 'changed-team' }), replace: true });
  await assert.rejects(verifyTeamBinding(root), { code: 'TEAM_APPROVAL_STALE' });
  assert.equal((await teamStatus(root, { env: {} })).approval.state, 'STALE');
});

test('a proposal edited on disk is untrusted', async () => {
  const root = await project();
  await teamConfigure(root, { config: apiTeam() });
  await approve(root);
  const record = await readJson(proposalFile(root));
  const edited = structuredClone(record);
  edited.config.members[0].requested_model = 'gpt-other';
  await fs.writeFile(proposalFile(root), JSON.stringify(edited));
  await assert.rejects(verifyTeamBinding(root), { code: 'TEAM_UNTRUSTED' });
  const status = await teamStatus(root, { env: {} });
  assert.equal(status.integrity, 'failed');
  assert.equal(status.ready, false);

  // Recomputing the digest does not help without the host key.
  const { jsonDigest } = await import('../control/common.mjs');
  const digest = jsonDigest(edited.config);
  await fs.writeFile(proposalFile(root), JSON.stringify({ ...edited, team_digest: digest, proposal_id: `team-${digest.slice(0, 32)}` }));
  await assert.rejects(verifyTeamBinding(root), { code: 'TEAM_UNTRUSTED' });
  await fs.writeFile(proposalFile(root), '{not json');
  await assert.rejects(verifyTeamBinding(root), { code: 'TEAM_UNTRUSTED' });
  await fs.writeFile(proposalFile(root), JSON.stringify(record));
  assert.equal((await verifyTeamBinding(root)).bound, true);
});

test('team_status reports readiness with its source and time, and host support as unverified', async () => {
  const root = await project();
  assert.equal((await teamStatus(root, { env: {} })).configured, false);
  const hybrid = apiTeam({ execution_policy: 'hybrid', members: [
    builder(),
    reviewer(),
    { id: 'host-analyst', role: 'analyst', provider: 'host', execution_kind: 'native', requested_model: 'host-default', tool_scope: [], data_scope: { read_paths: [], write_paths: [] } },
    { id: 'cli-reviewer', role: 'reviewer', provider: 'openai', execution_kind: 'cli', requested_model: 'gpt-test', tool_scope: [], data_scope: { read_paths: [], write_paths: [] } },
  ] });
  const { team_digest: digest } = await teamConfigure(root, { config: hybrid });
  const secret = 'team-status-secret-value';
  let status = await teamStatus(root, { env: { TEAM_TEST_OPENAI_KEY: secret } });
  assert.equal(status.approval.state, 'PENDING');
  assert.equal(status.ready, false);
  const byId = (s) => Object.fromEntries(s.members.map((member) => [member.id, member]));
  let members = byId(status);
  assert.equal(members['builder-1'].readiness.state, 'configured_unverified');
  assert.equal(members['builder-1'].readiness.source, 'none');
  assert.deepEqual(members['builder-1'].credential, { env: 'TEAM_TEST_OPENAI_KEY', present: true });
  assert.equal(members['reviewer-1'].readiness.state, 'failed');
  assert.equal(members['reviewer-1'].readiness.source, 'environment');
  assert.ok(members['reviewer-1'].readiness.checked_at);
  assert.equal(members['host-analyst'].readiness.state, 'configured_unverified');
  assert.match(members['host-analyst'].readiness.detail, /explicitly unverified/);
  assert.equal(members['cli-reviewer'].readiness.state, 'configured_unverified');
  assert.match(members['cli-reviewer'].readiness.detail, /explicitly unverified/);
  assert.equal(members['builder-1'].endpoint, 'https://api.openai.com/v1');
  assert.ok(!JSON.stringify(status).includes(secret), 'status never prints a credential');

  await recordReadiness(root, { member_id: 'builder-1', team_digest: digest, state: 'verified', source: 'provider-response', resolved_model: 'gpt-test-2026-01-01', detail: 'fixture' });
  await approve(root);
  status = await teamStatus(root, { env: { TEAM_TEST_OPENAI_KEY: secret, TEAM_TEST_ANTHROPIC_KEY: 'x' } });
  members = byId(status);
  assert.equal(status.approval.state, 'APPROVED');
  assert.equal(members['builder-1'].readiness.state, 'verified');
  assert.equal(members['builder-1'].readiness.source, 'provider-response');
  assert.equal(members['builder-1'].readiness.resolved_model, 'gpt-test-2026-01-01');
  assert.ok(Date.parse(members['builder-1'].readiness.checked_at) <= Date.now());
  assert.equal(members['reviewer-1'].readiness.state, 'configured_unverified');
  assert.equal(status.ready, false, 'unverified members keep the team from being ready');

  // A fresh record ages out.
  const realNow = Date.now;
  Date.now = () => realNow() + 25 * 3600 * 1000;
  try { assert.equal(byId(await teamStatus(root, { env: { TEAM_TEST_OPENAI_KEY: secret } }))['builder-1'].readiness.state, 'expired'); }
  finally { Date.now = realNow; }

  // A forged record is not evidence.
  const file = path.join(root, '.loop', 'scheduler', 'team', 'readiness', 'reviewer-1.json');
  const forged = { ...(await readJson(path.join(root, '.loop', 'scheduler', 'team', 'readiness', 'builder-1.json'))), member_id: 'reviewer-1' };
  await fs.writeFile(file, JSON.stringify(forged));
  members = byId(await teamStatus(root, { env: { TEAM_TEST_OPENAI_KEY: secret, TEAM_TEST_ANTHROPIC_KEY: 'x' } }));
  assert.equal(members['reviewer-1'].readiness.state, 'configured_unverified');
  assert.match(members['reviewer-1'].readiness.detail, /not signed/);

  // A failed provider response is reported as failed.
  await recordReadiness(root, { member_id: 'builder-1', team_digest: digest, state: 'failed', source: 'provider-response', resolved_model: 'gpt-other', detail: 'model not allowed' });
  members = byId(await teamStatus(root, { env: { TEAM_TEST_OPENAI_KEY: secret } }));
  assert.equal(members['builder-1'].readiness.state, 'failed');

  // Evidence for another team digest does not carry over.
  const other = { ...(await readJson(path.join(root, '.loop', 'scheduler', 'team', 'readiness', 'builder-1.json'))), team_digest: 'f'.repeat(64), state: 'verified' };
  const { host_signature, ...unsigned } = other;
  const view = { kind: 'team-readiness-v1', ...unsigned };
  other.host_signature = await signHostConfiguration(root, view);
  await fs.writeFile(path.join(root, '.loop', 'scheduler', 'team', 'readiness', 'builder-1.json'), JSON.stringify(other));
  members = byId(await teamStatus(root, { env: { TEAM_TEST_OPENAI_KEY: secret } }));
  assert.equal(members['builder-1'].readiness.state, 'configured_unverified');
  assert.match(members['builder-1'].readiness.detail, /another team proposal/);
});
