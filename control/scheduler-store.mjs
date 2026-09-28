import path from 'node:path';
import { promises as fs } from 'node:fs';
import { schedulerTrustDirectory, signSchedulerRecord, verifySchedulerRecord } from './approval-store.mjs';
import { atomicJson, ControlError, jsonDigest, readJson } from './common.mjs';
import { withSchedulerLock } from './scheduler-lock.mjs';

function keyFor(root, file) {
  const rel = path.relative(root, file);
  if (!rel.startsWith(`.loop${path.sep}scheduler${path.sep}`) || rel.includes('..')) throw new ControlError('UNSAFE_SCHEDULER_STORE', 'Only scheduler records may use this store.');
  return jsonDigest({ record_path: rel });
}
async function anchor(root, file, create = false) {
  const dir = await schedulerTrustDirectory(root, create);
  return dir ? path.join(dir, `${keyFor(root, file)}.json`) : null;
}
async function locked(privateFile, operation) {
  if (!privateFile) return operation();
  return withSchedulerLock(`${privateFile}.lock`, 'scheduler-record', operation);
}
async function existsPair(file, privateFile) {
  const local = await fs.lstat(file).catch(() => null);
  const saved = privateFile && await fs.lstat(privateFile).catch(() => null);
  if (local && !saved) throw new ControlError('SCHEDULER_RECORD_LOST', 'Private scheduler record is missing. Do not start a replacement job.');
  if (saved && (!saved.isFile() || saved.isSymbolicLink() || (saved.mode & 0o077))) throw new ControlError('UNSAFE_SCHEDULER_STORE', 'Unsafe private scheduler anchor.');
  if (!saved) return null;
  const value = await readJson(privateFile);
  return value;
}
export async function schedulerRecordExists(root, file) {
  const privateFile = await anchor(root, file);
  return locked(privateFile, async () => {
    const value = await existsPair(file, privateFile);
    if (!value) return false;
    await verifySchedulerRecord(root, keyFor(root, file), value);
    return value.kind !== 'scheduler-tombstone';
  });
}
export async function saveSchedulerRecord(root, file, record) {
  const { host_signature, ...value } = record;
  const privateFile = await anchor(root, file, true);
  return locked(privateFile, async () => {
    value.host_signature = await signSchedulerRecord(root, keyFor(root, file), value);
    // The private signed record is authoritative. The workspace file is a
    // recoverable projection; a crash between writes never resets counters.
    await atomicJson(privateFile, value, 0o600);
    await atomicJson(file, value, 0o600);
  });
}
export async function readSchedulerRecord(root, file) {
  const privateFile = await anchor(root, file);
  return locked(privateFile, async () => {
    const saved = await existsPair(file, privateFile);
    if (!saved || saved.kind === 'scheduler-tombstone') throw new ControlError('SCHEDULER_UNTRUSTED', 'Missing scheduler record.');
    await verifySchedulerRecord(root, keyFor(root, file), saved);
    const stat = await fs.lstat(file).catch(() => null);
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)) throw new ControlError('SCHEDULER_UNTRUSTED', 'Unsafe scheduler record.');
    const value = stat ? await readJson(file) : null;
    if (value) await verifySchedulerRecord(root, keyFor(root, file), value);
    if (!value || jsonDigest(value) !== jsonDigest(saved)) await atomicJson(file, saved, 0o600);
    return saved;
  });
}

export async function deleteSchedulerRecord(root, file) {
  // Keep a signed deletion in both locations, so a restored old intent or
  // lease cannot become effective again and an absent index cannot reset it.
  await saveSchedulerRecord(root, file, { kind: 'scheduler-tombstone' });
}
