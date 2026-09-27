// The long-lived control page for one project: the dashboard plus a decisions
// panel. Started by `build-loop serve` (control/control-page.mjs) or directly
// by a launchd or systemd service: node control/control-page-server.mjs <root>.
//
// Access. A link carries either a single-use token (/?b=<token>, what serve,
// dashboard and confirmation links hand out: valid once, within 10 minutes) or
// the project's durable token (/?k=<token>, printed only at an interactive
// terminal by build-loop serve --show-link). The page trades either for a
// session cookie (HttpOnly, SameSite=Strict, 12 hours) and redirects to /. The
// redirect keeps the token out of the address bar, but it does not erase it from
// browser history or a proxy log; that is why links handed to a chat are
// single-use. Everything else needs that session; without it the answer is 403.
// Each session is bound to the durable token it was opened under, so rotating
// the token ends every session, and every unused single-use link, at once.
//
// Decisions. A POST needs the session, the per-session CSRF value from the
// form, an allowed Host and an Origin that is exactly this page. At most ten
// decision POSTs a minute are taken, and five wrong words lock the word field
// for a minute. A decision goes through the same path as the one-request
// confirmation page: the operation first becomes a frozen request
// (control/human-ops.mjs), the typed word records the signed receipt
// (recordConfirmation in control/confirm.mjs), and settlement carries it out
// under the runner's own checks, with the channel local-http-user.
//
// Assurance is the same as the local confirmation page: somebody who could
// reach this page and had the link typed the word. It is not proof of who.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  assertControlPath, atomicJson, confirmationPolicy, ensureRuntimeIgnore, isLoopbackAddress, nonce, now, pageServerBinding, readJson, resolveRoot, sha256,
} from './common.mjs';
import { controlPageFiles, ensureControlPageToken, readControlPageRuntime, readControlPageToken, redeemBootstrapToken, tokenMatches } from './control-page.mjs';
import { humanOperations, listPendingConfirmations, recordConfirmation, requestDigest } from './confirm.mjs';
import { humanDecision, settleHumanDecisions } from './human-ops.mjs';
import { renderDashboard } from './dashboard.mjs';
import { backlogSummary, readAuthorization } from './backlog.mjs';
import { readInboxIndex } from './scout.mjs';
import { placeHold, readHold } from './hold.mjs';
import { check } from './check.mjs';
import { validateOperation } from './schemas.mjs';

const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'build_loop_session';
const MAX_SESSIONS = 64;
const POSTS_PER_MINUTE = 10;
const WRONG_WORDS = 5;
const LOCKOUT_MS = 60_000;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

let root;
try { root = await resolveRoot(process.argv[2]); }
catch (error) { process.stderr.write(`control page: ${error.message}\n`); process.exit(64); }
const { scheduler } = await assertControlPath(root);
const files = controlPageFiles(scheduler);
await ensureRuntimeIgnore(root);
await fs.mkdir(scheduler, { recursive: true });

// Another page for this project that is alive keeps its place.
const previous = await readControlPageRuntime(root);
if (previous?.pid && previous.pid !== process.pid) {
  let alive = false;
  try { process.kill(previous.pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
  if (alive) {
    const { runningControlPage } = await import('./control-page.mjs');
    if (await runningControlPage(root)) { process.stderr.write('control page: already running for this project\n'); process.exit(0); }
  }
}
await ensureControlPageToken(root);
const binding = await pageServerBinding(root);

// Sessions live in memory only: a restart asks for the link again.
const sessions = new Map();
const postTimes = [];
let wrongWords = 0; let lockedUntil = 0;
let decisionChain = Promise.resolve();
const serialized = (work) => { const run = decisionChain.then(work, work); decisionChain = run.catch(() => {}); return run; };

function cookies(req) {
  const jar = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) jar[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return jar;
}

async function currentTokenSha() {
  const token = await readControlPageToken(root);
  return token ? sha256(token) : null;
}

async function sessionOf(req) {
  const id = cookies(req)[COOKIE];
  if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) return null;
  const session = sessions.get(sha256(id));
  if (!session) return null;
  const tokenSha = await currentTokenSha();
  if (session.expires <= Date.now() || !tokenSha || session.token_sha256 !== tokenSha) { sessions.delete(sha256(id)); return null; }
  return session;
}

function openSession(tokenSha) {
  for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  const id = nonce(32);
  sessions.set(sha256(id), { csrf: nonce(32), expires: Date.now() + SESSION_MS, token_sha256: tokenSha, flash: null });
  return id;
}

function baseHeaders(res, scriptNonce = null) {
  res.setHeader('Cache-Control', 'no-store');
  // same-origin, not no-referrer: with no-referrer browsers post the decision
  // forms with "Origin: null", and the Origin check below refuses every decision.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; ${scriptNonce ? `script-src 'nonce-${scriptNonce}'; ` : ''}base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
}

function plain(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function readBody(req, limit = 16384) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('the submitted form is too large'), { status: 413 });
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

// ---- The decisions panel -------------------------------------------------

const csrfField = (session) => `<input type="hidden" name="csrf" value="${esc(session.csrf)}">`;

function pendingCard(request, session) {
  const word = humanOperations[request.operation];
  const rows = request.summary.map((entry) => `<dt>${esc(entry.label)}</dt><dd>${esc(entry.value)}</dd>`).join('');
  return `<div class="decision"><h3>${esc(request.operation)}${request.item_id ? ` · ${esc(request.item_id)}` : ''}</h3>`
    + `<dl>${rows}<dt>Request expires</dt><dd>${esc(request.expires_at)}</dd></dl>`
    + `<details><summary>Technical digest</summary><pre>${esc(JSON.stringify({ request_id: request.request_id, request_digest: requestDigest(request) }, null, 2))}</pre></details>`
    + `<form method="post" action="/decide">${csrfField(session)}`
    + `<input type="hidden" name="request_id" value="${esc(request.request_id)}">`
    + `<input type="hidden" name="request_digest" value="${esc(requestDigest(request))}">`
    + `<label for="w-${esc(request.request_id)}">Type <code>${esc(word)}</code> to confirm this exact decision</label>`
    + `<input id="w-${esc(request.request_id)}" name="decision" autocomplete="off" autocapitalize="characters" spellcheck="false" required>`
    + ` <button>Confirm this exact decision</button></form></div>`;
}

async function directActions(session, status) {
  const { loop } = await assertControlPath(root);
  const parts = [];
  const hold = await readHold(root).catch(() => null);
  if (status?.handover_ready) {
    parts.push(`<form method="post" action="/action">${csrfField(session)}<input type="hidden" name="action" value="accept">`
      + `<p>The run for <strong>${esc(status.work_item_id)}</strong> passed its HANDOVER gate${status.judge_verdict ? ` (review verdict ${esc(status.judge_verdict)})` : ''}.</p>`
      + `<button>Accept this run…</button></form>`);
  }
  const backlog = await backlogSummary(loop).catch(() => ({ items: [] }));
  const candidates = backlog.items.filter((item) => item.authorization_state !== 'READY' || item.authorization_expired).slice(0, 100);
  if (candidates.length) {
    const first = await readAuthorization(loop, candidates[0].id).catch(() => null);
    const valid = first && !first.invalid ? first : null;
    parts.push(`<form method="post" action="/action">${csrfField(session)}<input type="hidden" name="action" value="authorize">`
      + `<h3>Authorize a backlog item</h3>`
      + `<label for="a-item">Item</label><select id="a-item" name="item_id">${candidates.map((item) => `<option value="${esc(item.id)}">${esc(item.id)} · ${esc(item.title ?? '')}</option>`).join('')}</select>`
      + `<label for="a-paths">Allowed paths (one per line; leave empty to keep the item's earlier scope)</label><textarea id="a-paths" name="allowed_paths">${esc((valid?.scope?.allowed_paths ?? []).join('\n'))}</textarea>`
      + `<div class="row"><div><label for="a-rounds">Rounds</label><input id="a-rounds" name="max_rounds" inputmode="numeric" value="${esc(valid?.budget?.max_rounds ?? 40)}"></div>`
      + `<div><label for="a-wall">Wall clock (seconds; 14400 = 4 h)</label><input id="a-wall" name="max_wall_seconds" inputmode="numeric" value="${esc(valid?.budget?.max_wall_seconds ?? 14400)}"></div>`
      + `<div><label for="a-exp">Expires in (seconds; 86400 = 24 h)</label><input id="a-exp" name="expires_in_seconds" inputmode="numeric" value="86400"></div></div>`
      + `<label><input type="checkbox" name="stop_on_first_failure" value="true" checked> Stop on the first failure</label>`
      + `<button>Prepare this authorization…</button></form>`);
  }
  const inbox = await readInboxIndex(loop).catch(() => ({ items: [] }));
  for (const proposal of inbox.items.slice(0, 20)) {
    parts.push(`<form method="post" action="/action">${csrfField(session)}<input type="hidden" name="action" value="promote"><input type="hidden" name="proposal_id" value="${esc(proposal.id)}">`
      + `<p>Proposal <strong>${esc(proposal.id)}</strong> · ${esc(proposal.title ?? '')}</p><button>Promote into the backlog…</button></form>`);
  }
  if (hold) parts.push(`<form method="post" action="/action">${csrfField(session)}<input type="hidden" name="action" value="release"><p>The project is on hold: ${esc(hold.reason ?? 'no reason recorded')}</p><button>Release the hold…</button></form>`);
  else parts.push(holdForm(session));
  return parts.join('');
}

// Stopping is always offered, even while other decisions wait.
const holdForm = (session) => `<form method="post" action="/action">${csrfField(session)}<input type="hidden" name="action" value="hold"><h3>Hold</h3>`
  + `<label for="h-reason">Reason</label><input id="h-reason" name="reason" maxlength="4000" value="Held from the control page">`
  + ` <button>Hold everything now</button><small>Stopping is always safe, so this needs no word. Only a person can release it again.</small></form>`;

async function panel(session, message) {
  const policy = await confirmationPolicy(root).catch(() => ({ human_confirmation: 'tty-only', error: { message: 'the policy cannot be read' } }));
  const status = await check(root).catch(() => null);
  const pending = await listPendingConfirmations(root).catch(() => []);
  let body;
  if (policy.human_confirmation === 'tty-only') {
    body = `<p>This project accepts human decisions only as a word typed at an interactive terminal${policy.error ? ` (the policy file is broken: ${esc(policy.error.message)})` : ''}. Nothing can be decided on this page; run the command at your own terminal, for example <code>build-loop accept --root ${esc(root)}</code>.</p>`;
  } else if (pending.length) {
    body = `<p>${pending.length} decision(s) wait for you. Each shows exactly what will happen, frozen when it was asked for. Nothing is recorded until you type the word and press the button.</p>${pending.map((request) => pendingCard(request, session)).join('')}${await readHold(root).catch(() => null) ? '' : holdForm(session)}`;
  } else {
    const actions = await directActions(session, status);
    body = `<p>No decision is waiting. You can start one here; a button with … first shows you the exact frozen decision, and it is only recorded after you type its word.</p>${actions}`;
  }
  const flash = message ? `<p class="flash ${message.ok ? 'ok' : 'bad'}">${esc(message.text)}</p>` : '';
  const where = isLoopbackAddress(binding.listen) ? 'This page is served on this machine only.' : `This page is served on ${esc(binding.listen)} so a phone inside your private network or VPN can open it. Anyone who can reach it and has the link can act here.`;
  return `<style>.decisions input:not([type]),.decisions input[name=decision],.decisions input[inputmode]{font:inherit;padding:10px;border:1px solid #899bad;border-radius:6px;width:100%}.decisions form{margin:14px 0;padding:14px;border:1px solid #d8e0ea;border-radius:10px}.decisions .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.decisions dt{font-weight:650;margin-top:6px}.decisions dd{margin-left:0}.decision{border-top:1px solid #d8e0ea;padding-top:8px}.flash{padding:10px;border-radius:8px}.flash.ok{background:#dcfce7}.flash.bad{background:#fde2e2}</style>`
    + `<section class="card decisions" id="decisions"><h2>Decisions</h2>${flash}${body}<p class="muted">${where} A decision here is recorded with the assurance local-user-action: somebody with access to this page did it, which is not proof of who.</p></section>`;
}

async function renderPage(res, session, status = 200, message = null) {
  const scriptNonce = nonce(24);
  const flash = message ?? session.flash; session.flash = null;
  const html = await renderDashboard(root, scriptNonce, { label: 'Control page', panel: await panel(session, flash) });
  baseHeaders(res, scriptNonce);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function redirectHome(res, session, message) {
  if (message) session.flash = message;
  res.writeHead(303, { Location: '/' }); res.end();
}

// ---- Decisions ------------------------------------------------------------

async function decide(form, session, res) {
  if (Date.now() < lockedUntil) { plain(res, 429, 'Too many wrong words. Wait a minute, then try again.'); return; }
  const policy = await confirmationPolicy(root);
  if (policy.human_confirmation === 'tty-only') { await renderPage(res, session, 409, { ok: false, text: 'This project accepts decisions only at an interactive terminal. Nothing was recorded.' }); return; }
  const requestId = form.get('request_id') || '';
  const request = (await listPendingConfirmations(root)).find((entry) => entry.request_id === requestId);
  if (!request) { await renderPage(res, session, 409, { ok: false, text: 'That decision is no longer waiting (it was decided, expired or withdrawn). Nothing was recorded.' }); return; }
  const digest = requestDigest(request);
  if (form.get('request_digest') !== digest) { await renderPage(res, session, 409, { ok: false, text: 'This form does not belong to the decision on the page any more. Nothing was recorded; look at it again.' }); return; }
  const word = humanOperations[request.operation];
  const typed = (form.get('decision') || '').trim();
  if (typed !== word) {
    wrongWords += 1;
    if (wrongWords >= WRONG_WORDS) { wrongWords = 0; lockedUntil = Date.now() + LOCKOUT_MS; }
    await renderPage(res, session, 400, { ok: false, text: `Type ${word} exactly to confirm. Nothing was recorded.` });
    return;
  }
  wrongWords = 0;
  await recordConfirmation(root, requestId, typed, digest);
  const settled = await settleHumanDecisions(root);
  await fs.rm(path.join(scheduler, 'operation-runtime', `${requestId}.json`), { force: true });
  const outcome = settled.find((entry) => entry.request_id === requestId)?.result;
  if (outcome?.ok === false) redirectHome(res, session, { ok: false, text: `Not carried out: ${outcome.error?.message || 'the decision could not be carried out.'}` });
  else redirectHome(res, session, { ok: true, text: `Confirmed: the ${request.operation} decision was recorded and carried out (local-user-action).` });
}

const intField = (form, name) => {
  const raw = (form.get(name) || '').trim();
  if (!raw) return undefined;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
};

async function act(form, session, res) {
  const action = form.get('action');
  let args;
  if (action === 'hold') {
    args = {};
    const reason = (form.get('reason') || '').trim();
    if (reason) args.reason = reason;
    validateOperation('hold', args);
    await placeHold(root, args, 'local-http-user');
    redirectHome(res, session, { ok: true, text: 'The project is on hold. Nothing automated starts until a person releases it.' });
    return;
  }
  if (action === 'accept') args = { confirm: 'ACCEPT' };
  else if (action === 'release') args = { confirm: 'RELEASE' };
  else if (action === 'promote') args = { proposal_id: form.get('proposal_id') || '' };
  else if (action === 'authorize') {
    args = { confirm: 'AUTHORIZE', item_id: form.get('item_id') || '' };
    const paths = (form.get('allowed_paths') || '').split(/[\r\n,]+/).map((entry) => entry.trim()).filter(Boolean);
    if (paths.length) args.allowed_paths = [...new Set(paths)];
    for (const name of ['max_rounds', 'max_wall_seconds', 'expires_in_seconds']) {
      const value = intField(form, name);
      if (value !== undefined) args[name] = value;
    }
    args.stop_on_first_failure = form.get('stop_on_first_failure') === 'true';
  } else { plain(res, 400, 'Unknown action.'); return; }
  validateOperation(action, args);
  const result = await humanDecision(root, action, args, 'local-http-user');
  redirectHome(res, session, result?.pending_confirmation
    ? { ok: true, text: `Check the ${action} decision below, then type ${humanOperations[action]} to confirm it.` }
    : { ok: Boolean(result?.ok), text: result?.ok ? `${action} done.` : `${action} was not prepared.` });
}

// A decision form must come from this page. Browsers send its Origin; some
// send "null" or nothing (privacy settings, older referrer policies), and then
// Sec-Fetch-Site says whether the request came from this same origin. The
// form token (csrf) is checked in every case as well.
function sameOrigin(req, host) {
  const origin = String(req.headers.origin || '').toLowerCase();
  if (origin === `http://${host}`) return true;
  if (origin && origin !== 'null') return false;
  return String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'same-origin';
}

// ---- The server -------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const port = server.address().port;
    const host = String(req.headers.host || '').toLowerCase();
    if (!binding.allowedHosts(port).has(host)) { baseHeaders(res); plain(res, 403, 'Invalid Host.'); return; }
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch { plain(res, 400, 'Invalid URL.'); return; }
    baseHeaders(res);
    // Health: no session, and nothing but `ok`. With ?pid=<n> it answers `ok`
    // only when n is this process, so a caller can tell the recorded page from
    // another program that took its port, without learning anything new.
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const asked = url.searchParams.get('pid');
      if (asked !== null && asked !== String(process.pid)) { plain(res, 409, 'no'); return; }
      plain(res, 200, 'ok'); return;
    }
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('b')) {
      const tokenSha = await redeemBootstrapToken(root, url.searchParams.get('b'));
      if (!tokenSha) { plain(res, 403, 'This link is not valid any more: a single-use link works once, within 10 minutes, and not after the token was rotated. Ask for a fresh link (loop_serve, or build-loop serve).'); return; }
      const id = openSession(tokenSha);
      res.writeHead(303, { Location: '/', 'Set-Cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
      res.end(); return;
    }
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('k')) {
      const stored = await readControlPageToken(root);
      if (!tokenMatches(url.searchParams.get('k'), stored)) { plain(res, 403, 'This link is not valid (the token may have been rotated). Ask for a fresh link: build-loop serve.'); return; }
      const id = openSession(sha256(stored));
      res.writeHead(303, { Location: '/', 'Set-Cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
      res.end(); return;
    }
    const session = await sessionOf(req);
    if (!session) { plain(res, 403, 'Open the control page through a fresh link: build-loop serve (or loop_serve in a chat) prints a single-use one.'); return; }
    if (req.method === 'GET' && url.pathname === '/') { await renderPage(res, session); return; }
    if (req.method === 'POST' && (url.pathname === '/decide' || url.pathname === '/action')) {
      if (!sameOrigin(req, host)) { plain(res, 403, 'Invalid Origin.'); return; }
      const form = await readBody(req);
      if (!same(form.get('csrf') || '', session.csrf)) { plain(res, 403, 'Invalid form token. Reload the page and try again.'); return; }
      const minuteAgo = Date.now() - 60_000;
      while (postTimes.length && postTimes[0] < minuteAgo) postTimes.shift();
      if (postTimes.length >= POSTS_PER_MINUTE) { plain(res, 429, 'Too many decisions in a minute. Wait a little, then try again.'); return; }
      postTimes.push(Date.now());
      await serialized(async () => {
        try {
          if (url.pathname === '/decide') await decide(form, session, res);
          else await act(form, session, res);
        } catch (error) {
          if (res.headersSent) return;
          redirectHome(res, session, { ok: false, text: `Nothing was recorded: ${error.message}` });
        }
      });
      return;
    }
    plain(res, 405, 'Method not allowed.');
  } catch (error) {
    if (!res.headersSent) plain(res, error.status || 500, error.status ? error.message : 'The control page could not read the project state.');
    process.stderr.write(`control page: ${error.message}\n`);
  }
});
server.maxConnections = 32;
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

// Port: the policy's port when it names one; otherwise the port this page had
// last time, so a bookmarked link keeps working; otherwise a free one.
async function listen(port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError); server.once('listening', onListening);
    server.listen(port, binding.listen);
  });
}
let remembered = 0;
try { const origin = previous?.origin ? new URL(previous.origin) : null; if (origin && origin.hostname.replace(/^\[|\]$/g, '') === binding.advertise) remembered = Number(origin.port) || 0; } catch { remembered = 0; }
try {
  if (binding.port) await listen(binding.port);
  else {
    try { await listen(remembered); }
    catch (error) { if (remembered && error.code === 'EADDRINUSE') await listen(0); else throw error; }
  }
} catch (error) {
  process.stderr.write(`control page could not listen on ${binding.listen}:${binding.port || remembered}: ${error.message}\n`);
  process.exit(70);
}
server.on('error', (error) => process.stderr.write(`control page: ${error.message}\n`));
const origin = binding.origin(server.address().port);
await atomicJson(files.runtime, { pid: process.pid, origin, listen: binding.listen, started_at: now(), token_sha256: await currentTokenSha() });

function shutdown() {
  server.close(); server.closeAllConnections?.();
  readJson(files.runtime).then(async (runtime) => {
    if (runtime?.pid === process.pid) await atomicJson(files.runtime, { ...runtime, pid: null, stopped_at: now() });
  }).catch(() => {}).finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
