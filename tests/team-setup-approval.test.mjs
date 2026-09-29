import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dispatch } from '../control/index.mjs';
import { serveControlPage, stopControlPage } from '../control/control-page.mjs';
import { teamSetupSubject, authorizeTeamSetupsFrozen } from '../control/team-setup-approval.mjs';

process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'team-setup-trust-')));
await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

const team = { schema_version: 1, team_id: 'setup-batch', mode: 'parallel', max_active_packages: 2, max_active_agents: 2, execution_policy: 'native_only', members: ['builder', 'reviewer'].map(role => ({
  id: role, role, provider: 'host', execution_kind: 'native', requested_model: 'host-default', tool_scope: [], data_scope: { read_paths: [], write_paths: [] },
})) };

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'team-setup-parent-')));
  assert.equal((await dispatch(root, 'team_configure', { config: team })).ok, true);
  await serveControlPage(root);
  t.after(() => stopControlPage(root).catch(() => {}));
  const children = [];
  for (const id of ['first', 'second']) {
    const child = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'team-setup-child-')));
    children.push({ id, child });
    assert.equal((await dispatch(child, 'demo', { kind: 'docs' })).ok, true);
    assert.equal((await dispatch(root, 'package_add', { package_id: id, workspace_root: child, budget: { soft_seconds: 60, hard_ceiling_seconds: 60 } })).ok, true);
    assert.equal((await dispatch(root, 'package_control', { package_id: id, operation: 'request_approval' })).ok, true);
  }
  t.after(async () => { for (const { child } of children) await fs.rm(child, { recursive: true, force: true }); await fs.rm(root, { recursive: true, force: true }); });
  return { root, children };
}

test('a changed setup invalidates the whole frozen decision before any receipt', async t => {
  const { root, children } = await fixture(t);
  const original = await teamSetupSubject(root);
  assert.equal(original.packages.length, 2);
  assert.equal((await dispatch(children[1].child, 'configure', { host: 'mock', models: { default: 'changed' } })).ok, true);
  await assert.rejects(() => authorizeTeamSetupsFrozen(root, original, 'interactive-tty'), error => error.code === 'CONFIRMATION_STALE');
  assert.equal((await dispatch(root, 'team_status')).approval.state, 'PENDING');
  for (const { child } of children) {
    const plan = JSON.parse(await fs.readFile(path.join(child, '.loop', 'candidate', 'setup.plan.json'), 'utf8'));
    assert.equal(await fs.stat(path.join(child, '.loop', 'control', 'approvals', `${plan.setup_digest}.json`)).then(() => true, () => false), false);
  }
});

test('adding an unprepared package invalidates the frozen package set', async t => {
  const { root, children } = await fixture(t);
  const original = await teamSetupSubject(root);
  const third = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'team-setup-third-')));
  t.after(() => fs.rm(third, { recursive: true, force: true }));
  assert.equal((await dispatch(root, 'package_add', { package_id: 'third', workspace_root: third, budget: { soft_seconds: 60, hard_ceiling_seconds: 60 } })).ok, true);
  await assert.rejects(() => authorizeTeamSetupsFrozen(root, original, 'interactive-tty'), error => error.code === 'SETUP_NOT_PENDING');
  assert.equal((await dispatch(root, 'team_status')).approval.state, 'PENDING');
  for (const { child } of children) {
    const plan = JSON.parse(await fs.readFile(path.join(child, '.loop', 'candidate', 'setup.plan.json'), 'utf8'));
    assert.equal(await fs.stat(path.join(child, '.loop', 'control', 'approvals', `${plan.setup_digest}.json`)).then(() => true, () => false), false);
  }
});

test('combined decision also records the matching local API-child team approval', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'team-setup-api-parent-')));
  const child = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'team-setup-api-child-')));
  t.after(async () => { await stopControlPage(root).catch(() => {}); await fs.rm(child, { recursive: true, force: true }); await fs.rm(root, { recursive: true, force: true }); });
  const apiTeam = { schema_version: 1, team_id: 'api-batch', mode: 'sequential', max_active_packages: 1, max_active_agents: 2, execution_policy: 'api_only', members: ['builder', 'reviewer'].map(role => ({
    id: role, role, provider: 'mock', execution_kind: 'managed_api', requested_model: 'mock', endpoint: 'http://127.0.0.1:1/v1',
    tool_scope: role === 'builder' ? ['read_file', 'write_file'] : ['read_file'],
    data_scope: { read_paths: ['docs/**'], write_paths: role === 'builder' ? ['docs/**'] : [] },
    budget: { max_turns: 4, max_total_tokens: 1000, max_seconds: 30 },
  })) };
  assert.equal((await dispatch(root, 'team_configure', { config: apiTeam })).ok, true);
  assert.equal((await dispatch(child, 'demo', { kind: 'docs' })).ok, true);
  assert.equal((await dispatch(child, 'team_configure', { config: apiTeam })).ok, true);
  assert.equal((await dispatch(child, 'configure', { host: 'api' })).ok, true);
  assert.equal((await dispatch(root, 'package_add', { package_id: 'api-guide', workspace_root: child, budget: { soft_seconds: 60, hard_ceiling_seconds: 60 } })).ok, true);
  await serveControlPage(root);
  assert.equal((await dispatch(root, 'package_control', { package_id: 'api-guide', operation: 'request_approval' })).ok, true);
  const subject = await teamSetupSubject(root);
  assert.equal(subject.packages[0].child_team.team_digest, subject.team.team_digest);
  const result = await authorizeTeamSetupsFrozen(root, subject, 'interactive-tty');
  assert.equal(result.ok, true);
  assert.equal((await dispatch(root, 'team_status')).approval.state, 'APPROVED');
  assert.equal((await dispatch(child, 'team_status')).approval.state, 'APPROVED');
  assert.equal(await fs.stat(path.join(child, '.loop', 'state.json')).then(() => true, () => false), false);
});

test('an interactive terminal may use the combined path for a tty-only child', async t => {
  const { root, children } = await fixture(t);
  await fs.writeFile(path.join(children[0].child, '.loop', 'control', 'policy.json'), JSON.stringify({ human_confirmation: 'tty-only' }));
  await assert.rejects(() => teamSetupSubject(root), error => error.code === 'CONFIRMATION_TTY_ONLY');
  const displayed = await teamSetupSubject(root, 'interactive-tty');
  assert.equal(displayed.packages.length, 2);
  const confirmed = await authorizeTeamSetupsFrozen(root, displayed, 'interactive-tty');
  assert.equal(confirmed.ok, true);
});
