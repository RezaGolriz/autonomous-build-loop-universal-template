// The confirmation page reachable from a phone: the confirmation_page setting in
// .loop/control/policy.json, how it is validated, and what the server accepts.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { dispatch } from '../control/index.mjs';
import { confirmationPageBinding, confirmationPolicy, confirmationPolicyProblem, pageServerBinding } from '../control/common.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'confirm-page-store-')));
await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

async function project(policy) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'confirm-page-')));
  await fs.mkdir(path.join(root, '.loop', 'work-items'), { recursive: true });
  await fs.mkdir(path.join(root, '.loop', 'control'), { recursive: true });
  const state = JSON.parse(await fs.readFile(path.join(repo, 'template', '.loop', 'state.example.json'), 'utf8'));
  await fs.writeFile(path.join(root, '.loop', 'state.json'), JSON.stringify(state));
  await fs.copyFile(path.join(repo, 'template', '.loop', 'workflow.json'), path.join(root, '.loop', 'workflow.json'));
  await fs.copyFile(path.join(repo, 'template', 'work-items', 'WI-001-template.md'), path.join(root, '.loop', 'work-items', `${state.work_item_id}.md`));
  if (policy) await fs.writeFile(path.join(root, '.loop', 'control', 'policy.json'), JSON.stringify(policy));
  return root;
}

// Talk to the page on loopback while presenting the Host a phone would send.
function send(url, { method = 'GET', host, origin, body } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: target.port, path: `${target.pathname}${target.search}`, method,
      headers: { host, ...(origin ? { origin } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}) },
    }, (res) => { let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, text })); });
    req.on('error', reject);
    req.end(body);
  });
}

const valid = (page) => confirmationPolicyProblem({ schema_version: 1, confirmation_page: page });

test('confirmation_page is validated strictly', () => {
  assert.equal(valid({ listen: '0.0.0.0', advertise: '192.0.2.10', port: 8765 }), null);
  assert.equal(valid({ listen: '192.0.2.10', advertise: 'mac.example.net' }), null);
  assert.equal(valid({ listen: '127.0.0.1' }), null);
  assert.equal(valid({ listen: '::', advertise: '2001:db8::10' }), null);
  assert.match(valid({ listen: '0.0.0.0' }), /advertise is required/);
  assert.match(valid({ listen: '0.0.0.0', advertise: '192.0.2.10', port: 80 }), /port must be an integer from 1024 to 65535/);
  assert.match(valid({ listen: '0.0.0.0', advertise: '192.0.2.10', port: 8765.5 }), /port/);
  assert.match(valid({ listen: 'mac.example.net', advertise: 'mac.example.net' }), /listen must be an IPv4 or IPv6 address/);
  assert.match(valid({ listen: '0.0.0.0', advertise: 'http://192.0.2.10' }), /advertise must be a host name/);
  assert.match(valid({ listen: '0.0.0.0', advertise: '192.0.2.10:8765' }), /advertise must be a host name/);
  assert.match(valid({ listen: '0.0.0.0', advertise: '192.0.2.10', scheme: 'https' }), /unknown field\(s\): scheme/);
  assert.match(valid('0.0.0.0'), /must be an object/);
  // control_page_autostart is a plain boolean or absent.
  assert.equal(confirmationPolicyProblem({ schema_version: 1, control_page_autostart: false }), null);
  assert.equal(confirmationPolicyProblem({ schema_version: 1, control_page_autostart: true, confirmation_page: { listen: '127.0.0.1' } }), null);
  for (const bad of ['true', 1, null, {}]) assert.match(confirmationPolicyProblem({ schema_version: 1, control_page_autostart: bad }), /control_page_autostart must be true or false/);
  // Absent, and for a broken policy, both pages stay on loopback.
  assert.deepEqual(confirmationPageBinding(null), { listen: '127.0.0.1', advertise: '127.0.0.1', port: 0 });
  assert.deepEqual(confirmationPageBinding({ error: { code: 'INVALID_POLICY' }, confirmation_page: { listen: '0.0.0.0', advertise: 'x' } }), { listen: '127.0.0.1', advertise: '127.0.0.1', port: 0 });
});

test('a confirmation_page that does not validate is INVALID_POLICY, and check/status show a valid one', async () => {
  for (const page of [{ listen: '0.0.0.0' }, { listen: '0.0.0.0', advertise: '192.0.2.10', port: 22 }, { listen: 'mac.example.net', advertise: 'mac.example.net' }]) {
    const root = await project({ schema_version: 1, confirmation_page: page });
    const policy = await confirmationPolicy(root);
    assert.equal(policy.error?.code, 'INVALID_POLICY', JSON.stringify(page));
    assert.equal(policy.human_confirmation, 'tty-only');
    const refused = await dispatch(root, 'accept', { confirm: 'ACCEPT' }, { channel: 'cli-input' });
    assert.equal(refused.error.code, 'INVALID_POLICY');
    // A broken policy never opens a page to the network.
    assert.equal((await pageServerBinding(root)).listen, '127.0.0.1');
  }
  const root = await project({ schema_version: 1, confirmation_page: { listen: '0.0.0.0', advertise: '192.0.2.10', port: 8765 } });
  const expected = { listen: '0.0.0.0', advertise: '192.0.2.10', port: 8765 };
  assert.deepEqual((await dispatch(root, 'check', {})).policy.confirmation_page, expected);
  assert.deepEqual((await dispatch(root, 'status', {})).policy.confirmation_page, expected);
  const binding = await pageServerBinding(root);
  assert.equal(binding.origin(8765), 'http://192.0.2.10:8765');
  assert.deepEqual([...binding.allowedHosts(8765)].sort(), ['127.0.0.1:8765', '192.0.2.10:8765']);
  // Without the setting nothing is added to the output.
  assert.equal(Object.hasOwn((await dispatch(await project(), 'check', {})).policy, 'confirmation_page'), false);
});

test('the page link names the advertised host, and only that origin may post', async () => {
  // Autostart off: this is the one-request page, not the long-lived control page.
  const root = await project({ schema_version: 1, control_page_autostart: false, confirmation_page: { listen: '127.0.0.1', advertise: 'phone.test' } });
  await dispatch(root, 'backlog_add', { id: 'WI-050', title: 'Bounded change', outcome: 'A bounded change lands.' });
  const requested = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-050', allowed_paths: ['docs/guide.md'] });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  const link = new URL(requested.confirmation_url);
  assert.equal(link.hostname, 'phone.test');
  assert.ok(Number(link.port) > 0);
  const host = `phone.test:${link.port}`;

  // Plain loopback still works for the machine's own browser; a foreign Host does not.
  assert.equal((await send(requested.confirmation_url, { host: `127.0.0.1:${link.port}` })).status, 200);
  assert.equal((await send(requested.confirmation_url, { host: `evil.test:${link.port}` })).status, 403);
  const page = await send(requested.confirmation_url, { host });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(`name="request_digest" value="${requested.request_digest}"`));

  const body = `decision=AUTHORIZE&request_digest=${requested.request_digest}`;
  const foreign = await send(requested.confirmation_url, { method: 'POST', host, origin: `http://evil.test:${link.port}`, body });
  assert.equal(foreign.status, 403);
  assert.match(foreign.text, /Invalid Origin/);
  const authorization = path.join(root, '.loop', 'work-items', 'WI-050.authorization.json');
  assert.equal(await fs.stat(authorization).then(() => true, () => false), false);

  const confirmed = await send(requested.confirmation_url, { method: 'POST', host, origin: `http://${host}`, body });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.match(confirmed.text, /Confirmed/);
  assert.equal(await fs.stat(authorization).then(() => true, () => false), true);
});

// With the control page running, a confirmation link is a single-use link to it:
// it never carries the page's durable access token.
test('a confirmation link to the running control page is single-use and never the durable token', async (t) => {
  const { serveControlPage, stopControlPage } = await import('../control/control-page.mjs');
  const root = await project();
  t.after(() => stopControlPage(root).catch(() => {}));
  const { url } = await serveControlPage(root);
  await dispatch(root, 'backlog_add', { id: 'WI-051', title: 'Bounded change', outcome: 'A bounded change lands.' });
  const requested = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-051', allowed_paths: ['docs/guide.md'] });
  assert.equal(requested.control_page, true, JSON.stringify(requested));
  const token = (await fs.readFile(path.join(root, '.loop', 'scheduler', 'control-page.token'), 'utf8')).trim();
  assert.ok(!JSON.stringify(requested).includes(token));
  assert.match(requested.confirmation_url, /\/\?b=[A-Za-z0-9_-]{43}$/);
  const host = new URL(url).host;
  assert.equal((await send(requested.confirmation_url, { host })).status, 303);
  assert.equal((await send(requested.confirmation_url, { host })).status, 403, 'the link works once');
  // Asking again for the same decision hands out a fresh single-use link.
  const again = await dispatch(root, 'authorize', { confirm: 'AUTHORIZE', item_id: 'WI-051', allowed_paths: ['docs/guide.md'] });
  assert.equal(again.request_id, requested.request_id); assert.notEqual(again.confirmation_url, requested.confirmation_url);
});
