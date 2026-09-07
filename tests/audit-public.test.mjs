import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { audit, scanText } from '../tools/audit-public.mjs';

test('audit reports locations and categories without returning secret or personal values', () => {
  const token = ['ghp', '_', 'x'.repeat(40)].join('');
  const email = ['person', '@', 'private-domain', '.example'].join('');
  const path = ['/Users', 'private-person', 'project'].join('/');
  const findings = scanText([token, email, path].join('\n'));
  assert.deepEqual(findings.map(f => f.rule).sort(), ['personal-path', 'private-email', 'provider-token']);
  assert.equal(JSON.stringify(findings).includes(token), false);
  assert.equal(JSON.stringify(findings).includes(email), false);
});
test('audit keeps intentional dummy data, local config filenames and public tool attribution', () => {
  assert.deepEqual(scanText('fixture@example.invalid maintainer@users.noreply.github.com noreply@anthropic.com .loop/host.local.json /Users/example/project'), []);
});
test('history scan finds deleted credential content and private commit metadata without changing refs', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-audit-test-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    const email = ['person', '@', 'private-domain', '.example'].join('');
    const token = ['ghp', '_', 'y'.repeat(40)].join('');
    writeFileSync(join(root, 'old.txt'), token);
    git('add', 'old.txt'); git('-c', 'user.name=Example Contributor', '-c', `user.email=${email}`, 'commit', '-qm', 'initial');
    git('rm', '-q', 'old.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'remove');
    const before = git('rev-parse', 'HEAD');
    const report = audit(root, { history: true });
    assert.equal(report.commits, 2);
    assert.ok(report.findings.some(f => f.area === 'history-blob' && f.rule === 'provider-token'));
    assert.ok(report.findings.some(f => f.area === 'history-metadata'));
    assert.equal(git('rev-parse', 'HEAD'), before);
    assert.equal(JSON.stringify(report).includes(token), false);
    assert.equal(JSON.stringify(report).includes(email), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
