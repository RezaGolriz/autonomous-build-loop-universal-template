// Human confirmation of one exact decision.
//
// Accepting a run, authorizing an item, promoting a proposal and releasing a
// project-wide hold are human decisions. A typed word at an interactive terminal is a person; a JSON input
// file or an MCP tool call is not, however well it spells the word. Those
// transports therefore never complete the decision. They freeze the fully
// resolved decision — the operation, the item, every argument including the
// defaults, and a fingerprint of the thing being decided about — into a pending
// request and return a link to a local confirmation page. The page displays
// exactly that frozen decision. The person reads it, types the decision word
// and presses the button; only then is a signed receipt written.
//
// The receipt binds the request id and a digest of the frozen request, so a
// receipt can never be replayed against a different decision. Settlement
// recomputes that digest from the frozen request on disk, claims the request
// atomically by renaming it, and only then carries the decision out — under the
// same lock in which the runner re-checks that the live item still matches what
// was frozen. Anything that no longer matches is refused as CONFIRMATION_STALE.
//
// Assurance: the confirmation page is a local page reached over loopback, or,
// when confirmation_page in .loop/control/policy.json says so, over the owner's
// private network or VPN. It records `local-user-action`: somebody who could
// reach the page opened the link and typed the word. A project that needs a stronger guarantee sets
// `human_confirmation` to "tty-only" in .loop/control/policy.json.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signOperationConfirmation, verifyOperationConfirmation } from './approval-store.mjs';
import {
  ControlError, assertControlPath, atomicJson, exactKeys, exists, jsonDigest, nonce, now, readJson, sha256,
} from './common.mjs';
import { runningControlPageLink } from './control-page.mjs';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'confirm-server.mjs');
const REQUEST_TTL_MS = 15 * 60_000;
const requestIdPattern = /^confirm-[A-Za-z0-9_-]{6,64}$/;

// The operations a person has to confirm, with the word that has to be typed —
// at an interactive terminal, or into the field on the local confirmation page.
export const humanOperations = Object.freeze({ accept: 'ACCEPT', authorize: 'AUTHORIZE', promote: 'PROMOTE', release: 'RELEASE', team_authorize: 'AUTHORIZE' });

// Assurance of a decision recorded through the local confirmation page: a
// person acting on this machine. Honest about what it is and is not.
export const LOCAL_USER_ACTION = 'local-user-action';

export const schedulerDirectory = (loop) => path.join(loop, 'scheduler');
const requestFile = (scheduler, id) => path.join(scheduler, 'operation-requests', `${id}.json`);
const claimedFile = (scheduler, id) => path.join(scheduler, 'operation-requests', `${id}.claimed.json`);
const receiptFile = (scheduler, id) => path.join(scheduler, 'operation-approvals', `${id}.json`);
const resultFile = (scheduler, id) => path.join(scheduler, 'operation-results', `${id}.json`);
const runtimeFile = (scheduler, id) => path.join(scheduler, 'operation-runtime', `${id}.json`);
const readyFile = (scheduler, id) => path.join(scheduler, 'operation-runtime', `${id}.ready.json`);

const REQUEST_KEYS = ['schema_version', 'request_id', 'operation', 'item_id', 'payload_digest', 'decision', 'created_at', 'expires_at', 'token_sha256', 'summary'];

// Which repeated call is asking for the same thing. It digests what the caller
// supplied, not the frozen decision, so a second identical tool call is handed
// the link that already exists instead of a second one.
export function payloadDigest(operation, itemId, payload) {
  return jsonDigest({ operation, item_id: itemId ?? null, payload });
}

export function decisionPayload(args) {
  const { confirm, ...rest } = args ?? {};
  return rest;
}

// The digest the receipt signs. It covers the whole frozen request, so any
// change to the decision, the item, the summary or the expiry invalidates it.
export function requestDigest(request) {
  exactKeys(request, REQUEST_KEYS, REQUEST_KEYS, 'confirmation request');
  return jsonDigest(request);
}

async function serverEndpoint(scheduler, id, deadlineMs = 3000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await exists(readyFile(scheduler, id))) return readJson(readyFile(scheduler, id), 'confirmation endpoint');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return null;
}

// Every request that is still open: written, not yet claimed by a settlement.
async function pendingRequests(scheduler) {
  const names = await fs.readdir(path.join(scheduler, 'operation-requests')).catch(() => []);
  const requests = [];
  for (const name of names.filter((entry) => entry.endsWith('.json') && !entry.endsWith('.claimed.json')).sort()) {
    const record = await readJson(path.join(scheduler, 'operation-requests', name), 'confirmation request').catch(() => null);
    if (record && requestIdPattern.test(String(record.request_id)) && `${record.request_id}.json` === name) requests.push(record);
  }
  return requests;
}

// The open requests a person can still confirm: written, not expired, no
// receipt yet. The control page lists these in its decisions panel.
export async function listPendingConfirmations(root) {
  const { loop } = await assertControlPath(root);
  const scheduler = schedulerDirectory(loop);
  const open = [];
  for (const request of await pendingRequests(scheduler)) {
    if (!humanOperations[request.operation] || !Array.isArray(request.summary)) continue;
    if (!(Date.parse(request.expires_at) > Date.now())) continue;
    if (await exists(receiptFile(scheduler, request.request_id))) continue;
    open.push(request);
  }
  return open;
}

// A request that is still open for the same asked-for decision is reused, so a
// repeated tool call hands the person the same link instead of a second one.
async function reusableRequest(scheduler, operation, itemId, digest, pageLink = null) {
  for (const request of await pendingRequests(scheduler)) {
    if (request.operation !== operation || request.payload_digest !== digest || (request.item_id ?? null) !== (itemId ?? null)) continue;
    if (Date.parse(request.expires_at) <= Date.now()) continue;
    if (await exists(receiptFile(scheduler, request.request_id))) continue;
    const runtime = await readJson(runtimeFile(scheduler, request.request_id), 'confirmation runtime').catch(() => null);
    // With the control page running, every open request is shown there.
    if (pageLink) return { request, url: pageLink };
    const endpoint = await readJson(readyFile(scheduler, request.request_id), 'confirmation endpoint').catch(() => null);
    if (!runtime?.token || !endpoint?.origin) continue;
    return { request, url: `${endpoint.origin}/confirm?token=${encodeURIComponent(runtime.token)}` };
  }
  return null;
}

// `frozen` is the fully resolved decision: operation, item, every argument
// including the defaults, plus the fingerprint of the thing decided about.
export async function requestConfirmation(root, operation, itemId, args, frozen, summary) {
  if (!Object.hasOwn(humanOperations, operation)) throw new ControlError('INVALID_INPUT', `${operation} is not a confirmable human decision`);
  const { loop } = await assertControlPath(root);
  const scheduler = schedulerDirectory(loop);
  const payload = decisionPayload(args);
  const digest = payloadDigest(operation, itemId, payload);
  // When the long-lived control page is running, the pending request appears
  // on it and the link points there; no separate one-request page is started.
  const pageLink = await runningControlPageLink(root).catch(() => null);
  const reused = await reusableRequest(scheduler, operation, itemId, digest, pageLink);
  const pending = (request, url, idempotent) => ({
    ok: true,
    pending_confirmation: true,
    idempotent,
    completed: false,
    started: false,
    operation,
    item_id: itemId ?? null,
    request_id: request.request_id,
    payload_digest: digest,
    request_digest: requestDigest(request),
    decision: request.decision,
    confirmation_word: humanOperations[operation],
    confirmation_url: url,
    expires_at: request.expires_at,
    assurance: LOCAL_USER_ACTION,
    ...(pageLink ? { control_page: true } : {}),
    next: `${operation} is a human decision. Give this link to the person; they type ${humanOperations[operation]} on the page and press the button. Do not open it yourself.`,
  });
  if (reused) return pending(reused.request, reused.url, true);

  const requestId = `confirm-${nonce(12)}`;
  const token = nonce(24);
  const request = {
    schema_version: 1,
    request_id: requestId,
    operation,
    item_id: itemId ?? null,
    payload_digest: digest,
    decision: frozen,
    created_at: now(),
    expires_at: new Date(Date.now() + REQUEST_TTL_MS).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    token_sha256: sha256(token),
    summary,
  };
  await fs.mkdir(path.join(scheduler, 'operation-runtime'), { recursive: true });
  await atomicJson(requestFile(scheduler, requestId), request);
  await atomicJson(runtimeFile(scheduler, requestId), { token }, 0o600);
  if (pageLink) return pending(request, pageLink, false);
  const log = await fs.open(path.join(scheduler, 'operation-runtime', `${requestId}.log`), 'a', 0o600);
  const child = spawn(process.execPath, [serverPath, root, requestId], { detached: true, stdio: ['ignore', log.fd, log.fd] });
  child.unref();
  await log.close();
  const endpoint = await serverEndpoint(scheduler, requestId);
  if (!endpoint) throw new ControlError('CONFIRMATION_SERVER_FAILED', 'the local confirmation server did not become ready (with a fixed confirmation_page.port another page may still be open on that port)');
  return pending(request, `${endpoint.origin}/confirm?token=${encodeURIComponent(token)}`, false);
}

// Called by the confirmation server when the person typed the word and pressed
// the button. The receipt signs the digest of the frozen request and its id.
// `expectedDigest` is the digest of the decision the page actually displayed and
// the browser posted back. Recording only happens when the displayed decision,
// the posted digest and the record on disk are all the same one.
export async function recordConfirmation(root, requestId, word, expectedDigest = null) {
  const { loop } = await assertControlPath(root);
  const scheduler = schedulerDirectory(loop);
  if (!requestIdPattern.test(String(requestId))) throw new ControlError('INVALID_INPUT', 'invalid confirmation request id');
  const request = await readJson(requestFile(scheduler, requestId), 'confirmation request');
  const digest = requestDigest(request);
  if (expectedDigest !== null && expectedDigest !== digest) {
    throw new ControlError('CONFIRMATION_STALE', 'the decision changed after this page was displayed; nothing was recorded. Ask for a new confirmation link.');
  }
  if (request.request_id !== requestId) throw new ControlError('CONFIRMATION_TAMPERED', 'the confirmation request does not carry its own id');
  if (Date.parse(request.expires_at) <= Date.now()) throw new ControlError('CONFIRMATION_EXPIRED', 'this confirmation link has expired; ask for a new one');
  const expected = humanOperations[request.operation];
  if (!expected) throw new ControlError('INVALID_INPUT', `${request.operation} is not a confirmable human decision`);
  if (word !== expected) throw new ControlError('CONFIRMATION_MISMATCH', `type ${expected} to confirm this decision; nothing was recorded`);
  if (await exists(receiptFile(scheduler, requestId))) throw new ControlError('CONFIRMATION_ALREADY_USED', 'this confirmation was already recorded');
  const receipt = {
    schema_version: 1,
    request_id: requestId,
    operation: request.operation,
    item_id: request.item_id ?? null,
    request_digest: digest,
    payload_digest: request.payload_digest,
    decision: 'APPROVE',
    channel: 'local-http-user',
    assurance: LOCAL_USER_ACTION,
    confirmed_at: now(),
  };
  receipt.host_signature = await signOperationConfirmation(root, receipt);
  await atomicJson(receiptFile(scheduler, requestId), receipt);
  return receipt;
}

// Claim one request for execution. The rename is the claim: exactly one caller
// can move the file, so concurrent settlement runs the decision at most once.
async function claimRequest(scheduler, id) {
  try { await fs.rename(requestFile(scheduler, id), claimedFile(scheduler, id)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function discardRequest(scheduler, id, reason, code = 'CONFIRMATION_STALE') {
  await fs.rm(requestFile(scheduler, id), { force: true });
  await fs.rm(runtimeFile(scheduler, id), { force: true });
  await fs.rm(readyFile(scheduler, id), { force: true });
  await atomicJson(resultFile(scheduler, id), {
    schema_version: 1, request_id: id, completed_at: now(),
    result: { ok: false, error: { code, message: reason } },
  });
}

// Throw every open page request away without carrying any of it out. Used when
// the project no longer allows the confirmation page: a request that was written
// under the old policy must not be settled under the new one, and its link must
// stop working even if somebody already typed the word on it.
export async function discardPendingConfirmations(root, reason, code = 'CONFIRMATION_TTY_ONLY') {
  const { loop } = await assertControlPath(root);
  const scheduler = schedulerDirectory(loop);
  const discarded = [];
  for (const request of await pendingRequests(scheduler)) {
    await discardRequest(scheduler, request.request_id, reason, code);
    discarded.push({ request_id: request.request_id, operation: request.operation, result: { ok: false, error: { code, message: reason } } });
  }
  return discarded;
}

// Every confirmed request that has not been carried out yet. `runners` maps an
// operation name to (root, request, channel) => result; the runner re-checks
// the frozen decision against the live project under its own lock.
export async function settleConfirmations(root, runners) {
  const { loop } = await assertControlPath(root);
  const scheduler = schedulerDirectory(loop);
  const settled = [];
  for (const request of await pendingRequests(scheduler)) {
    const id = request.request_id;
    if (await exists(resultFile(scheduler, id))) continue;
    const receipt = await readJson(receiptFile(scheduler, id), 'confirmation receipt').catch(() => null);
    if (!receipt) continue;
    // Everything that can be judged from the frozen request alone is judged
    // before the request is claimed, so a stale one is discarded, not executed.
    let digest;
    try {
      digest = requestDigest(request);
      await verifyOperationConfirmation(root, receipt);
      if (receipt.request_id !== id) throw new ControlError('CONFIRMATION_STALE', 'the receipt names a different confirmation request');
      if (receipt.request_digest !== digest) throw new ControlError('CONFIRMATION_STALE', 'the frozen decision changed after it was confirmed');
      if (receipt.operation !== request.operation || (receipt.item_id ?? null) !== (request.item_id ?? null)) throw new ControlError('CONFIRMATION_STALE', 'the receipt does not match the decision it is filed under');
      if (!Object.hasOwn(runners, request.operation)) throw new ControlError('INVALID_INPUT', `no runner for ${request.operation}`);
    } catch (error) {
      await discardRequest(scheduler, id, error.message);
      settled.push({ request_id: id, operation: request.operation, result: { ok: false, error: { code: error.code || 'CONFIRMATION_STALE', message: error.message } } });
      continue;
    }
    if (!await claimRequest(scheduler, id)) continue;
    let result;
    try { result = await runners[request.operation](root, request, 'local-http-user'); }
    catch (error) { result = { ok: false, error: { code: error.code || 'CONFIRMATION_FAILED', message: error.message } }; }
    await atomicJson(resultFile(scheduler, id), {
      schema_version: 1, request_id: id, operation: request.operation, item_id: request.item_id ?? null,
      request_digest: digest, assurance: LOCAL_USER_ACTION, completed_at: now(), result,
    });
    await fs.rm(runtimeFile(scheduler, id), { force: true });
    settled.push({ request_id: id, operation: request.operation, result });
  }
  return settled;
}

export async function confirmationResult(root, requestId) {
  const { loop } = await assertControlPath(root);
  return readJson(resultFile(schedulerDirectory(loop), requestId), 'confirmation result').catch(() => null);
}
