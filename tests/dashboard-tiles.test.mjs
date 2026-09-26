// The dashboard tiles for backlog, inbox, authorization, next-steps memory and
// the control logs. The renderer reads files only; it never runs a project
// command and it never derives a decision from what it reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderDashboard } from '../control/dashboard.mjs';

const NONCE = 'dashboard-tiles-nonce';
const iso = (seconds) => new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-tiles-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.loop/work-items'), { recursive: true });
  await write(root, '.loop/state.json', JSON.stringify({
    schema_version: 1, work_item_id: 'TEST-1', phase: 'EXECUTE', run_status: 'PAUSED',
    round: 1, max_rounds: 40, gates: {},
  }));
  await write(root, '.loop/work-items/TEST-1.md', '# TEST-1\n\nKind: feature\n');
  return root;
}
const write = async (root, relative, text) => {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), text);
};

const authorization = (overrides) => JSON.stringify({
  schema_version: 1, item_id: 'TEST-1', state: 'READY',
  scope: { allowed_paths: ['src/'] }, budget: { max_rounds: 12, max_wall_seconds: 900 },
  expires_at: iso(3600), stop_on_first_failure: true,
  authorized_by: 'cli-input', authorized_at: '2026-01-01T00:00:00Z', ...overrides,
});

test('the new tiles say "not available" while their files are missing', async (t) => {
  const html = await renderDashboard(await fixture(t), NONCE);
  for (const heading of ['Authorization of the current item', 'Backlog', 'Inbox', 'Last tick and last scout', 'Next-steps memory']) {
    assert.match(html, new RegExp(heading));
  }
  assert.match(html, /No authorization record exists/);
  assert.match(html, /No backlog file has been written yet/);
  assert.match(html, /No scout has written an inbox index yet/);
  assert.match(html, /Last tick: not available/);
  assert.match(html, /Last scout: not available/);
  assert.match(html, /No run has written a next-steps note yet/);
});

test('the authorization tile shows scope, budget and expiry, and flags the chat channel', async (t) => {
  const root = await fixture(t);
  await write(root, '.loop/work-items/TEST-1.authorization.json', authorization({ authorized_by: 'mcp-user' }));
  const html = await renderDashboard(root, NONCE);
  assert.match(html, /tag ready">READY/);
  assert.match(html, /authorized through a chat tool call/);
  assert.match(html, /12 rounds · 900 s wall clock/);
  assert.match(html, /<li>src\/<\/li>/);
  assert.doesNotMatch(html, /expired · a person has to authorize again/);
});

test('an expired authorization is marked expired instead of READY', async (t) => {
  const root = await fixture(t);
  await write(root, '.loop/work-items/TEST-1.authorization.json', authorization({ expires_at: iso(-3600) }));
  const html = await renderDashboard(root, NONCE);
  assert.match(html, /expired · a person has to authorize again/);
  assert.match(html, /tag paused">READY/);
});

test('the backlog tile counts READY and PAUSED items and escapes their titles', async (t) => {
  const root = await fixture(t);
  await write(root, '.loop/backlog.json', JSON.stringify({
    schema_version: 1,
    items: [
      { id: 'WI-100', title: '<b>queued</b>', added_at: '2026-01-01T00:00:00Z', work_kind: 'feature' },
      { id: 'WI-101', title: 'stale', added_at: '2026-01-01T00:00:00Z', work_kind: 'defect' },
      { id: 'WI-102', title: 'waiting', added_at: '2026-01-01T00:00:00Z', work_kind: 'maintenance' },
    ],
  }));
  await write(root, '.loop/work-items/WI-100.authorization.json', authorization({ item_id: 'WI-100' }));
  await write(root, '.loop/work-items/WI-101.authorization.json', authorization({ item_id: 'WI-101', expires_at: iso(-60) }));
  const html = await renderDashboard(root, NONCE);
  assert.match(html, /1 READY · 2 PAUSED · 3 shown/);
  assert.match(html, /&lt;b&gt;queued&lt;\/b&gt;/);
  assert.ok(!html.includes('<b>queued</b>'));
  assert.match(html, /class="flag">expired<\/span>/);
});

test('the inbox tile lists proposals and the tick tile reads only the last log line', async (t) => {
  const root = await fixture(t);
  await write(root, '.loop/inbox/index.json', JSON.stringify({
    schema_version: 1,
    items: [{ id: 'P-20260101T000000Z-1', title: 'a <proposal>', created_at: '2026-01-01T00:00:00Z', provider: 'mock', file: '.loop/inbox/P-20260101T000000Z-1.md' }],
  }));
  await write(root, '.loop/scheduler/tick.log', [
    '2026-01-01T00:00:00Z action=reported reason=older item=TEST-1 phase=DEFINE run_status=PAUSED',
    '2026-01-02T00:00:00Z action=ran-node reason=run-status-running item=TEST-1 phase=EXECUTE run_status=RUNNING',
    '',
  ].join('\n'));
  await write(root, '.loop/scheduler/scout.log', `${JSON.stringify({ at: '2026-01-02T00:00:00Z', event: 'scout', provider: 'mock', profile: 'cli', status: 'DONE', proposals: 2 })}\n`);
  await write(root, '.loop/notes/next-steps.md', '# Next steps\n\n- <i>keep going</i>\n');
  const html = await renderDashboard(root, NONCE);
  assert.match(html, /1 proposal\(s\) waiting for a person/);
  assert.match(html, /a &lt;proposal&gt;/);
  assert.match(html, /action <strong>ran-node<\/strong>/);
  assert.doesNotMatch(html, /<strong>reported<\/strong>/);
  assert.match(html, /2 proposal\(s\) · provider mock/);
  assert.match(html, /&lt;i&gt;keep going&lt;\/i&gt;/);
});

test('a broken backlog, inbox or log record degrades to "not available" instead of failing', async (t) => {
  const root = await fixture(t);
  await write(root, '.loop/backlog.json', 'not json');
  await write(root, '.loop/inbox/index.json', '[]');
  await write(root, '.loop/scheduler/scout.log', 'not json\n');
  const html = await renderDashboard(root, NONCE);
  assert.match(html, /No backlog file has been written yet/);
  assert.match(html, /No scout has written an inbox index yet/);
  assert.match(html, /Last scout: not available/);
});

test('the tiles refuse symlinked inputs', async (t) => {
  const root = await fixture(t);
  await write(root, '.loop/notes/elsewhere.md', '# elsewhere\n');
  await fs.symlink(path.join(root, '.loop/notes/elsewhere.md'), path.join(root, '.loop/notes/next-steps.md'));
  await assert.rejects(renderDashboard(root, NONCE), /symlink/);
});

test('a confirmation policy nobody can read is named on the dashboard, not replaced by the default', async (t) => {
  const root = await fixture(t);
  // A hand-written file with a misspelled key. Reading it as the permissive
  // default would tell a person the local page decides when it does not.
  await write(root, '.loop/control/policy.json', JSON.stringify({ schema_version: 1, human_confirmaton: 'tty-only' }));
  const html = await renderDashboard(root, NONCE);
  assert.match(html, /INVALID_POLICY/);
  assert.match(html, /unknown field\(s\): human_confirmaton/);
  assert.match(html, /Human confirmation mode for this project: <strong>tty-only<\/strong>/);

  // A file that says what the schema describes is shown as the mode it sets.
  await write(root, '.loop/control/policy.json', JSON.stringify({ schema_version: 1, human_confirmation: 'tty-or-local-page' }));
  const repaired = await renderDashboard(root, NONCE);
  assert.doesNotMatch(repaired, /INVALID_POLICY/);
  assert.match(repaired, /Human confirmation mode for this project: <strong>tty-or-local-page<\/strong>/);
  assert.doesNotMatch(repaired, /Confirmation page links point to/);

  // A page opened to the phone shows the address its links point to.
  await write(root, '.loop/control/policy.json', JSON.stringify({ schema_version: 1, confirmation_page: { listen: '0.0.0.0', advertise: '192.0.2.10', port: 8765 } }));
  assert.match(await renderDashboard(root, NONCE), /Confirmation page links point to <code>http:\/\/192\.0\.2\.10:8765<\/code>/);
});

test('a project-wide hold is shown as a banner, and an unreadable one still is', async (t) => {
  const root = await fixture(t);
  const html = await renderDashboard(root, NONCE);
  assert.doesNotMatch(html, /PROJECT ON HOLD/);
  await write(root, '.loop/control/hold.json', JSON.stringify({
    schema_version: 1, held_at: '2026-01-01T00:00:00Z', held_by: 'mcp-user',
    reason: 'the authorization for <b>TEST-1</b> was withdrawn', item_id: 'TEST-1',
  }));
  const held = await renderDashboard(root, NONCE);
  assert.match(held, /PROJECT ON HOLD/);
  assert.match(held, /the authorization for &lt;b&gt;TEST-1&lt;\/b&gt; was withdrawn/);
  assert.match(held, /held by mcp-user/);
  assert.match(held, /RELEASE/);
  // The banner comes before the status card.
  assert.ok(held.indexOf('PROJECT ON HOLD') < held.indexOf('>Status<'));
  await write(root, '.loop/control/hold.json', 'not a record');
  const broken = await renderDashboard(root, NONCE);
  assert.match(broken, /PROJECT ON HOLD/);
  assert.match(broken, /cannot be read/);
});
