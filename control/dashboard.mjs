import { fork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlError, assertControlPath, nonce } from './common.mjs';
import { workKinds, loopOptions } from './loop-options.mjs';

const esc = value => String(value ?? 'Not available').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
async function safeText(root, relative) {
  const file = path.join(root, relative);
  const actual = await fs.realpath(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!actual) return null;
  if (actual !== file) throw new ControlError('UNSAFE_CONTROL_PATH', 'dashboard refuses symlinked inputs');
  const info = await fs.stat(file);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new ControlError('INVALID_DASHBOARD_INPUT', 'dashboard input is not a bounded regular file');
  return fs.readFile(file, 'utf8');
}
const safeJson = async (root, relative) => { const text = await safeText(root, relative); return text === null ? null : JSON.parse(text); };
export async function renderDashboard(root, scriptNonce) {
  await assertControlPath(root);
  let state = await safeJson(root, '.loop/state.json');
  const active = Boolean(state);
  state ??= await safeJson(root, '.loop/candidate/state.json');
  const workId = state?.work_item_id;
  const work = typeof workId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workId)
    ? await safeText(root, `.loop/${active ? '' : 'candidate/'}work-items/${workId}.md`) : null;
  const kind = /^Kind: (.+)$/m.exec(work || '')?.[1];
  const current = await safeJson(root, '.loop/control/current-job.json');
  const job = typeof current?.job_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(current.job_id)
    ? await safeJson(root, `.loop/control/jobs/${current.job_id}.json`) : null;
  const blockers = await safeText(root, '.loop/blockers.md');
  const evidenceDir = path.join(root, '.loop/evidence');
  const realEvidence = await fs.realpath(evidenceDir).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (realEvidence && realEvidence !== evidenceDir) throw new ControlError('UNSAFE_CONTROL_PATH', 'dashboard refuses a symlinked evidence directory');
  const names = realEvidence ? (await fs.readdir(evidenceDir)).filter(name => name.endsWith('.json') && name !== 'run-summary.json').sort() : [];
  const evidence = await Promise.all(names.slice(-200).map(name => safeJson(root, `.loop/evidence/${name}`)));
  const phases = loopOptions().phases;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Build Loop dashboard</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#eef2f6;color:#182b40;font:16px system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:32px 20px}header{margin-bottom:24px}h1{font-size:32px;margin:8px 0}h2{font-size:20px;margin-top:0}.muted{color:#506277}.card{padding:24px;background:white;border:1px solid #d8e0ea;border-radius:14px;margin:16px 0;overflow:auto}.grid,.phases{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.pill{padding:14px;border-radius:8px;background:#edf2f7}.current{outline:2px solid #2865ad}label{display:block;margin:12px 0 6px}select,textarea,button{font:inherit;padding:10px;border:1px solid #899bad;border-radius:6px}select,textarea{width:100%;background:white;color:inherit}button{cursor:pointer;background:#173f6c;color:white}textarea{min-height:115px;resize:vertical}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #ddd}small{display:block;margin-top:6px}.status{font-size:24px;font-weight:650}a{color:#205994}@media(max-width:600px){main{padding:16px 12px}.card{padding:16px}h1{font-size:26px}}
</style></head><body><main><header><span class="muted">UNIVERSAL BUILD LOOP · LOCAL DASHBOARD</span><h1>${esc(path.basename(root))}</h1><p class="muted">${esc(root)}</p><p>Read-only view · Updated ${esc(new Date().toISOString())} · <a href="">Refresh status</a></p></header>
<section class="card"><div class="grid"><div>Status<div class="status">${esc(active ? state.run_status : state ? 'SETUP CANDIDATE' : 'NOT CONFIGURED')}</div></div><div>Work item<strong><small>${esc(workId)}</small></strong></div><div>Work kind<strong><small>${esc(kind)}</small></strong></div><div>Round<strong><small>${esc(state?.round)} / ${esc(state?.max_rounds)}</small></strong></div></div><p>${esc(state?.next_action || 'Ask your chat to inspect the project and prepare a setup proposal.')}</p>${!active ? '<p>No active configuration. Human setup approval and activation probes are required before execution.</p>' : ''}</section>
<section class="card"><h2>Workflow</h2><div class="phases">${phases.map(phase => `<div class="pill${state?.phase === phase ? ' current' : ''}"><strong>${phase}</strong><small>${esc(state?.gates?.[phase]?.status || 'PENDING')}</small></div>`).join('')}</div><p>Independent review and validation remain mandatory for every loop.</p></section>
<section class="card"><h2>Choose your next loop</h2><p>Select an intent and copy the generated request into Codex or Claude. This selection prepares chat text; it does not change the active work item or start execution.</p><div class="grid"><div><label for="kind">Work kind</label><select id="kind">${Object.entries(workKinds).map(([id, value]) => `<option value="${id}">${esc(value.label)}</option>`).join('')}</select></div><div><label for="mode">Run mode after approval</label><select id="mode"><option value="step">Step by step · one node</option><option value="bounded">Bounded run · up to 12 nodes</option></select></div></div><label for="prompt">Request to use in chat</label><textarea id="prompt" readonly></textarea><p id="guidance" class="muted"></p></section>
<section class="card"><h2>Current job</h2>${job ? `<p>${esc(job.job_id)} · ${esc(job.status)} · ${esc(job.nodes_completed)} / ${esc(job.max_nodes)} nodes</p><p>${esc(job.last_error?.message || 'No recorded job error.')}</p>` : '<p>No recorded job.</p>'}<p>Job records are observations, not proof of a passed gate. Refresh for new records.</p></section>
<section class="card"><h2>Blockers</h2><pre>${esc(blockers || 'No recorded blockers.')}</pre></section>
<section class="card"><h2>Evidence</h2><p>${names.length} records. Showing up to 200 by filename; this is not a complete audit.</p><table><thead><tr><th>ID</th><th>Phase</th><th>Type</th><th>Result</th></tr></thead><tbody>${evidence.map(item => `<tr><td>${esc(item?.evidence_id)}</td><td>${esc(item?.phase)}</td><td>${esc(item?.evidence_type)}</td><td>${esc(item?.result)}</td></tr>`).join('')}</tbody></table></section>
<section class="card"><details><summary>Work item</summary><pre>${esc(work || 'No work item prepared.')}</pre></details></section>
<script nonce="${scriptNonce}">const kinds=${JSON.stringify(workKinds)};const kind=document.getElementById('kind'),mode=document.getElementById('mode');function update(){document.getElementById('prompt').value='Inspect this project and prepare a '+kind.value+' work item for: [describe the outcome]. Use work_kind="'+kind.value+'". Preserve existing scope and require setup approval if needed. After approval, use run_mode="'+mode.value+'". Do not start yet; show the concrete proposal first.';document.getElementById('guidance').textContent=kinds[kind.value].guidance;}kind.addEventListener('change',update);mode.addEventListener('change',update);update();</script></main></body></html>`;
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
  child.disconnect(); child.unref();
  if (!result.ok) throw new ControlError('DASHBOARD_START_FAILED', result.message);
  return result;
}
