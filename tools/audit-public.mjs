#!/usr/bin/env node
// Read-only, heuristic leak review. Never prints matched values or rewrites history.
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function scanText(text, extraPatterns = []) {
  const rules = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
    ['provider-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{28,}|AKIA[A-Z0-9]{16})\b/g],
    ['credential-url', /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi],
    ['personal-path', /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)(?!example(?:[\/\\]|\b)|user(?:[\/\\]|\b)|<)[^\s/\\'"<>]+/g],
    ['private-network', /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g],
    ['private-email', /\b[A-Z0-9._%+-]+@(?!(?:[A-Z0-9.-]+\.)?(?:example\.(?:com|org|net|invalid)|invalid|users\.noreply\.github\.com)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
    ['private-hostname', /\b(?!localhost\b)[A-Za-z0-9][A-Za-z0-9-]*\.(?:local|internal|lan)(?![A-Za-z0-9_.-])/g],
  ];
  const findings = [];
  for (const [rule, pattern] of rules) {
    for (const match of text.matchAll(pattern)) {
      // Public tool attribution is not a private contact address.
      if (rule === 'private-email' && ['noreply@anthropic.com', 'noreply@openai.com'].includes(match[0].toLowerCase())) continue;
      findings.push({ rule, line: text.slice(0, match.index).split('\n').length });
    }
  }
  for (const pattern of extraPatterns) {
    if (typeof pattern !== 'string' || !pattern) throw new Error('Private patterns must be nonempty strings');
    let start = 0;
    while ((start = text.toLowerCase().indexOf(pattern.toLowerCase(), start)) >= 0) {
      findings.push({ rule: 'private-literal', line: text.slice(0, start).split('\n').length }); start += pattern.length;
    }
  }
  return findings;
}

export function audit(root, { history = false, extraPatterns = [] } = {}) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const findings = [], binaryFiles = [], files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
  const sensitivePath = path => /(^|\/)(?:\.env(?:\.[^/]*)?|credentials\.json|id_(?:rsa|ed25519)|[^/]+\.pem)$/.test(path) && !/\.env\.(?:example|sample|template)$/.test(path);
  for (const path of [...new Set(files)]) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) continue;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) { findings.push({ area: 'tree', path, rule: 'symlink-review' }); continue; }
    if (!stat.isFile()) continue;
    if (sensitivePath(path)) findings.push({ area: 'tree', path, rule: 'sensitive-file' });
    const data = readFileSync(absolute);
    if (!data.includes(0)) for (const finding of scanText(data.toString('utf8'), extraPatterns)) findings.push({ area: 'tree', path, ...finding });
    else binaryFiles.push({ area: 'tree', path });
  }
  let commits = 0, blobs = 0;
  if (history) {
    const metadata = git('log', '--all', '--format=%H%x09%an%x09%ae%x09%cn%x09%ce').trim().split('\n').filter(Boolean);
    commits = metadata.length;
    for (const line of metadata) {
      const [commit, ...values] = line.split('\t');
      if (scanText(values.join('\n'), extraPatterns).length) findings.push({ area: 'history-metadata', commit, rule: 'personal-author-review' });
      const raw = git('cat-file', 'commit', commit);
      for (const finding of scanText(raw.slice(raw.indexOf('\n\n') + 2), extraPatterns)) findings.push({ area: 'history-message', commit, ...finding });
    }
    const objects = git('rev-list', '--objects', '--all').trim().split('\n').filter(Boolean);
    // cat-file --batch-check needs stdin; use one bounded batch for object types.
    const typed = execFileSync('git', ['-C', root, 'cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: objects.map(row => row.split(' ')[0]).join('\n') + '\n', encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim().split('\n');
    for (let index = 0; index < typed.length; index++) {
      const [oid, type] = typed[index].split(' '); if (type !== 'blob') continue;
      blobs++;
      const path = objects[index].slice(objects[index].indexOf(' ') + 1);
      if (sensitivePath(path)) findings.push({ area: 'history-blob', object: oid, path, rule: 'sensitive-file' });
      const data = execFileSync('git', ['-C', root, 'cat-file', 'blob', oid], { maxBuffer: 128 * 1024 * 1024 });
      if (!data.includes(0)) for (const finding of scanText(data.toString('utf8'), extraPatterns)) findings.push({ area: 'history-blob', object: oid, path, ...finding });
      else binaryFiles.push({ area: 'history-blob', object: oid, path });
    }
  }
  return { schema_version: 1, scope: history ? 'working-tree-and-all-reachable-history' : 'working-tree', files: new Set(files).size, commits, blobs,
    result: findings.length ? 'REVIEW_REQUIRED' : 'NO_PATTERN_MATCHES', findings, binary_files_not_text_scanned: binaryFiles,
    limitations: ['Heuristic patterns are not a proof that all secrets are absent.', 'Only locally reachable Git refs are covered; remote forks, caches, deleted refs and LFS content require separate review.', 'Matched values are redacted; inspect locations privately before classifying false positives.', 'Author attribution may be intentional. Never rewrite history without scoped owner authorization.'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); let history = false, root = process.cwd(), extraPatterns = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--history') history = true;
      else if (['--root', '--patterns'].includes(arg)) {
        const value = args[++index]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
        if (arg === '--root') root = value;
        else extraPatterns = JSON.parse(readFileSync(value, 'utf8'));
      } else throw new Error(`Unknown option: ${arg}`);
    }
    if (!Array.isArray(extraPatterns) || extraPatterns.some(value => typeof value !== 'string' || !value)) throw new Error('Private patterns must be an array of nonempty strings');
    const report = audit(root, { history, extraPatterns }); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.findings.length ? 1 : 0;
  }
  catch (error) { console.error(`Audit could not complete: ${error.message}`); process.exitCode = 2; }
}
