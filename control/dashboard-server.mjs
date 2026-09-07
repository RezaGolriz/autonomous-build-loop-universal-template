import http from 'node:http';
import { nonce, resolveRoot } from './common.mjs';
import { renderDashboard } from './dashboard.mjs';

try {
  const root = await resolveRoot(process.argv[2]);
  const token = nonce(32), scriptNonce = nonce(24);
  await renderDashboard(root, scriptNonce);
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    if (req.method !== 'GET' || req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403).end('Forbidden'); return; }
    const url = new URL(req.url, origin);
    if (url.pathname !== '/' || url.searchParams.get('token') !== token) { res.writeHead(404).end('Not found'); return; }
    try { const html = await renderDashboard(root, scriptNonce); res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
    catch { res.writeHead(503, { 'Content-Type': 'text/plain' }).end('Dashboard data unavailable or unsafe. Inspect the project from chat.'); }
  });
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const lifetime = 30 * 60 * 1000;
  setTimeout(() => { server.closeAllConnections(); server.close(); }, lifetime);
  process.send?.({ ok: true, dashboard_url: `${origin}/?token=${token}`, expires_at: new Date(Date.now() + lifetime).toISOString(), read_only: true, refresh: 'Reload the page to read current state.', pid: process.pid });
} catch (error) {
  process.send?.({ ok: false, message: error.message }); process.exitCode = 1;
}
