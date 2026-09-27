// The long-lived control page: start, find again, stop; the single-use link, the
// durable token link and the session they open; and a decision made on the page going through the same
// frozen-request, receipt and settlement path as the one-request page.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { dispatch } from '../control/index.mjs';
import { ensureControlPage, rotateControlPageToken, serveControlPage, stopControlPage } from '../control/control-page.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'control-page-store-')));
await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'control-page-')));
  await fs.mkdir(path.join(root, '.loop', 'work-items'), { recursive: true });
  const state = JSON.parse(await fs.readFile(path.join(repo, 'template', '.loop', 'state.example.json'), 'utf8'));
  await fs.writeFile(path.join(root, '.loop', 'state.json'), JSON.stringify(state));
  await fs.copyFile(path.join(repo, 'template', '.loop', 'workflow.json'), path.join(root, '.loop', 'workflow.json'));
  await fs.copyFile(path.join(repo, 'template', 'work-items', 'WI-001-template.md'), path.join(root, '.loop', 'work-items', `${state.work_item_id}.md`));
  t.after(() => stopControlPage(root).catch(() => {}));
  return root;
}

function send(url, { method = 'GET', cookie, origin, body, host, fetchSite } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: target.port, path: `${target.pathname}${target.search}`, method,
      headers: {
        host: host ?? target.host,
        ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(fetchSite ? { 'sec-fetch-site': fetchSite } : {}),
        ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => { let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text })); });
    req.on('error', reject);
    req.end(body);
  });
}

async function login(link) {
  const answer = await send(link);
  assert.equal(answer.status, 303);
  assert.equal(answer.headers.location, '/');
  const set = answer.headers['set-cookie'][0];
  assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Lax/, 'Strict would be held back on the redirect after a link opened from another app'); assert.match(set, /Max-Age=43200/);
  return set.split(';')[0];
}

const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];
const form = (fields) => new URLSearchParams(fields).toString();
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('serve starts once, is idempotent, and records its runtime file', async (t) => {
  const root = await project(t);
  const first = await serveControlPage(root);
  assert.equal(first.ok, true); assert.equal(first.started, true); assert.equal(first.token_created, true);
  assert.match(first.link, /^http:\/\/127\.0\.0\.1:\d+\/\?b=[A-Za-z0-9_-]{43}$/);
  assert.equal(first.link_kind, 'single-use'); assert.ok(Date.parse(first.link_expires_at) > Date.now());
  const again = await serveControlPage(root);
  assert.equal(again.started, false); assert.equal(again.pid, first.pid); assert.equal(again.url, first.url);
  assert.match(again.link, /\?b=/); assert.notEqual(again.link, first.link, 'every call hands out a fresh single-use link');
  const durable = await serveControlPage(root, { showLink: true });
  assert.equal(durable.link_kind, 'durable'); assert.match(durable.link, /\?k=[A-Za-z0-9_-]{32,}$/);
  const runtime = await readJson(path.join(root, '.loop', 'scheduler', 'control-page.json'));
  for (const key of ['pid', 'origin', 'started_at', 'token_sha256']) assert.ok(runtime[key], key);
  assert.equal(runtime.pid, first.pid);
  const token = path.join(root, '.loop', 'scheduler', 'control-page.token');
  assert.equal((await fs.stat(token)).mode & 0o777, 0o600);
  assert.ok((await fs.readFile(path.join(root, '.loop', '.gitignore'), 'utf8')).includes('/scheduler/'));
  // A stale record (the process is gone) is replaced by a fresh start on the same port.
  process.kill(first.pid, 'SIGKILL');
  for (let wait = 0; wait < 50 && alive(first.pid); wait++) await new Promise((resolve) => setTimeout(resolve, 20));
  const restarted = await serveControlPage(root);
  assert.equal(restarted.started, true); assert.notEqual(restarted.pid, first.pid); assert.equal(restarted.url, first.url);
  // The dashboard operation now returns the control page.
  const board = await dispatch(root, 'dashboard');
  assert.equal(board.control_page, true); assert.equal(board.pid, restarted.pid); assert.match(board.dashboard_url, /\?b=[A-Za-z0-9_-]{43}$/);
  // Neither serve nor dashboard ever carries the durable token.
  const durableToken = (await fs.readFile(token, 'utf8')).trim();
  for (const answer of [board, await dispatch(root, 'serve')]) assert.ok(!JSON.stringify(answer).includes(durableToken), 'the durable token left the 0600 file');
});

test('the token opens a session; without one, or with a bad one, the page answers 403', async (t) => {
  const root = await project(t);
  const { link, url } = await serveControlPage(root);
  assert.equal((await send(`${url}/`)).status, 403);
  assert.equal((await send(`${url}/?k=wrong-token-wrong-token-wrong-token-x`)).status, 403);
  assert.equal((await send(`${url}/`, { cookie: 'build_loop_session=forgedforgedforgedforgedforged' })).status, 403);
  assert.equal((await send(link, { host: `evil.test:${new URL(url).port}` })).status, 403);
  const cookie = await login(link);
  const page = await send(`${url}/`, { cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /Decisions/); assert.match(page.text, /Control page/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page.headers['content-security-policy'], /script-src 'nonce-/);
  assert.equal(page.headers['referrer-policy'], 'same-origin', 'no-referrer would make browsers send Origin: null on the decision forms');
  assert.ok(!page.text.includes(new URL(link).searchParams.get('b')), 'the page never shows the token');
});

test('a pending authorize request is confirmed on the page and completes through the receipt path', async (t) => {
  const root = await project(t);
  const { link, url } = await serveControlPage(root);
  const cookie = await login(link);
  await dispatch(root, 'backlog_add', { id: 'WI-060', title: 'Bounded change', outcome: 'A bounded change lands.' });
  const requested = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-060', allowed_paths: ['docs/guide.md'] });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  assert.equal(requested.control_page, true);
  assert.ok(requested.confirmation_url.startsWith(`${url}/?b=`), 'the confirmation link is a single-use link to the running control page');
  assert.notEqual(requested.confirmation_url, link);
  const page = await send(`${url}/`, { cookie });
  assert.ok(page.text.includes(requested.request_id));
  assert.ok(page.text.includes(`name="request_digest" value="${requested.request_digest}"`));
  const csrf = csrfOf(page.text); assert.ok(csrf);
  const fields = { request_id: requested.request_id, request_digest: requested.request_digest, decision: 'AUTHORIZE' };
  const sidecar = path.join(root, '.loop', 'work-items', 'WI-060.authorization.json');

  assert.equal((await send(`${url}/decide`, { method: 'POST', cookie, origin: url, body: form(fields) })).status, 403, 'CSRF missing');
  assert.equal((await send(`${url}/decide`, { method: 'POST', cookie, origin: 'http://evil.test', body: form({ ...fields, csrf }) })).status, 403, 'wrong Origin');
  assert.equal((await send(`${url}/decide`, { method: 'POST', cookie, origin: 'null', body: form({ ...fields, csrf }) })).status, 403, 'Origin null without Sec-Fetch-Site');
  assert.equal((await send(`${url}/decide`, { method: 'POST', cookie, origin: 'null', fetchSite: 'cross-site', body: form({ ...fields, csrf }) })).status, 403, 'Origin null from another site');
  assert.equal((await send(`${url}/decide`, { method: 'POST', cookie, fetchSite: 'same-site', body: form({ ...fields, csrf }) })).status, 403, 'no Origin, same-site only');
  assert.equal((await send(`${url}/decide`, { method: 'POST', cookie, body: form({ ...fields, csrf }) })).status, 403, 'no Origin');
  assert.equal((await send(`${url}/decide`, { method: 'POST', origin: url, body: form({ ...fields, csrf }) })).status, 403, 'no session');
  assert.equal(await fs.stat(sidecar).then(() => true, () => false), false);

  // A browser that sends Origin: null for its own form is accepted through Sec-Fetch-Site.
  const done = await send(`${url}/decide`, { method: 'POST', cookie, origin: 'null', fetchSite: 'same-origin', body: form({ ...fields, csrf }) });
  assert.equal(done.status, 303, done.text);
  const record = await readJson(sidecar);
  assert.equal(record.state, 'READY'); assert.equal(record.authorized_by, 'local-http-user');
  const receipt = await readJson(path.join(root, '.loop', 'scheduler', 'operation-approvals', `${requested.request_id}.json`));
  assert.equal(receipt.channel, 'local-http-user'); assert.equal(receipt.request_digest, requested.request_digest); assert.ok(receipt.host_signature);
  const after = await send(`${url}/`, { cookie });
  assert.match(after.text, /Confirmed: the authorize decision was recorded/);
  assert.ok(!after.text.includes(`value="${requested.request_id}"`));
});

test('a decision prepared on the page appears frozen, and five wrong words lock the field', async (t) => {
  const root = await project(t);
  const { link, url } = await serveControlPage(root);
  const cookie = await login(link);
  await dispatch(root, 'backlog_add', { id: 'WI-061', title: 'Another change', outcome: 'Another change lands.' });
  let page = await send(`${url}/`, { cookie });
  const csrf = csrfOf(page.text);
  assert.match(page.text, /Authorize a backlog item/);
  const prepared = await send(`${url}/action`, { method: 'POST', cookie, origin: url, body: form({ csrf, action: 'authorize', item_id: 'WI-061', allowed_paths: 'docs/a.md\ndocs/b.md', max_rounds: '12', max_wall_seconds: '3600', expires_in_seconds: '7200', stop_on_first_failure: 'true' }) });
  assert.equal(prepared.status, 303, prepared.text);
  page = await send(`${url}/`, { cookie });
  const requestId = /name="request_id" value="([^"]+)"/.exec(page.text)?.[1];
  const digest = /name="request_digest" value="([^"]+)"/.exec(page.text)?.[1];
  assert.ok(requestId && digest, page.text.slice(0, 400));
  assert.match(page.text, /docs\/a\.md, docs\/b\.md/); assert.match(page.text, /12 rounds, 3600 seconds/);
  const frozen = await readJson(path.join(root, '.loop', 'scheduler', 'operation-requests', `${requestId}.json`));
  assert.equal(frozen.decision.record.budget.max_rounds, 12);
  for (let attempt = 0; attempt < 5; attempt++) {
    const wrong = await send(`${url}/decide`, { method: 'POST', cookie, origin: url, body: form({ csrf, request_id: requestId, request_digest: digest, decision: 'authorise' }) });
    assert.equal(wrong.status, 400);
  }
  const locked = await send(`${url}/decide`, { method: 'POST', cookie, origin: url, body: form({ csrf, request_id: requestId, request_digest: digest, decision: 'AUTHORIZE' }) });
  assert.equal(locked.status, 429);
  assert.equal(await fs.stat(path.join(root, '.loop', 'work-items', 'WI-061.authorization.json')).then(() => true, () => false), false);
  // Holding needs no word and is refused nothing.
  const held = await send(`${url}/action`, { method: 'POST', cookie, origin: url, body: form({ csrf, action: 'hold', reason: 'Stop from the phone' }) });
  assert.equal(held.status, 303);
  assert.equal((await readJson(path.join(root, '.loop', 'control', 'hold.json'))).held_by, 'local-http-user');
});

test('a single-use link opens one session, once, within its time', async (t) => {
  const root = await project(t);
  const { link, url } = await serveControlPage(root);
  const cookie = await login(link);
  assert.equal((await send(`${url}/`, { cookie })).status, 200);
  assert.equal((await send(link)).status, 403, 'a single-use link works only once');
  // An expired one is refused and removed.
  const late = (await serveControlPage(root)).link;
  const dir = path.join(root, '.loop', 'scheduler', 'control-page-bootstrap');
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  for (const name of await fs.readdir(dir)) {
    const file = path.join(dir, name); const record = await readJson(file);
    await fs.writeFile(file, JSON.stringify({ ...record, expires_at_ms: Date.now() - 1 }));
  }
  assert.equal((await send(late)).status, 403, 'an expired single-use link is refused');
  assert.equal((await send(`${url}/?b=${'x'.repeat(43)}`)).status, 403);
  // The durable link still opens a session.
  const durable = await serveControlPage(root, { showLink: true });
  assert.equal((await send(durable.link)).status, 303);
});

test('rotate invalidates the old links and sessions, and stop ends the process', async (t) => {
  const root = await project(t);
  const { link, url, pid } = await serveControlPage(root);
  const durable = (await serveControlPage(root, { showLink: true })).link;
  const cookie = await login(link);
  const unused = (await serveControlPage(root)).link;
  assert.equal((await send(`${url}/`, { cookie })).status, 200);
  const rotated = await rotateControlPageToken(root);
  assert.equal(rotated.ok, true); assert.notEqual(rotated.link, link); assert.equal(rotated.link_kind, 'single-use');
  assert.equal((await send(`${url}/`, { cookie })).status, 403);
  assert.equal((await send(durable)).status, 403, 'the old durable link is refused');
  assert.equal((await send(unused)).status, 403, 'a single-use link issued before the rotation is refused');
  const fresh = await login(rotated.link);
  assert.equal((await send(`${url}/`, { cookie: fresh })).status, 200);
  const stopped = await stopControlPage(root);
  assert.equal(stopped.stopped, true);
  assert.equal(alive(pid), false);
  assert.equal((await readJson(path.join(root, '.loop', 'scheduler', 'control-page.json'))).pid, null);
  await assert.rejects(send(`${url}/`, { cookie: fresh }));
});

// ---- Self-healing: autostart, stale records, /healthz, the log -------------------

const runtimeFile = (root) => path.join(root, '.loop', 'scheduler', 'control-page.json');
const logLines = async (root) => (await fs.readFile(path.join(root, '.loop', 'scheduler', 'control-page.log'), 'utf8').catch(() => ''))
  .split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
async function policy(root, record) {
  await fs.mkdir(path.join(root, '.loop', 'control'), { recursive: true });
  await fs.writeFile(path.join(root, '.loop', 'control', 'policy.json'), JSON.stringify({ schema_version: 1, ...record }));
}

test('a tick starts the control page when the policy sets confirmation_page, and logs it', async (t) => {
  const root = await project(t);
  await policy(root, { confirmation_page: { listen: '127.0.0.1' } });
  await dispatch(root, 'tick', {}, { channel: 'cli-input' });
  const runtime = await readJson(runtimeFile(root));
  assert.ok(Number.isInteger(runtime.pid) && alive(runtime.pid), 'the tick brought the page up');
  assert.equal((await send(`${runtime.origin}/healthz`)).text, 'ok');
  // A second tick finds it running and leaves it alone.
  await dispatch(root, 'tick', {}, { channel: 'cli-input' });
  assert.equal((await readJson(runtimeFile(root))).pid, runtime.pid);
  const lines = await logLines(root);
  assert.deepEqual(lines.map((line) => [line.reason, line.action]), [['tick', 'started'], ['tick', 'already-running']]);
  for (const line of lines) { assert.deepEqual(Object.keys(line).sort(), ['action', 'reason', 'time']); assert.ok(Date.parse(line.time)); }
  // A state-changing operation checks too, after it succeeded; a read-only one does not.
  await dispatch(root, 'backlog_add', { id: 'WI-070', title: 'Bounded change', outcome: 'A bounded change lands.' });
  await dispatch(root, 'check', {}); await dispatch(root, 'status', {});
  assert.deepEqual((await logLines(root)).map((line) => line.reason), ['tick', 'tick', 'backlog_add']);
});

test('control_page_autostart:false keeps the page down, and no policy means no autostart', async (t) => {
  const root = await project(t);
  await dispatch(root, 'tick', {}, { channel: 'cli-input' });
  await dispatch(root, 'backlog_add', { id: 'WI-071', title: 'Bounded change', outcome: 'A bounded change lands.' });
  assert.equal(await fs.stat(runtimeFile(root)).then(() => true, () => false), false, 'no policy: nothing starts');
  await policy(root, { control_page_autostart: false, confirmation_page: { listen: '127.0.0.1' } });
  await dispatch(root, 'tick', {}, { channel: 'cli-input' });
  await dispatch(root, 'hold', { reason: 'Stop for a moment' });
  assert.equal(await fs.stat(runtimeFile(root)).then(() => true, () => false), false, 'opted out: nothing starts');
  assert.deepEqual(await logLines(root), []);
  // Opting in without confirmation_page works too, and a held project still gets its page.
  await policy(root, { control_page_autostart: true });
  await dispatch(root, 'tick', {}, { channel: 'cli-input' });
  assert.ok(alive((await readJson(runtimeFile(root))).pid));
});

test('a stale runtime file is replaced: a dead pid gets a new process, and serve recovers too', async (t) => {
  const root = await project(t);
  await policy(root, { confirmation_page: { listen: '127.0.0.1' } });
  const first = await ensureControlPage(root, { reason: 'test' });
  assert.equal(first.ok, true); assert.equal(first.action, 'started');
  assert.ok(!('link' in first), 'ensureControlPage never hands out a link');
  process.kill(first.pid, 'SIGKILL');
  for (let wait = 0; wait < 50 && alive(first.pid); wait++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await readJson(runtimeFile(root))).pid, first.pid, 'the record still names the dead process');
  await dispatch(root, 'tick', {}, { channel: 'cli-input' });
  const second = await readJson(runtimeFile(root));
  assert.notEqual(second.pid, first.pid); assert.ok(alive(second.pid)); assert.equal(second.origin, first.url);
  // A pid that is alive but is not the page (here: this test process) is not trusted either.
  await fs.writeFile(runtimeFile(root), JSON.stringify({ ...second, pid: process.pid === second.pid ? 1 : process.ppid }));
  process.kill(second.pid, 'SIGKILL');
  for (let wait = 0; wait < 50 && alive(second.pid); wait++) await new Promise((resolve) => setTimeout(resolve, 20));
  const served = await dispatch(root, 'serve');
  assert.equal(served.started, true); assert.ok(alive(served.pid)); assert.notEqual(served.pid, second.pid);
  assert.equal((await readJson(runtimeFile(root))).pid, served.pid);
  const actions = (await logLines(root)).map((line) => `${line.reason}:${line.action}`);
  assert.deepEqual(actions, ['test:started', 'tick:started', 'serve:started']);
});

test('ensureControlPage reports a failure in its result and never throws', async (t) => {
  const root = await project(t);
  // The scheduler directory cannot be made: .loop/scheduler is a file.
  await fs.writeFile(path.join(root, '.loop', 'scheduler'), 'not a directory');
  const result = await ensureControlPage(root, { reason: 'test' });
  assert.equal(result.ok, false); assert.equal(result.action, 'failed'); assert.ok(result.error.code);
});

test('/healthz answers ok without a session, and nothing else does', async (t) => {
  const root = await project(t);
  const { url, pid } = await serveControlPage(root);
  const health = await send(`${url}/healthz`);
  assert.equal(health.status, 200); assert.equal(health.text, 'ok');
  assert.equal(health.headers['set-cookie'], undefined);
  assert.equal((await send(`${url}/healthz?pid=${pid}`)).text, 'ok');
  assert.notEqual((await send(`${url}/healthz?pid=${pid + 1}`)).text, 'ok', 'another pid is not this page');
  assert.equal((await send(`${url}/healthz`, { host: `evil.test:${new URL(url).port}` })).status, 403);
  for (const [route, method] of [['/', 'GET'], ['/healthz/', 'GET'], ['/health', 'GET'], ['/status', 'GET'], ['/decide', 'POST'], ['/action', 'POST'], ['/healthz', 'POST']]) {
    const answer = await send(`${url}${route}`, { method, ...(method === 'POST' ? { origin: url, body: '' } : {}) });
    assert.notEqual(answer.text, 'ok', `${method} ${route}`);
    assert.equal(answer.status, 403, `${method} ${route} needs a session`);
  }
});
