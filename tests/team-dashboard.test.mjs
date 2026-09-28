import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTeamProgress, renderTeamDashboard } from '../control/team-dashboard.mjs';

test('overall progress includes blocked packages and declares incomplete coverage', () => {
  const rows = [{ progress: { passed: 3, total: 5 } }, { status: 'BLOCKED', progress: { passed: 1, total: 4 } },
    { progress: { passed: 5, total: 5 }, accepted: true }, { progress: null }, { progress: { passed: 9, total: 2 } }];
  assert.deepEqual(aggregateTeamProgress(rows), { passed: 9, total: 14, assessed: 3, packages: 5, percent: 64, accepted: 1, integrated: 0 });
});

test('empty or invalid progress remains unknown rather than completed', () => {
  assert.equal(aggregateTeamProgress([]).percent, null);
  assert.equal(aggregateTeamProgress([{ progress: { passed: 0, total: 0 } }]).assessed, 0);
});

test('team dashboard escapes untrusted observations and labels gate-based progress accurately', () => {
  const html = renderTeamDashboard({ packages: [{ id: 'WI-1', title: '<script>alert(1)</script>', status: 'RUNNING',
    phase: 'EXECUTE', progress: { passed: 2, total: 6 }, blocker: '<img src=x onerror=alert(1)>',
    execution_kind: 'managed_api', reported_model: null }], members: [{ id: '<b>builder</b>', role: 'builder', provider: 'mock' }] }, '0123456789abcdef');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('runner-verified workflow gates'));
  assert.ok(html.includes('Unknown'));
  assert.ok(html.includes('Managed API agent'));
  assert.ok(html.includes('0 accepted by a person'));
  assert.throws(() => renderTeamDashboard({}, 'x" onload="alert(1)'), /nonce/);
});

test('team decisions have their own view while runtime detail stays collapsed', () => {
  const html = renderTeamDashboard({ packages: [{ id: 'one', progress: null }] }, '0123456789abcdef', {
    decisions: '<section id="decisions">Trusted control-page panel</section>', decisionCount: 2,
  });
  assert.match(html, /data-team-tab="decisions"[^>]*>Approvals <span class="team-badge">2<\/span>/);
  assert.match(html, /data-team-view="decisions" hidden/);
  assert.match(html, /<details class="team-runtime"><summary>Runtime and checkpoints/);
  assert.doesNotMatch(renderTeamDashboard({}, '0123456789abcdef'), /data-team-tab="decisions"/);
});
