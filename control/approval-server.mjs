import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertControlPath, atomicJson, now, readJson, sha256 } from './common.mjs';
import { recordTrustedApproval } from './approval.mjs';

const [root, approvalId] = process.argv.slice(2);
const { control } = await assertControlPath(await fs.realpath(root));
const requestFile = path.join(control, 'approval-requests', `${approvalId}.json`);
const runtimeFile = path.join(control, 'approval-runtime', `${approvalId}.json`);
const readyFile = path.join(control, 'approval-runtime', `${approvalId}.ready.json`);
const request = await readJson(requestFile); const runtime = await readJson(runtimeFile);
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let approvalState = 'pending';
const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' };
const server = http.createServer(async (req, res) => {
  try {
    const address = server.address();
    const expectedHost = `127.0.0.1:${address.port}`;
    if (req.headers.host !== expectedHost) { res.writeHead(403); res.end('Invalid Host.'); return; }
    const url = new URL(req.url, 'http://127.0.0.1'); const token = url.searchParams.get('token') || '';
    if (sha256(token) !== request.token_sha256 || token !== runtime.token || Date.parse(request.expires_at) < Date.now()) { res.writeHead(403); res.end('Invalid or expired approval link.'); return; }
    if (req.method === 'GET' && url.pathname === '/review') {
      const summary = request.summary;
      const commandList = summary.commands.map((command) => `<li><strong>${esc(command.phase)} / ${esc(command.id)}</strong>: <code>${esc(command.argv.join(' '))}</code> in <code>${esc(command.cwd)}</code>, timeout ${esc(command.timeout_seconds)}s; evidence: ${esc(command.evidence_types.join(', '))}</li>`).join('');
      const target = `${summary.target.languages.join(', ') || 'unspecified languages'}; ${summary.target.runtimes.join(', ') || 'unspecified runtimes'}; ${summary.target.platforms.join(', ') || 'platform must be confirmed'}`;
      const provider = summary.provider ? `${summary.provider.host} via ${summary.provider.provider_path}; review: ${summary.provider.review_host} via ${summary.provider.review_provider_path}; authentication check ${summary.provider.authentication_check_configured ? 'configured' : 'not configured'}` : 'not configured';
      res.writeHead(200, headers);
      res.end(`<!doctype html><meta charset="utf-8"><title>Build-loop approval</title><style>body{font:16px system-ui;max-width:760px;margin:3rem auto;padding:0 1rem;line-height:1.45}code,pre{background:#f4f4f4;padding:.15rem .3rem}pre{white-space:pre-wrap;padding:1rem}button{font-size:1.1rem;padding:.7rem 1.2rem}dt{font-weight:700;margin-top:.6rem}</style><h1>Approve build-loop setup</h1><p>This authorizes the exact local setup and disposable probes shown here. It does not authorize publishing or deployment.</p><dl><dt>Project root</dt><dd><code>${esc(summary.project_root)}</code></dd><dt>Request</dt><dd>${esc(summary.request)}</dd><dt>Target</dt><dd>${esc(target)}</dd><dt>Provider choices</dt><dd>${esc(provider)}</dd><dt>Acceptance criteria</dt><dd>${esc(summary.acceptance_criteria.join('; '))}</dd><dt>Out of scope</dt><dd>${esc(summary.out_of_scope.join('; '))}</dd><dt>Allowed paths</dt><dd>${esc(summary.allowed_paths.join(', '))}</dd><dt>Frozen paths</dt><dd>${esc(summary.frozen_paths.join(', ') || 'none')}</dd><dt>Protected paths</dt><dd>${esc(summary.protected_paths.join(', '))}</dd><dt>Allowed environment names</dt><dd>${esc(summary.environment_names.join(', ') || 'none')}</dd><dt>Required evidence</dt><dd>${esc(summary.required_evidence.join(', '))}</dd><dt>Limits</dt><dd>${esc(`${summary.limits.max_rounds} rounds, ${summary.limits.max_gate_failures} gate failures, ${summary.limits.max_wall_seconds}s, ${summary.limits.autonomy}`)}</dd></dl><h2>Positive probes</h2><ul>${commandList}</ul><h2>Expected negative probe</h2><p><code>${esc(summary.negative_control.argv.join(' '))}</code> in <code>${esc(summary.negative_control.cwd)}</code> must exit ${esc(summary.negative_control.expected_exit_code)} and match the declared ${esc(summary.negative_control.expected_output.stream)} output.</p><details><summary>Technical digest and raw bound setup</summary><pre>${esc(JSON.stringify({ setup_digest: request.setup_digest, ...summary }, null, 2))}</pre></details><form method="post" action="/approve?token=${encodeURIComponent(token)}"><button>Approve this exact setup</button></form>`); return;
    }
    if (req.method === 'POST' && url.pathname === '/approve') {
      if (req.headers.origin !== `http://${expectedHost}`) { res.writeHead(403); res.end('Invalid Origin.'); return; }
      if (approvalState !== 'pending') { res.writeHead(409); res.end('Approval link already used.'); return; }
      approvalState = 'in-flight';
      try { await recordTrustedApproval(root, request.setup_digest, 'local-http-user', approvalId); approvalState = 'finished'; }
      catch (error) { approvalState = 'pending'; throw error; }
      await fs.rm(runtimeFile, { force: true });
      res.writeHead(200, headers); res.end('<h1>Approved</h1><p>You can close this page and run activate.</p>');
      setTimeout(() => server.close(), 100); return;
    }
    res.writeHead(405); res.end('Method not allowed.');
  } catch (error) { res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' }); res.end(error.message); }
});
server.listen(0, '127.0.0.1', async () => {
  const address = server.address(); await atomicJson(readyFile, { origin: `http://127.0.0.1:${address.port}`, pid: process.pid, created_at: now() });
});
setTimeout(() => { if (approvalState !== 'finished') server.close(); }, 15 * 60_000).unref();
