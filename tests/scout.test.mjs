import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { dispatch, operations } from '../control/index.mjs';
import { signHostConfiguration } from '../control/approval-store.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mockProvider = path.join(repo, 'hosts', 'mock', 'provider.sh');
process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scout-approval-store-')));
await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

async function temporary() { return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scout-test-'))); }

// A small readable project with a loop directory, an adapter that names the
// profile, and no run in progress.
async function project({ allowNames = ['PATH'], projectKind = 'docs' } = {}) {
  const root = await temporary();
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(path.join(root, '.loop', 'work-items'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'greet.py'), 'def greeting(name):\n    return f"Hello, {name}!"\n');
  await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n\nA short guide.\n');
  await fs.writeFile(path.join(root, '.loop', 'project.adapter.json'), JSON.stringify({ schema_version: 1, project_kind: projectKind, environment: { allow_names: allowNames } }));
  return root;
}

// Everything except the inbox and the scout log: a scout may not touch any of it.
async function fingerprint(root) {
  const files = {};
  async function walk(directory, relative = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (rel === '.loop/inbox' || rel === '.loop/scheduler/scout.log') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, rel);
      else if (entry.isFile()) files[rel] = createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
      else files[rel] = entry.isSymbolicLink() ? `symlink:${await fs.readlink(absolute)}` : 'other';
    }
  }
  await walk(root);
  return files;
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

test('scout and the triage operations are offered with strict object schemas', () => {
  for (const name of ['scout', 'inbox_list', 'promote', 'discard']) {
    assert.ok(operations[name], name);
    assert.equal(typeof operations[name].description, 'string');
    assert.equal(operations[name].inputSchema.additionalProperties, false);
  }
  // A scout runs a bundled wrapper only: there is no provider path to supply.
  assert.deepEqual(Object.keys(operations.scout.inputSchema.properties), ['provider', 'profile', 'work_kind']);
  assert.deepEqual(operations.scout.inputSchema.required, []);
  assert.deepEqual(operations.promote.inputSchema.required, ['proposal_id']);
  assert.deepEqual(operations.discard.inputSchema.required, ['proposal_id']);
  assert.deepEqual(operations.inbox_list.inputSchema.required, []);
});

test('scout writes proposals and an index without changing anything else', async () => {
  const root = await project();
  const before = await fingerprint(root);
  const result = await dispatch(root, 'scout', { provider: 'mock' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'OK');
  assert.equal(result.provider, 'mock');
  assert.equal(result.profile, 'docs');
  assert.equal(result.proposals, 2);
  assert.equal(result.backlog_touched, false);

  const index = await readJson(path.join(root, '.loop', 'inbox', 'index.json'));
  assert.equal(index.schema_version, 1);
  assert.equal(index.items.length, 2);
  for (const [position, item] of index.items.entries()) {
    assert.match(item.id, /^P-\d{8}T\d{6}Z-\d$/);
    assert.equal(item.provider, 'mock');
    assert.equal(item.file, `.loop/inbox/${item.id}.md`);
    assert.equal(typeof item.title, 'string');
    assert.equal(typeof item.created_at, 'string');
    const text = await fs.readFile(path.join(root, '.loop', 'inbox', `${item.id}.md`), 'utf8');
    assert.match(text, new RegExp(`^# ${item.id}: `));
    assert.match(text, /Scout proposal written by the mock provider/);
    assert.match(text, /It is inert\./);
    assert.match(text, /## Evidence pointers/);
    if (position === 0) assert.match(text, /> A failing case for the greeting helper/);
  }

  // The backlog is untouched and the run is untouched.
  assert.equal(await fs.stat(path.join(root, '.loop', 'backlog.json')).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(root, '.loop', 'state.json')).then(() => true, () => false), false);

  // One JSON line per run in the scout log.
  const log = (await fs.readFile(path.join(root, '.loop', 'scheduler', 'scout.log'), 'utf8')).trim().split('\n');
  assert.equal(log.length, 1);
  const record = JSON.parse(log[0]);
  assert.equal(record.event, 'scout');
  assert.equal(record.status, 'OK');
  assert.equal(record.proposals, 2);
  assert.deepEqual(record.proposal_ids, index.items.map((item) => item.id));

  // Nothing outside the inbox and the scout log changed.
  const after = await fingerprint(root);
  assert.deepEqual(after, before);
});

test('scout refuses a caller-supplied provider path and reports a blocked provider', async () => {
  const root = await project({ allowNames: ['PATH', 'MOCK_SCRIPT'], projectKind: 'api' });
  const script = path.join(root, 'mock-script.json');
  await fs.writeFile(script, JSON.stringify({ SCOUT: 'block' }));
  process.env.MOCK_SCRIPT = script;
  try {
    const supplied = await dispatch(root, 'scout', { provider: 'mock', provider_path: mockProvider, profile: 'api' });
    assert.equal(supplied.ok, false);
    assert.equal(supplied.error.code, 'UNKNOWN_FIELD');
    const result = await dispatch(root, 'scout', { provider: 'mock', profile: 'api' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.proposals, 0);
    assert.equal((await readJson(path.join(root, '.loop', 'inbox', 'index.json'))).items.length, 0);
    assert.equal(JSON.parse((await fs.readFile(path.join(root, '.loop', 'scheduler', 'scout.log'), 'utf8')).trim()).status, 'BLOCKED');
  } finally { delete process.env.MOCK_SCRIPT; }
});

test('inbox_list, promote and discard move proposals by hand', async () => {
  const root = await project();
  await dispatch(root, 'scout', { provider: 'mock' });
  const listed = await dispatch(root, 'inbox_list', {});
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.inbox.count, 2);
  const [first, second] = listed.inbox.items;

  // Over a chat tool call promotion only asks; a typed terminal word decides.
  const asked = await dispatch(root, 'promote', { proposal_id: first.id, work_kind: 'defect' });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.pending_confirmation, true);
  assert.equal(asked.item_id, first.id);
  assert.match(asked.confirmation_url, /^http:\/\/127\.0\.0\.1:\d+\/confirm\?token=/);
  assert.equal(await fs.stat(path.join(root, '.loop', 'backlog.json')).then(() => true, () => false), false);

  const promoted = await dispatch(root, 'promote', { proposal_id: first.id, work_kind: 'defect' }, { channel: 'interactive-tty' });
  assert.equal(promoted.ok, true, JSON.stringify(promoted));
  assert.equal(promoted.item_id, 'WI-001');
  assert.equal(promoted.work_kind, 'defect');
  assert.equal(promoted.started, false);
  assert.equal(promoted.promoted_by, 'interactive-tty');

  // It is a backlog item now, written from the template, with what the scout saw.
  const backlog = await readJson(path.join(root, '.loop', 'backlog.json'));
  assert.deepEqual(backlog.items.map((item) => item.id), ['WI-001']);
  assert.equal(backlog.items[0].title, first.title);
  const workItem = await fs.readFile(path.join(root, '.loop', 'work-items', 'WI-001.md'), 'utf8');
  assert.match(workItem, /^# WI-001: /);
  assert.match(workItem, /Kind: defect/);
  assert.match(workItem, /> A failing case for the greeting helper/);
  assert.match(workItem, /- Do not change the greeting output itself\./);
  assert.match(workItem, /## Evidence pointers\n\n- tests\/test_greet\.py/);
  // The proposal left the inbox and is kept for the record.
  assert.equal(await fs.stat(path.join(root, '.loop', 'inbox', `${first.id}.md`)).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(root, '.loop', 'inbox', 'promoted', `${first.id}.md`)).then(() => true, () => false), true);
  assert.deepEqual((await readJson(path.join(root, '.loop', 'inbox', 'index.json'))).items.map((item) => item.id), [second.id]);

  const discarded = await dispatch(root, 'discard', { proposal_id: second.id });
  assert.equal(discarded.ok, true, JSON.stringify(discarded));
  assert.equal(discarded.discarded, true);
  assert.equal(discarded.discarded_by, 'mcp-user');
  assert.equal(await fs.stat(path.join(root, '.loop', 'inbox', 'discarded', `${second.id}.md`)).then(() => true, () => false), true);
  assert.deepEqual((await readJson(path.join(root, '.loop', 'inbox', 'index.json'))).items, []);

  // Both decisions are recorded with the channel they came through.
  const triage = (await fs.readFile(path.join(root, '.loop', 'scheduler', 'inbox.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(triage.map((entry) => entry.event), ['promote', 'discard']);
  assert.deepEqual(triage.map((entry) => entry.channel), ['interactive-tty', 'mcp-user']);

  // A proposal that is gone cannot be promoted or discarded again.
  const missing = await dispatch(root, 'promote', { proposal_id: second.id }, { channel: 'interactive-tty' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'PROPOSAL_NOT_FOUND');
});

test('check counts what the inbox index holds', async () => {
  const root = await project();
  assert.equal((await dispatch(root, 'check', {})).inbox, 0);
  await dispatch(root, 'scout', { provider: 'mock' });
  assert.equal((await dispatch(root, 'check', {})).inbox, 2);
  const [first] = (await dispatch(root, 'inbox_list', {})).inbox.items;
  await dispatch(root, 'discard', { proposal_id: first.id });
  assert.equal((await dispatch(root, 'check', {})).inbox, 1);
});

test('scout refuses while a managed job is running', async () => {
  const root = await project();
  const control = path.join(root, '.loop', 'control');
  await fs.mkdir(path.join(control, 'jobs'), { recursive: true });
  await fs.writeFile(path.join(control, 'jobs', 'job-active.json'), JSON.stringify({ schema_version: 1, job_id: 'job-active', status: 'RUNNING' }));
  await fs.writeFile(path.join(control, 'current-job.json'), JSON.stringify({ schema_version: 1, job_id: 'job-active' }));
  const result = await dispatch(root, 'scout', { provider: 'mock' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'JOB_ACTIVE');
  assert.equal(result.error.details.job_id, 'job-active');
  assert.equal(await fs.stat(path.join(root, '.loop', 'inbox')).then(() => true, () => false), false);
});

test('scout requires a provider when the project has none configured', async () => {
  const root = await project();
  const result = await dispatch(root, 'scout', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MISSING_INPUT');
  assert.deepEqual(result.error.details.missing_inputs, ['provider']);
});

test('a scout provider name is validated and only a bundled wrapper is executed', async () => {
  const root = await project();
  // Traversal, an unknown name and a non-string are all refused outright.
  for (const provider of ['../../../../bin/sh', '../mock', 'evil', '', 'MOCK', 1, null]) {
    const refused = await dispatch(root, 'scout', { provider });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.error.code, 'INVALID_INPUT', JSON.stringify(refused));
  }
  assert.equal(await fs.stat(path.join(root, '.loop', 'inbox')).then(() => true, () => false), false);
});

test('a configured provider path is ignored: the scout runs the bundled wrapper for that host', async () => {
  const root = await project();
  // A signed configuration that points the run at a provider of its own. The
  // scout takes the host name from it and nothing else.
  const impostor = path.join(root, 'impostor.sh');
  await fs.writeFile(impostor, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const config = { schema_version: 1, host: 'mock', provider_path: impostor, cli_path: null, review_host: 'mock', review_provider_path: impostor, review_cli_path: null, auth_check: null, review_auth_check: null, updated_at: '2026-01-01T00:00:00Z' };
  config.host_signature = await signHostConfiguration(root, config);
  await fs.writeFile(path.join(root, '.loop', 'host.local.json'), JSON.stringify(config));

  const result = await dispatch(root, 'scout', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.provider, 'mock');
  assert.equal(result.proposals, 2);
  const log = JSON.parse((await fs.readFile(path.join(root, '.loop', 'scheduler', 'scout.log'), 'utf8')).trim());
  assert.equal(log.provider_source, 'bundled-wrapper');
});

test('a signed SCOUT timeout reaches the scout provider and wins over the signed default', async () => {
  const root = await project({ allowNames: ['PATH', 'MOCK_SCRIPT'] });
  // The bundled mock provider sleeps 3s for SCOUT when told to; only a timeout
  // shorter than that can prove the signed value actually reached the run
  // instead of the built-in 900s letting it finish normally.
  const scriptFile = path.join(root, 'mock-scout.json');
  await fs.writeFile(scriptFile, JSON.stringify({ SCOUT: 'sleep' }));
  const config = { schema_version: 1, host: 'mock', provider_path: path.join(repo, 'hosts', 'mock', 'provider.sh'), cli_path: null, review_host: 'mock', review_provider_path: path.join(repo, 'hosts', 'mock', 'provider.sh'), review_cli_path: null, auth_check: null, review_auth_check: null, timeouts: { default: 5, SCOUT: 1 }, updated_at: '2026-01-01T00:00:00Z' };
  config.host_signature = await signHostConfiguration(root, config);
  await fs.writeFile(path.join(root, '.loop', 'host.local.json'), JSON.stringify(config));
  const previousScript = process.env.MOCK_SCRIPT; process.env.MOCK_SCRIPT = scriptFile;
  try {
    const started = Date.now();
    const result = await dispatch(root, 'scout', {});
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, 'SCOUT_PROVIDER_FAILED', JSON.stringify(result));
    assert.equal(result.error.details.timed_out, true, JSON.stringify(result));
    assert.ok(elapsed < 2500, `expected the SCOUT-specific 1s timeout to win over the 5s default and the 900s built-in (took ${elapsed}ms)`);
  } finally { if (previousScript === undefined) delete process.env.MOCK_SCRIPT; else process.env.MOCK_SCRIPT = previousScript; }
});
