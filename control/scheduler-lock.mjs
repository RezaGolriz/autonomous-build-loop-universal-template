import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicJson, ControlError, nonce, readJson } from './common.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

// Scheduler-only locks. Publish a complete owner directory atomically, so
// SIGKILL cannot leave a visible lock without an owner. A dead owner's lock
// is renamed to a NONEMPTY deterministic tombstone that is never reused or
// deleted: two recoverers cannot rename a later owner's directory over it.
// Engine/orchestrator locks are never touched by this helper.
export async function withSchedulerLock(directory, operation, fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  await fs.mkdir(path.dirname(directory), { recursive: true });
  const token = nonce(24);
  const candidate = `${directory}.candidate-${token}`;
  await fs.mkdir(candidate, { mode: 0o700 });
  let held = false;
  try {
    await atomicJson(path.join(candidate, 'owner.json'), { pid: process.pid, token, operation });
    while (!held) {
      try {
        // Preserve an existing empty legacy/unknown lock as well. Our own
        // protocol only ever publishes complete, nonempty owner directories.
        if (await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
          const occupied = new Error('Scheduler lock occupied'); occupied.code = 'EEXIST'; throw occupied;
        }
        await fs.rename(candidate, directory); held = true;
      }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        const stat = await fs.lstat(directory).catch(() => null);
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new ControlError('UNSAFE_SCHEDULER_LOCK', 'Unsafe scheduler lock.');
        const owner = await readJson(path.join(directory, 'owner.json')).catch(() => null);
        if (owner && Number.isInteger(owner.pid) && owner.pid > 0 && /^[A-Za-z0-9_-]{16,64}$/.test(owner.token ?? '') && !alive(owner.pid)) {
          await fs.rename(directory, `${directory}.retired-${owner.token}`).catch(e => {
            if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e;
          });
        } else {
          if (Date.now() >= deadline) throw new ControlError('SUPERVISOR_BUSY', `${operation}: lock owner is alive or cannot be verified; no lock was stolen.`);
          await sleep(15);
        }
      }
      if (!held && Date.now() >= deadline) throw new ControlError('SUPERVISOR_BUSY', `${operation}: scheduler lock unavailable.`);
    }
    return await fn();
  } finally {
    if (held) {
      const owner = await readJson(path.join(directory, 'owner.json'));
      if (owner.token !== token || owner.pid !== process.pid) throw new ControlError('SUPERVISOR_FENCE_LOST', 'Scheduler lock ownership changed.');
      // Retain the same retirement name even after normal release. A waiter
      // suspended after reading this token must not later rename a NEW owner
      // into this name after our process has exited.
      await fs.rename(directory, `${directory}.retired-${token}`);
    } else await fs.rm(candidate, { recursive: true, force: true });
  }
}
