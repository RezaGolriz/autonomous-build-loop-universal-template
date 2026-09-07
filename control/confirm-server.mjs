// The local confirmation page for one human decision. It shows exactly the
// frozen decision that was recorded when the request was made, and the person
// has to type the decision word into the field before the button does anything.
// The page is bound to one request, one single-use token and one frozen record.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertControlPath, atomicJson, now, readJson, sha256 } from './common.mjs';
import { humanOperations, recordConfirmation, requestDigest, schedulerDirectory } from './confirm.mjs';
import { settleHumanDecisions } from './human-ops.mjs';

const [root, requestId] = process.argv.slice(2);
const { loop } = await assertControlPath(await fs.realpath(root));
const scheduler = schedulerDirectory(loop);
const requestFile = path.join(scheduler, 'operation-requests', `${requestId}.json`);
const runtimeFile = path.join(scheduler, 'operation-runtime', `${requestId}.json`);
const readyFile = path.join(scheduler, 'operation-runtime', `${requestId}.ready.json`);
const request = await readJson(requestFile); const runtime = await readJson(runtimeFile);
// The page renders the frozen request that was written, and its digest is the
// one a receipt will sign. Nothing here is recomputed from live project state.
const frozenDigest = requestDigest(request);
const word = humanOperations[request.operation];
if (!word) { process.stderr.write('unknown confirmable operation\n'); process.exit(65); }
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let confirmState = 'pending';
const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' };

function page(token, message = '') {
  const rows = request.summary.map((entry) => `<dt>${esc(entry.label)}</dt><dd>${esc(entry.value)}</dd>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Build-loop decision</title><style>body{font:16px system-ui;max-width:760px;margin:3rem auto;padding:0 1rem;line-height:1.45}code,pre{background:#f4f4f4;padding:.15rem .3rem}pre{white-space:pre-wrap;padding:1rem}button,input{font-size:1.1rem;padding:.7rem 1.2rem}dt{font-weight:700;margin-top:.6rem}.warn{color:#8a1c1c;font-weight:700}</style>`
    + `<h1>Confirm a human decision</h1>`
    + `<p>A tool asked for this decision on your behalf. It is recorded only if you type the word below and press the button. It authorizes nothing beyond exactly what is shown here, and it never performs a delivery action.</p>`
    + `<dl><dt>Project root</dt><dd><code>${esc(root)}</code></dd>${rows}</dl>`
    + `<details><summary>Technical digest and the frozen decision this page is bound to</summary><pre>${esc(JSON.stringify({ request_id: request.request_id, request_digest: frozenDigest, operation: request.operation, item_id: request.item_id, decision: request.decision }, null, 2))}</pre></details>`
    + (message ? `<p class="warn">${esc(message)}</p>` : '')
    + `<form method="post" action="/confirm?token=${encodeURIComponent(token)}">`
    // The digest of the decision this page displayed travels back with the form,
    // so the server can refuse a confirmation of anything else.
    + `<input type="hidden" name="request_digest" value="${esc(frozenDigest)}">`
    + `<p><label for="decision">Type <code>${esc(word)}</code> to confirm this exact decision:</label><br>`
    + `<input id="decision" name="decision" autocomplete="off" spellcheck="false" required></p>`
    + `<button>Confirm this exact decision</button></form>`
    + `<p>This page is served on this machine only. Recording a decision here means "somebody with access to this computer did it"; it is not proof of who. A project that needs the terminal and nothing else sets <code>human_confirmation</code> to <code>tty-only</code> in <code>.loop/control/policy.json</code>.</p>`;
}

async function readBody(req, limit = 8192) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('the submitted form is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  try {
    const address = server.address();
    const expectedHost = `127.0.0.1:${address.port}`;
    if (req.headers.host !== expectedHost) { res.writeHead(403); res.end('Invalid Host.'); return; }
    const url = new URL(req.url, 'http://127.0.0.1'); const token = url.searchParams.get('token') || '';
    if (sha256(token) !== request.token_sha256 || token !== runtime.token || Date.parse(request.expires_at) < Date.now()) { res.writeHead(403); res.end('Invalid or expired confirmation link.'); return; }
    if (req.method === 'GET' && url.pathname === '/confirm') {
      res.writeHead(200, headers); res.end(page(token)); return;
    }
    if (req.method === 'POST' && url.pathname === '/confirm') {
      if (req.headers.origin !== `http://${expectedHost}`) { res.writeHead(403); res.end('Invalid Origin.'); return; }
      if (confirmState !== 'pending') { res.writeHead(409); res.end('Confirmation link already used.'); return; }
      // The token says which decision; the typed word says a person decided it.
      // Both are checked here, on the server, before anything is recorded.
      const form = new URLSearchParams(await readBody(req));
      const typed = form.get('decision');
      // The decision this page displayed is the only one that can be confirmed
      // here: the browser posts its digest back, and it has to be the digest of
      // the page that was rendered as well as of the record still on disk.
      if (form.get('request_digest') !== frozenDigest) {
        res.writeHead(409, headers);
        res.end('<h1>Not recorded</h1><p>This form does not belong to the decision this page displayed. Ask for a new confirmation link.</p>');
        return;
      }
      if (typed?.trim() !== word) {
        res.writeHead(400, headers);
        res.end(page(token, `Type ${word} exactly to confirm. Nothing was recorded.`));
        return;
      }
      confirmState = 'in-flight';
      let settled;
      try { await recordConfirmation(root, requestId, typed.trim(), frozenDigest); settled = await settleHumanDecisions(root); confirmState = 'finished'; }
      catch (error) { confirmState = 'pending'; throw error; }
      await fs.rm(runtimeFile, { force: true });
      const outcome = settled.find((entry) => entry.request_id === requestId)?.result;
      const failed = outcome?.ok === false;
      res.writeHead(failed ? 409 : 200, headers);
      res.end(`<h1>${failed ? 'Not carried out' : 'Confirmed'}</h1><p>${failed ? esc(outcome.error?.message || 'The decision could not be carried out.') : `The ${esc(request.operation)} decision was recorded and carried out with the assurance local-user-action. You can close this page.`}</p>`);
      setTimeout(() => server.close(), 100); return;
    }
    res.writeHead(405); res.end('Method not allowed.');
  } catch (error) { res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' }); res.end(error.message); }
});
server.listen(0, '127.0.0.1', async () => {
  const address = server.address(); await atomicJson(readyFile, { origin: `http://127.0.0.1:${address.port}`, pid: process.pid, created_at: now() });
});
setTimeout(() => { if (confirmState !== 'finished') server.close(); }, 15 * 60_000).unref();
