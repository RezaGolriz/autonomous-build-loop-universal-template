import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deleteSchedulerRecord, readSchedulerRecord, saveSchedulerRecord, schedulerRecordExists } from '../control/scheduler-store.mjs';
import { withSchedulerLock } from '../control/scheduler-lock.mjs';
import { spawn } from 'node:child_process';

process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-trust-test-')));
await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

test('private latest records restore a lost projection without rolling back counters; wrong identity and tampering block', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-rollback-test-')));
  const dir = path.join(root, '.loop', 'scheduler', 'supervisor', 'jobs'); await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'first.json');
  assert.equal(await schedulerRecordExists(root, file), false);
  await saveSchedulerRecord(root, file, { kind: 'supervisor-job', elapsed_ms: 10 });
  const old = await fs.readFile(file);
  await saveSchedulerRecord(root, file, { kind: 'supervisor-job', elapsed_ms: 20 });
  const latest = await fs.readFile(file);
  await fs.writeFile(file, old);
  assert.equal((await readSchedulerRecord(root, file)).elapsed_ms, 20);
  await fs.writeFile(file, latest);
  assert.equal((await readSchedulerRecord(root, file)).elapsed_ms, 20);
  const changed = JSON.parse(latest); changed.elapsed_ms = 0; await fs.writeFile(file, JSON.stringify(changed));
  await assert.rejects(() => readSchedulerRecord(root, file), e => e.code === 'SCHEDULER_UNTRUSTED');
  await fs.unlink(file);
  assert.equal(await schedulerRecordExists(root, file), true);
  assert.equal((await readSchedulerRecord(root, file)).elapsed_ms, 20);
  const other = path.join(dir, 'second.json'); await saveSchedulerRecord(root, other, { kind: 'supervisor-job', elapsed_ms: 20 });
  await fs.writeFile(other, latest);
  await assert.rejects(() => readSchedulerRecord(root, other), e => e.code === 'SCHEDULER_UNTRUSTED');
  await deleteSchedulerRecord(root, file);
  await fs.writeFile(file, latest);
  assert.equal(await schedulerRecordExists(root, file), false, 'restoring an old intent cannot undo its signed deletion');
});

test('SIGKILL of a scheduler lock owner permits safe recovery; live and unknown owners are not stolen', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-lock-test-')));
  const lock = path.join(root, 'short.lock');
  const moduleUrl = new URL('../control/scheduler-lock.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {withSchedulerLock} from ${JSON.stringify(moduleUrl)}; await withSchedulerLock(${JSON.stringify(lock)}, 'fixture', async()=>{process.stdout.write('held\\n'); await new Promise(r=>setTimeout(r,30000));});`], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  await assert.rejects(() => withSchedulerLock(lock, 'live', async () => {}, 30), e => e.code === 'SUPERVISOR_BUSY');
  const exit = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exit;
  let used = false; await withSchedulerLock(lock, 'recovery', async () => { used = true; });
  assert.equal(used, true);
  assert.ok((await fs.readdir(root)).some(x => x.includes('.retired-')));
  await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner.json'), '{}');
  await assert.rejects(() => withSchedulerLock(lock, 'unknown', async () => {}, 30), e => e.code === 'SUPERVISOR_BUSY');
  await fs.unlink(path.join(lock, 'owner.json'));
  await assert.rejects(() => withSchedulerLock(lock, 'empty-legacy', async () => {}, 30), e => e.code === 'SUPERVISOR_BUSY');
});

test('a reclaimer suspended across normal release cannot retire the next owner', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-stale-observation-')));
  const lock = path.join(root, 'short.lock'); let old;
  await withSchedulerLock(lock, 'old', async () => { old = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'))); });
  await withSchedulerLock(lock, 'new', async () => {
    const current = JSON.parse(await fs.readFile(path.join(lock, 'owner.json')));
    await assert.rejects(() => fs.rename(lock, `${lock}.retired-${old.token}`), e => ['EEXIST', 'ENOTEMPTY'].includes(e.code));
    assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'))).token, current.token);
  });
});
