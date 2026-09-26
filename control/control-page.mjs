// The control page: one long-lived local page per project that shows the
// dashboard and lets a person make the human decisions on it.
//
// This module manages the service from the outside — start it once, find it
// again, stop it, and hand out or replace its access token. The page itself is
// control/control-page-server.mjs. Nothing here records a decision: a decision
// made on the page goes through exactly the frozen-request, signed-receipt and
// settlement path of control/confirm.mjs and control/human-ops.mjs.
//
// Files, all under .loop/scheduler (machine-local and ignored by git):
//   control-page.json   {pid, origin, started_at, token_sha256}; pid is null once stopped,
//                       and the origin is kept so the next start reuses the same port
//   control-page.token  the durable access token, mode 0600; its link is <origin>/?k=<token>.
//                       It is printed only by `build-loop serve --show-link` at an
//                       interactive terminal, never into a chat or a tool result.
//   control-page-bootstrap/<sha256>.json
//                       single-use links: a random token, valid 10 minutes, taken
//                       once and traded for the session cookie (<origin>/?b=<token>).
//                       serve, dashboard and confirmation links hand out only these.
//                       Rotating the durable token removes every one of them.
//   control-page.log    the server's own error output, and one JSON line per
//                       autostart check {time, reason, action: started|already-running|failed};
//                       it never contains a token
//
// Self-healing. ensureControlPage brings the page up when it is not running.
// With control_page_autostart in effect (see controlPageAutostart) every tick,
// every state-changing operation, the dashboard and the chat connection call it,
// so no operating-system service is needed: after a reboot the next tick brings
// the page back.
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ControlError, acquireDirLock, assertControlPath, atomicJson, atomicText, confirmationPolicy, ensureRuntimeIgnore, exists, nonce, now, readJson, sha256,
} from './common.mjs';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'control-page-server.mjs');
const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
const bootstrapPattern = /^[A-Za-z0-9_-]{43}$/;
export const BOOTSTRAP_TTL_MS = 10 * 60_000;

export const controlPageFiles = (scheduler) => ({
  runtime: path.join(scheduler, 'control-page.json'),
  token: path.join(scheduler, 'control-page.token'),
  log: path.join(scheduler, 'control-page.log'),
  lock: path.join(scheduler, 'control-page.lock'),
  bootstrap: path.join(scheduler, 'control-page-bootstrap'),
});

async function files(root) {
  const { scheduler } = await assertControlPath(root);
  return controlPageFiles(scheduler);
}

export async function readControlPageToken(root) {
  const text = await fs.readFile((await files(root)).token, 'utf8').catch(() => null);
  const token = text?.trim();
  return token && tokenPattern.test(token) ? token : null;
}

// The token is made once and kept. A new one is only written by rotate.
export async function ensureControlPageToken(root) {
  const existing = await readControlPageToken(root);
  if (existing) return { token: existing, created: false };
  await ensureRuntimeIgnore(root);
  const token = nonce(32);
  await atomicText((await files(root)).token, `${token}\n`, 0o600);
  return { token, created: true };
}

// Constant-time comparison of a presented token with the stored one.
export function tokenMatches(presented, stored) {
  if (typeof presented !== 'string' || typeof stored !== 'string' || !stored) return false;
  const a = Buffer.from(sha256(presented), 'hex'); const b = Buffer.from(sha256(stored), 'hex');
  return timingSafeEqual(a, b);
}

export async function readControlPageRuntime(root) {
  const file = (await files(root)).runtime;
  if (!await exists(file)) return null;
  return readJson(file, 'control page runtime').catch(() => null);
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

// Ask the running page whether it is the recorded one. A pid alone could have
// been reused by an unrelated process after a crash. /healthz answers only
// `ok`; asked with ?pid=<n> it answers `ok` only when n is its own process id,
// so the answer reveals nothing a caller did not already know.
function probe(origin, listen, pid) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(origin); } catch { resolve(false); return; }
    const address = listen === '0.0.0.0' ? '127.0.0.1' : listen === '::' ? '::1' : (listen || '127.0.0.1');
    const req = http.request({ host: address, port: url.port, path: `/healthz?pid=${pid}`, method: 'GET', headers: { host: url.host }, timeout: 1500 }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', (chunk) => { if (text.length < 64) text += chunk; });
      res.on('end', () => resolve(res.statusCode === 200 && text === 'ok'));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

// The running page, or null. Alive means: the recorded process exists and the
// page on the recorded origin answers with that same process id.
export async function runningControlPage(root) {
  const runtime = await readControlPageRuntime(root);
  if (!runtime?.pid || typeof runtime.origin !== 'string' || !pidAlive(runtime.pid)) return null;
  if (runtime.pid === process.pid) return runtime;
  return await probe(runtime.origin, runtime.listen, runtime.pid) ? runtime : null;
}

export const controlPageLink = (origin, token) => `${origin}/?k=${encodeURIComponent(token)}`;

// ---- Single-use links ---------------------------------------------------------
// What a chat, a tool result or a script ever gets: a random token that opens
// one session, once, within ten minutes. Only its sha256 is stored, beside the
// sha256 of the durable token it was issued under, so rotating the durable token
// ends it too. The durable token itself never leaves the 0600 file except at an
// interactive terminal.

async function bootstrapDirectory(root, create) {
  const dir = (await files(root)).bootstrap;
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir).catch(() => null);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(dir) !== path.join(await fs.realpath(root), '.loop', 'scheduler', 'control-page-bootstrap')) {
    throw new ControlError('UNSAFE_CONTROL_PATH', 'refusing an unsafe .loop/scheduler/control-page-bootstrap');
  }
  return dir;
}

async function pruneBootstrap(dir) {
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const record = await readJson(path.join(dir, name)).catch(() => null);
    if (!record || !(record.expires_at_ms > Date.now())) await fs.rm(path.join(dir, name), { force: true });
  }
}

export async function issueBootstrapLink(root, origin) {
  const token = await readControlPageToken(root);
  if (!token) return null;
  const dir = await bootstrapDirectory(root, true);
  await pruneBootstrap(dir);
  const bootstrap = nonce(32);
  const expires = Date.now() + BOOTSTRAP_TTL_MS;
  await atomicJson(path.join(dir, `${sha256(bootstrap)}.json`), { schema_version: 1, expires_at_ms: expires, token_sha256: sha256(token) }, 0o600);
  return { link: `${origin}/?b=${bootstrap}`, expires_at: new Date(expires).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

// Takes a single-use token: at most once (the record is removed before it is
// honoured), only before it expires, and only while the durable token it was
// issued under is still the current one. Returns that durable token's sha256.
export async function redeemBootstrapToken(root, presented) {
  if (typeof presented !== 'string' || !bootstrapPattern.test(presented)) return null;
  const dir = await bootstrapDirectory(root, false).catch(() => null);
  if (!dir) return null;
  const file = path.join(dir, `${sha256(presented)}.json`);
  const record = await readJson(file).catch(() => null);
  if (!record) return null;
  const taken = await fs.unlink(file).then(() => true, () => false);
  if (!taken || !(record.expires_at_ms > Date.now())) return null;
  const current = await readControlPageToken(root);
  if (!current || typeof record.token_sha256 !== 'string' || record.token_sha256 !== sha256(current)) return null;
  return record.token_sha256;
}

export async function clearBootstrapTokens(root) {
  const dir = await bootstrapDirectory(root, false).catch(() => null);
  if (!dir) return;
  for (const name of await fs.readdir(dir).catch(() => [])) if (/^[0-9a-f]{64}\.json$/.test(name)) await fs.rm(path.join(dir, name), { force: true });
}

// A single-use link to the running page, or null when it is not running. Used
// for confirmation links: a pending request appears on the running page.
export async function runningControlPageLink(root) {
  const runtime = await runningControlPage(root);
  if (!runtime) return null;
  return (await issueBootstrapLink(root, runtime.origin))?.link ?? null;
}

async function waitFor(check, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

// One start at a time. A lock left behind by a crashed start is removed when
// the process that took it no longer exists.
async function withStartLock(lockDir, work) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const release = await acquireDirLock(lockDir, { operation: 'control-page' });
      try { return await work(); } finally { await release(); }
    } catch (error) {
      if (error.code !== 'WORKSPACE_LOCKED') throw error;
      const owner = await readJson(path.join(lockDir, 'owner.json')).catch(() => null);
      if (owner && !pidAlive(owner.pid)) { await fs.rm(lockDir, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new ControlError('CONTROL_PAGE_BUSY', 'another start of the control page is still in progress');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function describe(root, runtime, token, { started, created, showLink }) {
  const result = {
    ok: true,
    control_page: true,
    started,
    already_running: !started,
    url: runtime.origin,
    pid: runtime.pid,
    started_at: runtime.started_at,
    read_only_until_confirmed: true,
    next: 'Open the link in a browser on this machine, or on a phone inside your private network or VPN. Nothing is decided until a person types the decision word on the page.',
  };
  if (created) result.token_created = true;
  if (showLink) {
    // Only at an interactive terminal (bin/build-loop.mjs checks): the durable link.
    result.link = controlPageLink(runtime.origin, token);
    result.link_kind = 'durable';
  } else {
    const issued = await issueBootstrapLink(root, runtime.origin);
    result.link = issued.link;
    result.link_kind = 'single-use';
    result.link_expires_at = issued.expires_at;
    result.link_note = 'This link works once, within 10 minutes: opening it starts a 12-hour session in that browser. Ask again for a fresh one. The durable link is printed only by build-loop serve --root <project> --show-link at an interactive terminal.';
  }
  result.dashboard_url = result.link;
  return result;
}

// Start the page if it is not running, otherwise return the running one.
// A stale record (the process is gone, or its pid now belongs to something
// else) is replaced by a fresh start: on the policy's fixed port when it names
// one, otherwise on the port the page had last time, otherwise on a new one;
// the new page rewrites the runtime file, so every later link names it.
async function startControlPage(root) {
  const paths = await files(root);
  await ensureRuntimeIgnore(root);
  await fs.mkdir(path.dirname(paths.runtime), { recursive: true });
  return withStartLock(paths.lock, async () => {
    const { token, created } = await ensureControlPageToken(root);
    const running = await runningControlPage(root);
    if (running) return { runtime: running, token, created, started: false };
    const log = await fs.open(paths.log, 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [serverPath, root], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
      child.unref();
    } finally { await log.close(); }
    let exited = false; child.once('exit', () => { exited = true; });
    const runtime = await waitFor(async () => {
      if (exited) return 'exited';
      const record = await readControlPageRuntime(root);
      return record?.pid === child.pid ? record : null;
    }, 10_000);
    if (!runtime || runtime === 'exited') {
      if (!exited) { try { process.kill(child.pid, 'SIGTERM'); } catch {} }
      throw new ControlError('CONTROL_PAGE_FAILED', 'the control page did not start; see .loop/scheduler/control-page.log (with a fixed confirmation_page.port another program may be using that port)');
    }
    return { runtime, token, created, started: true };
  });
}

async function logAutostart(root, reason, action, extra = {}) {
  try {
    const { log } = await files(root);
    await fs.mkdir(path.dirname(log), { recursive: true });
    await fs.appendFile(log, `${JSON.stringify({ time: now(), reason: String(reason ?? 'unspecified').slice(0, 64), action, ...extra })}\n`, { mode: 0o600 });
  } catch {}
}

export async function serveControlPage(root, { showLink = false, reason = null } = {}) {
  let outcome;
  try { outcome = await startControlPage(root); }
  catch (error) { if (reason) await logAutostart(root, reason, 'failed', { code: error.code ?? 'CONTROL_PAGE_FAILED' }); throw error; }
  if (reason) await logAutostart(root, reason, outcome.started ? 'started' : 'already-running');
  return describe(root, outcome.runtime, outcome.token, { started: outcome.started, created: outcome.created, showLink });
}

// Whether the loop keeps the page up by itself. policy.json may say so with
// control_page_autostart; without it, a project that set confirmation_page (it
// wants the page) gets autostart, and any other project does not. A policy
// nobody can read never starts anything.
export function controlPageAutostart(policy) {
  if (!policy || policy.error) return false;
  if (typeof policy.control_page_autostart === 'boolean') return policy.control_page_autostart;
  return Boolean(policy.confirmation_page);
}

// Make sure the page is running. Never throws and never hands out a link: the
// result says what happened ({ok, action: started|already-running|failed}), and
// one line goes to control-page.log.
export async function ensureControlPage(root, { reason = 'unspecified' } = {}) {
  try {
    const running = await runningControlPage(root);
    if (running) {
      await logAutostart(root, reason, 'already-running');
      return { ok: true, action: 'already-running', pid: running.pid, url: running.origin };
    }
    const outcome = await startControlPage(root);
    await logAutostart(root, reason, outcome.started ? 'started' : 'already-running');
    return { ok: true, action: outcome.started ? 'started' : 'already-running', pid: outcome.runtime.pid, url: outcome.runtime.origin };
  } catch (error) {
    await logAutostart(root, reason, 'failed', { code: error?.code ?? 'CONTROL_PAGE_FAILED' });
    return { ok: false, action: 'failed', error: { code: error?.code ?? 'CONTROL_PAGE_FAILED', message: error instanceof Error ? error.message : 'the control page did not start' } };
  }
}

// ensureControlPage, but only when the project's policy asks for autostart.
// Never throws; { ok: true, action: 'skipped' } when autostart does not apply.
export async function autostartControlPage(root, { reason = 'unspecified' } = {}) {
  try {
    if (!controlPageAutostart(await confirmationPolicy(root))) return { ok: true, action: 'skipped' };
  } catch { return { ok: true, action: 'skipped' }; }
  return ensureControlPage(root, { reason });
}

export async function stopControlPage(root) {
  const paths = await files(root);
  const runtime = await readControlPageRuntime(root);
  const running = await runningControlPage(root);
  if (running) {
    try { process.kill(running.pid, 'SIGTERM'); } catch {}
    const gone = await waitFor(async () => !pidAlive(running.pid), 5000);
    if (!gone) { try { process.kill(running.pid, 'SIGKILL'); } catch {} }
  }
  if (runtime) await atomicJson(paths.runtime, { ...runtime, pid: null, stopped_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
  return { ok: true, control_page: true, stopped: Boolean(running), was_running: Boolean(running) };
}

// A new token. Every session opened with the old one stops working at once,
// because the page checks each session against the token currently on disk, and
// every single-use link issued under the old one is removed (and would be
// refused anyway: it names the old token's digest).
export async function rotateControlPageToken(root, { showLink = false } = {}) {
  const paths = await files(root);
  await ensureRuntimeIgnore(root);
  const token = nonce(32);
  await atomicText(paths.token, `${token}\n`, 0o600);
  await clearBootstrapTokens(root);
  const runtime = await readControlPageRuntime(root);
  if (runtime) await atomicJson(paths.runtime, { ...runtime, token_sha256: sha256(token) });
  const running = await runningControlPage(root);
  return {
    ok: true,
    control_page: true,
    rotated: true,
    running: Boolean(running),
    ...(running ? { url: running.origin, link: showLink ? controlPageLink(running.origin, token) : (await issueBootstrapLink(root, running.origin)).link, link_kind: showLink ? 'durable' : 'single-use' } : {}),
    next: running ? 'Old links and open sessions no longer work. Open the new link.' : 'The page is not running. Start it with build-loop serve; old links no longer work.',
  };
}
