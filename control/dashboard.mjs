import { fork } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionSummary } from './chat.mjs';
import { ControlError, assertControlPath, confirmationPolicyProblem, hostWithPort, nonce } from './common.mjs';
import { workKinds, loopOptions } from './loop-options.mjs';
import { validateAuthorization } from './schemas.mjs';

const esc = value => String(value ?? 'Not available').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
async function safeText(root, relative, budget) {
  const file = path.join(root, relative);
  const actual = await fs.realpath(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!actual) return null;
  if (actual !== file) throw new ControlError('UNSAFE_CONTROL_PATH', 'dashboard refuses symlinked inputs');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    const limit = Math.min(1024 * 1024, budget.remaining);
    if (!info.isFile() || info.size > limit) throw new ControlError('INVALID_DASHBOARD_INPUT', 'dashboard input exceeds its regular-file or total-size limit');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new ControlError('INVALID_DASHBOARD_INPUT', 'dashboard input grew beyond its limit');
    budget.remaining -= size;
    return buffer.subarray(0, size).toString('utf8');
  } finally { await handle.close(); }
}
const safeJson = async (root, relative, budget) => {
  const text = await safeText(root, relative, budget);
  if (text === null) return null;
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ControlError('INVALID_DASHBOARD_INPUT', 'dashboard expects an object record');
  return value;
};
// Append-only control logs grow without bound, so only their tail is read. The
// same symlink and regular-file rules as safeText apply.
async function safeTail(root, relative, bytes = 65536) {
  const file = path.join(root, relative);
  const actual = await fs.realpath(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!actual) return null;
  if (actual !== file) throw new ControlError('UNSAFE_CONTROL_PATH', 'dashboard refuses symlinked inputs');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ControlError('INVALID_DASHBOARD_INPUT', 'dashboard expects a regular log file');
    const size = Math.min(info.size, bytes);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const { bytesRead } = await handle.read(buffer, read, size - read, info.size - size + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read).toString('utf8');
  } finally { await handle.close(); }
}
const lastLine = text => (text ?? '').split('\n').map(line => line.trim()).filter(Boolean).pop() ?? null;
// One tick line is "<timestamp> key=value ...". Unknown keys are ignored.
function parseTickLine(line) {
  if (!line) return null;
  const [at, ...rest] = line.split(/\s+/);
  const fields = { at };
  for (const token of rest) {
    const index = token.indexOf('=');
    if (index > 0) fields[token.slice(0, index)] = token.slice(index + 1);
  }
  return fields;
}
// A READY record whose expiry cannot be read has already lost its meaning, so
// it counts as expired rather than as unlimited.
const expired = record => {
  const deadline = record?.expires_at ? Date.parse(record.expires_at) : Number.NaN;
  return !Number.isFinite(deadline) || deadline <= Date.now();
};
// A record that does not validate is a broken decision, not an absent one.
const invalidRecord = record => {
  if (!record) return false;
  try { validateAuthorization(record); return false; } catch { return true; }
};
// `page` is only set by the control page (control/control-page-server.mjs):
// `panel` is its decisions panel, already escaped HTML, shown under the header;
// `label` replaces the read-only header line.
export async function renderDashboard(root, scriptNonce, page = {}) {
  if (typeof scriptNonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(scriptNonce)) throw new ControlError('INVALID_DASHBOARD_INPUT', 'invalid script nonce');
  const budget = { remaining: 4 * 1024 * 1024 };
  await assertControlPath(root);
  let state = await safeJson(root, '.loop/state.json', budget);
  const active = Boolean(state);
  state ??= await safeJson(root, '.loop/candidate/state.json', budget);
  const workId = state?.work_item_id;
  const work = typeof workId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workId)
    ? await safeText(root, `.loop/${active ? '' : 'candidate/'}work-items/${workId}.md`, budget) : null;
  const kind = /^Kind: (.+)$/m.exec(work || '')?.[1];
  const current = await safeJson(root, '.loop/control/current-job.json', budget);
  const job = typeof current?.job_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(current.job_id)
    ? await safeJson(root, `.loop/control/jobs/${current.job_id}.json`, budget) : null;
  // How the current run executes: chat-hosted or a separate CLI process, and
  // who reviews. The bound copy of the job wins over the machine configuration.
  const execution = executionSummary(job?.bound_config ?? await safeJson(root, '.loop/host.local.json', budget).catch(() => null));
  const blockers = await safeText(root, '.loop/blockers.md', budget);
  const prefix = `.loop/${active ? '' : 'candidate/'}`;
  // Backlog, inbox, authorization, memory and the control logs. Each of these
  // is optional; a missing file is reported as "not available", never guessed.
  const authorization = typeof workId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workId)
    ? await safeJson(root, `${prefix}work-items/${workId}.authorization.json`, budget).catch(() => null) : null;
  const authorizationInvalid = invalidRecord(authorization);
  const authorizationExpired = !authorizationInvalid && authorization?.state === 'READY' && expired(authorization);
  const backlog = await safeJson(root, '.loop/backlog.json', budget).catch(() => null);
  const backlogItems = [];
  for (const entry of Array.isArray(backlog?.items) ? backlog.items.slice(0, 100) : []) {
    const id = String(entry?.id ?? '');
    const record = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
      ? await safeJson(root, `.loop/work-items/${id}.authorization.json`, budget).catch(() => null) : null;
    const broken = invalidRecord(record);
    const stale = !broken && record?.state === 'READY' && expired(record);
    backlogItems.push({ id, title: entry?.title, work_kind: entry?.work_kind, state: !broken && record?.state === 'READY' && !stale ? 'READY' : 'PAUSED', expired: stale, invalid: broken, expires_at: record?.expires_at });
  }
  const inbox = await safeJson(root, '.loop/inbox/index.json', budget).catch(() => null);
  const inboxItems = Array.isArray(inbox?.items) ? inbox.items.slice(0, 100) : null;
  const notes = await safeText(root, '.loop/notes/next-steps.md', budget);
  const tick = parseTickLine(lastLine(await safeTail(root, '.loop/scheduler/tick.log')));
  const scoutLine = lastLine(await safeTail(root, '.loop/scheduler/scout.log'));
  let scout = null;
  if (scoutLine) { try { scout = JSON.parse(scoutLine); } catch { scout = null; } }
  const evidenceDir = path.join(root, '.loop/evidence');
  const realEvidence = await fs.realpath(evidenceDir).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (realEvidence && realEvidence !== evidenceDir) throw new ControlError('UNSAFE_CONTROL_PATH', 'dashboard refuses a symlinked evidence directory');
  const names = [];
  if (realEvidence) {
    let entries = 0;
    for await (const entry of await fs.opendir(evidenceDir)) {
      if (++entries > 10000) throw new ControlError('INVALID_DASHBOARD_INPUT', 'too many evidence directory entries for the dashboard');
      if (entry.name.endsWith('.json') && entry.name !== 'run-summary.json') names.push(entry.name);
    }
  }
  names.sort();
  const evidence = [];
  for (const name of names.slice(-200)) evidence.push(await safeJson(root, `.loop/evidence/${name}`, budget));
  // How human confirmations may be given here. The file is written by hand, so
  // it can be wrong. A file that does not say what the schema describes is shown
  // as an error a person has to repair; while it is broken the project accepts
  // only a word typed at an interactive terminal, and the page says that instead
  // of quietly displaying the permissive default.
  // A project-wide hold. While the record exists nothing automated runs here,
  // whatever the run status says, so it is shown as a banner above everything
  // else. A record that cannot be read is still a hold.
  const hold = await safeJson(root, '.loop/control/hold.json', budget).catch(() => ({ __unreadable: true }));
  const policy = await safeJson(root, '.loop/control/policy.json', budget).catch(() => ({ __unreadable: true }));
  const policyError = policy === null ? null
    : policy.__unreadable ? '.loop/control/policy.json cannot be read as a JSON object'
      : confirmationPolicyProblem(policy);
  const confirmationMode = policyError || policy?.human_confirmation === 'tty-only' ? 'tty-only' : 'tty-or-local-page';
  // Where the confirmation link points when the policy opens it to a phone.
  const pageSetting = !policyError && policy?.confirmation_page ? policy.confirmation_page : null;
  const pageOrigin = pageSetting ? `http://${hostWithPort(pageSetting.advertise ?? pageSetting.listen, pageSetting.port ?? 'random-port')}` : null;
  const phases = loopOptions().phases;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Build Loop dashboard</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#eef2f6;color:#182b40;font:16px system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:32px 20px}header{margin-bottom:24px}h1{font-size:32px;margin:8px 0}h2{font-size:20px;margin-top:0}.muted{color:#506277}.card{padding:24px;background:white;border:1px solid #d8e0ea;border-radius:14px;margin:16px 0;overflow:auto}.grid,.phases{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.pill{padding:14px;border-radius:8px;background:#edf2f7}.current{outline:2px solid #2865ad}label{display:block;margin:12px 0 6px}select,textarea,button{font:inherit;padding:10px;border:1px solid #899bad;border-radius:6px}select,textarea{width:100%;background:white;color:inherit}button{cursor:pointer;background:#173f6c;color:white}textarea{min-height:115px;resize:vertical}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #ddd}small{display:block;margin-top:6px}.status{font-size:24px;font-weight:650}a{color:#205994}.tag{display:inline-block;padding:2px 8px;border-radius:999px;background:#e6ebf1;font-size:14px}.tag.ready{background:#dcfce7;color:#166534}.tag.paused{background:#e5e7eb;color:#4b5563}.flag{display:inline-block;padding:2px 8px;border-radius:999px;background:#fdecc8;color:#8a5a00;border:1px solid #d9a441;font-size:14px}.card.hold{background:#fff1f2;border-color:#b91c1c;color:#7f1d1d}.card.hold h2{color:#b91c1c}summary{cursor:pointer}@media(max-width:600px){main{padding:16px 12px}.card{padding:16px}h1{font-size:26px}}
</style></head><body><main><header><span class="muted">UNIVERSAL BUILD LOOP · LOCAL DASHBOARD</span><h1>${esc(path.basename(root))}</h1><p class="muted">${esc(root)}</p><p>${page.label ? esc(page.label) : 'Read-only view'} · Updated ${esc(new Date().toISOString())} · <a href="">Refresh status</a></p></header>
${typeof page.panel === 'string' ? page.panel : ''}${hold ? `<section class="card hold"><h2>PROJECT ON HOLD</h2><p>${hold.__unreadable ? 'A hold record exists but cannot be read. It still holds: nothing automated runs here.' : esc(hold.reason)}</p><p>Held at ${esc(hold.held_at)} · held by ${esc(hold.held_by)} · work item ${esc(hold.item_id ?? 'none recorded')}</p><p>Start, run, resume, tick, task and scout are refused for every caller that is not a person at an interactive terminal. Reading, cancel and handover stay available. A person takes the hold off with <code>release</code>: the word RELEASE typed at an interactive terminal, or on the local confirmation page.</p></section>` : ''}
<section class="card"><div class="grid"><div>Status<div class="status">${esc(active ? state.run_status : state ? 'SETUP CANDIDATE' : 'NOT CONFIGURED')}</div></div><div>Work item<strong><small>${esc(workId)}</small></strong></div><div>Work kind<strong><small>${esc(kind)}</small></strong></div><div>Round<strong><small>${esc(state?.round)} / ${esc(state?.max_rounds)}</small></strong></div></div><p>${esc(state?.next_action || 'Ask your chat to inspect the project and prepare a setup proposal.')}</p>${!active ? '<p>No active configuration. Human setup approval and activation probes are required before execution.</p>' : ''}</section>
<section class="card"><h2>Workflow</h2><div class="phases">${phases.map(phase => `<div class="pill${state?.phase === phase ? ' current' : ''}"><strong>${phase}</strong><small>${esc(state?.gates?.[phase]?.status || 'PENDING')}</small><small>${esc(Array.isArray(state?.gates?.[phase]?.evidence_ids) ? state.gates[phase].evidence_ids.join(', ') : 'No evidence IDs')}</small></div>`).join('')}</div><p>Independent review and validation remain mandatory for every loop.</p></section>
<section class="card"><h2>Choose your next loop</h2><p>Select an intent and copy the generated request into Codex or Claude. This selection prepares chat text; it does not change the active work item or start execution.</p><div class="grid"><div><label for="kind">Work kind</label><select id="kind">${Object.entries(workKinds).map(([id, value]) => `<option value="${id}">${esc(value.label)}</option>`).join('')}</select></div><div><label for="mode">Run mode after approval</label><select id="mode"><option value="step">Step by step · one node</option><option value="bounded">Bounded run · up to 12 nodes</option></select></div></div><label for="prompt">Request to use in chat</label><textarea id="prompt" readonly></textarea><p id="guidance" class="muted"></p></section>
<section class="card"><h2>Current job</h2>${execution ? `<p><strong>${esc(execution.line)}</strong></p>` : ''}${job ? `<p>${esc(job.job_id)} · ${esc(job.status)} · ${esc(job.nodes_completed)} / ${esc(job.max_nodes)} nodes</p><p>${esc(job.last_error?.message || 'No recorded job error.')}</p>` : '<p>No recorded job.</p>'}<p>Job records are observations, not proof of a passed gate. Refresh for new records.</p></section>
<section class="card"><h2>Authorization of the current item</h2>${authorization ? `<div class="grid"><div>State<strong><small><span class="tag ${authorization.state === 'READY' && !authorizationExpired && !authorizationInvalid ? 'ready' : 'paused'}">${esc(authorization.state)}</span>${authorizationInvalid ? ' <span class="flag">invalid record · a person has to authorize again</span>' : ''}</small></strong></div><div>Expires<strong><small>${esc(authorization.expires_at)}${authorizationExpired ? ' <span class="flag">expired · a person has to authorize again</span>' : ''}</small></strong></div><div>Budget<strong><small>${esc(authorization.budget?.max_rounds)} rounds · ${esc(authorization.budget?.max_wall_seconds)} s wall clock</small></strong></div><div>Stop on first failure<strong><small>${esc(authorization.stop_on_first_failure === undefined ? null : String(authorization.stop_on_first_failure))}</small></strong></div><div>Authorized by<strong><small>${esc(authorization.authorized_by)}${authorization.authorized_by === 'mcp-user' ? ' <span class="flag">authorized through a chat tool call</span>' : ''}</small></strong></div><div>Authorized at<strong><small>${esc(authorization.authorized_at)}</small></strong></div><div>Assurance<strong><small>${esc(authorization.assurance)}</small></strong></div></div><p>Scope · allowed paths</p><ul>${(Array.isArray(authorization.scope?.allowed_paths) ? authorization.scope.allowed_paths : []).slice(0, 128).map(entry => `<li>${esc(entry)}</li>`).join('') || '<li>Not available</li>'}</ul>` : '<p>Not available. No authorization record exists for the current work item; only a person can write one.</p>'}<p>READY means a person already decided this item may start when its slot comes. It is not an approval of any result, and it never widens the recorded scope.</p><p>Assurance <code>local-user-action</code> means a person acting on this machine typed the word, at the terminal or on the local confirmation page. It is not proof of who that person was. Human confirmation mode for this project: <strong>${esc(confirmationMode)}</strong>${confirmationMode === 'tty-only' ? ' — chat tool calls and input files are refused; only a word typed at an interactive terminal decides.' : ' — a word typed at an interactive terminal, or typed on the local confirmation page.'}</p>${pageOrigin && confirmationMode !== 'tty-only' ? `<p>Confirmation page links point to <code>${esc(pageOrigin)}</code> (listening on ${esc(pageSetting.listen)}), so they can be opened from a phone inside the private network or VPN. Anyone who can reach that address and has a link can act on it.</p>` : ''}${policyError ? `<p><span class="flag">INVALID_POLICY · a person has to repair .loop/control/policy.json</span> ${esc(policyError)} Until it is repaired this project decides nothing through the local page.</p>` : ''}</section>
<section class="card"><h2>Backlog</h2>${backlog ? `<p>${backlogItems.filter(item => item.state === 'READY').length} READY · ${backlogItems.filter(item => item.state === 'PAUSED').length} PAUSED · ${backlogItems.length} shown.</p><table><thead><tr><th>ID</th><th>Title</th><th>Work kind</th><th>Authorization</th><th>Expires</th></tr></thead><tbody>${backlogItems.map(item => `<tr><td>${esc(item.id)}</td><td>${esc(item.title)}</td><td>${esc(item.work_kind)}</td><td><span class="tag ${item.state === 'READY' ? 'ready' : 'paused'}">${esc(item.state)}</span>${item.expired ? ' <span class="flag">expired</span>' : ''}${item.invalid ? ' <span class="flag">invalid record</span>' : ''}</td><td>${esc(item.expires_at)}</td></tr>`).join('') || '<tr><td colspan="5">The backlog is empty.</td></tr>'}</tbody></table>` : '<p>Not available. No backlog file has been written yet.</p>'}<p>Queued work only. Nothing here starts on its own; a PAUSED item waits for a person.</p></section>
<section class="card"><h2>Inbox</h2>${inboxItems ? `<p>${inboxItems.length} proposal(s) waiting for a person.</p><table><thead><tr><th>Proposal</th><th>Title</th><th>Created</th><th>Provider</th></tr></thead><tbody>${inboxItems.map(item => `<tr><td>${esc(item?.id)}</td><td>${esc(item?.title)}</td><td>${esc(item?.created_at)}</td><td>${esc(item?.provider)}</td></tr>`).join('') || '<tr><td colspan="4">The inbox is empty.</td></tr>'}</tbody></table>` : '<p>Not available. No scout has written an inbox index yet.</p>'}<p>A proposal is inert. It becomes work only when a person promotes it into the backlog.</p></section>
<section class="card"><h2>Last tick and last scout</h2>${tick ? `<p>Last tick ${esc(tick.at)} · action <strong>${esc(tick.action)}</strong> · reason ${esc(tick.reason)} · item ${esc(tick.item)} · phase ${esc(tick.phase)} · run status ${esc(tick.run_status)}</p>` : '<p>Last tick: not available.</p>'}${scout ? `<p>Last scout ${esc(scout.at)} · status ${esc(scout.status)} · ${esc(scout.proposals)} proposal(s) · provider ${esc(scout.provider)} · profile ${esc(scout.profile)}</p>` : '<p>Last scout: not available.</p>'}<p>These are log entries, not gate results. A tick may only do what a person authorized before.</p></section>
<section class="card"><details><summary>Next-steps memory</summary>${notes ? `<pre>${esc(notes)}</pre>` : '<p>Not available. No run has written a next-steps note yet.</p>'}<p>Advisory only. This note is not an approval and it does not widen the scope of any node.</p></details></section>
<section class="card"><h2>Blockers</h2><pre>${esc(blockers || 'No recorded blockers.')}</pre></section>
<section class="card"><h2>Evidence</h2><p>${names.length} records. Showing up to 200 by filename; this is not a complete audit.</p><table><thead><tr><th>ID</th><th>Phase</th><th>Type</th><th>Result</th></tr></thead><tbody>${evidence.map(item => `<tr><td>${esc(item?.evidence_id)}</td><td>${esc(item?.phase)}</td><td>${esc(item?.evidence_type)}</td><td>${esc(item?.result)}</td></tr>`).join('')}</tbody></table></section>
<section class="card"><details><summary>Work item</summary><pre>${esc(work || 'No work item prepared.')}</pre></details></section>
<script nonce="${scriptNonce}">const kinds=${JSON.stringify(workKinds)};const kind=document.getElementById('kind'),mode=document.getElementById('mode');function update(){document.getElementById('prompt').value='Inspect this project and prepare '+kinds[kind.value].label.toLowerCase()+' work for: [describe the outcome]. Preserve existing scope and require setup approval if needed. After approval, '+(mode.value==='step'?'execute at most one node':'continue for at most 12 nodes')+'. Do not start yet; show the concrete proposal first.';document.getElementById('guidance').textContent=kinds[kind.value].guidance;}kind.addEventListener('change',update);mode.addEventListener('change',update);update();</script></main></body></html>`;
}

export async function openDashboard(root) {
  await assertControlPath(root);
  const child = fork(fileURLToPath(new URL('./dashboard-server.mjs', import.meta.url)), [root], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new ControlError('DASHBOARD_START_FAILED', 'dashboard did not start within 10 seconds')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new ControlError('DASHBOARD_START_FAILED', 'dashboard process exited before startup')); });
    child.once('message', result => { clearTimeout(timer); resolve(result); });
  });
  if (child.connected) child.disconnect(); child.unref();
  if (!result.ok) throw new ControlError('DASHBOARD_START_FAILED', result.message);
  return result;
}
