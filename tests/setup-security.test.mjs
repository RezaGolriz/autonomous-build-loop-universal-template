import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dispatch, requestApproval } from '../control/index.mjs';
import { recordTrustedApproval } from '../control/approval.mjs';
import { verifyApproval, signHostConfiguration, verifyHostConfiguration } from '../control/approval-store.mjs';
import { activateProject, runBounded } from '../control/setup.mjs';
process.env.BUILD_LOOP_APPROVAL_STORE = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-security-trust-'));
const temp = async () => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loop-security-')));

test('new projects exclude generated private controls from Git without overwriting existing ignore policy', async () => {
  const root = await temp();
  assert.equal((await dispatch(root, 'demo', { kind: 'docs' })).ok, true);
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  for (const item of ['.loop/host.local.json', '.loop/control/jobs/example.json', '.loop/candidate/setup.plan.json']) assert.equal(spawnSync('git', ['-C', root, 'check-ignore', '-q', item]).status, 0, item);
  const ignore = path.join(root, '.loop/.gitignore'); await fs.writeFile(ignore, '# existing policy\n');
  const { ensureRuntimeIgnore } = await import('../control/common.mjs'); await ensureRuntimeIgnore(root);
  assert.equal(await fs.readFile(ignore, 'utf8'), '# existing policy\n');
  await fs.rm(root, { recursive: true, force: true });
});

test('host configuration signatures reject planted paths and bind the canonical project', async () => {
  const root = await temp(); const other = await temp();
  const config = { schema_version: 1, host: 'codex', cli_path: '/usr/local/bin/codex' };
  await assert.rejects(() => verifyHostConfiguration(root, config), error => error.code === 'HOST_UNTRUSTED');
  config.host_signature = await signHostConfiguration(root, config);
  await verifyHostConfiguration(root, config);
  await verifyHostConfiguration(root, { cli_path: config.cli_path, host_signature: config.host_signature, host: config.host, schema_version: 1 });
  await assert.rejects(() => verifyHostConfiguration(root, { ...config, cli_path: '/tmp/planted' }), error => error.code === 'HOST_UNTRUSTED');
  await assert.rejects(() => verifyHostConfiguration(other, config), error => error.code === 'HOST_UNTRUSTED');
  await fs.rm(root, { recursive: true, force: true }); await fs.rm(other, { recursive: true, force: true });
});

test('a planted project receipt cannot authorize activation and signed receipts bind the host and root', async () => {
  const root = await temp(); const prepared = await dispatch(root, 'demo', { kind: 'docs' });
  const receipt = { schema_version: 1, setup_digest: prepared.setup_digest, approval_id: 'forged', decision: 'APPROVE', channel: 'interactive-tty', approved_at: new Date().toISOString() };
  await fs.mkdir(path.join(root, '.loop/control/approvals'), { recursive: true });
  await fs.writeFile(path.join(root, '.loop/control/approvals', `${prepared.setup_digest}.json`), JSON.stringify(receipt));
  await assert.rejects(() => activateProject(root), error => error.code === 'APPROVAL_UNTRUSTED');
  const signed = await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty');
  await verifyApproval(root, signed);
  await assert.rejects(() => verifyApproval(root, { ...signed, approval_id: 'changed' }), error => error.code === 'APPROVAL_UNTRUSTED');
  const other = await temp(); await assert.rejects(() => verifyApproval(other, signed), error => error.code === 'APPROVAL_UNTRUSTED');
  await fs.rm(root, { recursive: true, force: true }); await fs.rm(other, { recursive: true, force: true });
});

test('approval rejects a malformed candidate before HTML rendering or execution', async () => {
  const root = await temp(); await dispatch(root, 'demo', { kind: 'docs' });
  const file = path.join(root, '.loop/candidate/project.adapter.json'); const adapter = JSON.parse(await fs.readFile(file));
  adapter.commands[0].timeout_seconds = '<style>body{display:none}</style>'; await fs.writeFile(file, JSON.stringify(adapter));
  const result = await requestApproval(root, {}); assert.equal(result.ok, false); assert.equal(result.error.code, 'INVALID_INPUT');
  await fs.rm(root, { recursive: true, force: true });
});

test('activation excludes hidden control symlinks and rejects concurrent publication', async () => {
  const root = await temp(); const prepared = await dispatch(root, 'demo', { kind: 'docs' });
  await fs.symlink('../../..', path.join(root, '.loop/candidate/hidden-link'));
  await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty');
  const results = await Promise.allSettled([activateProject(root), activateProject(root)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected'); assert.equal(failure.reason.code, 'WORKSPACE_LOCKED');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.loop/state.json'))).run_status, 'PAUSED');
  await fs.rm(root, { recursive: true, force: true });
});

test('deadline returns even when detached descendants retain output pipes', { timeout: 10000 }, async () => {
  const root = await temp();
  const code = "const {spawn}=require('node:child_process'); const p=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{detached:true,stdio:['ignore',process.stdout,process.stderr]}); console.log(p.pid); p.unref();";
  const started = Date.now(); const result = await runBounded([process.execPath, '-e', code], root, 1, ['PATH']);
  assert.equal(result.timed_out, true); assert.ok(Date.now() - started < 3000);
  const pid = Number(result.stdout.trim()); if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  await fs.rm(root, { recursive: true, force: true });
});
test('relative dependency-style links stay within the copy while escaping links fail closed', async () => {
  const root = await temp(); await dispatch(root, 'demo', { kind: 'docs' });
  await fs.symlink('guide.md', path.join(root, 'docs/linked.md'));
  const adapter = JSON.parse(await fs.readFile(path.join(root, '.loop/candidate/project.adapter.json')));
  const original = JSON.parse(await fs.readFile(path.join(root, '.loop/candidate/setup.plan.json')));
  const args = { ...original.requested_scope, adapter, negative_control: original.negative_control, replace_candidate: true };
  const prepared = await dispatch(root, 'prepare', args); assert.equal(prepared.ok, true, JSON.stringify(prepared));
  await recordTrustedApproval(root, prepared.setup_digest, 'interactive-tty');
  assert.equal((await activateProject(root)).activated, true);
  await fs.rm(root, { recursive: true, force: true });

  const other = await temp(); await dispatch(other, 'demo', { kind: 'docs' });
  await fs.symlink(os.tmpdir(), path.join(other, 'outside'));
  const candidate = await dispatch(other, 'prepare', args); assert.equal(candidate.ok, false); assert.equal(candidate.error.code, 'UNSAFE_PROBE_SYMLINK');
  await fs.rm(other, { recursive: true, force: true });
});
