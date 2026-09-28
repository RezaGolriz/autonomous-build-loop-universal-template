// Chat-hosted execution. The chat agent (Claude Desktop, the Codex app, any
// MCP client) does the node work with its own sub-agents, and the loop keeps
// everything else: the orchestrator still builds the brief, the reference
// engine still runs the verifiers, checks the changed paths, issues and checks
// the review challenge, and decides the transition.
//
// The mechanism is a provider, hosts/chat/provider.sh, that calls no model. For
// every wait it draws a fresh random attempt_id, writes the brief to
// .loop/scheduler/chat/<node_id>.<attempt_id>.brief.json, points at it from
// pending.json, and waits for <node_id>.<attempt_id>.result.json. chat_next
// starts the same managed job `run` starts (one node) and hands the brief over
// with its node_id and attempt_id; chat_submit checks the result against the
// provider result schema and writes it, exactly once, for the attempt that is
// waiting right now. A submission counts as accepted only when the provider has
// taken it (<node_id>.<attempt_id>.consumed.json exists).
//
// Review independence. With host chat the person chooses who reviews
// (configure review_host chat, claude or codex); nothing defaults silently. With
// review_host chat the review runs in this same chat and is reported, on every
// surface and in the accept decision, as not independently isolated.
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ControlError, assertControlPath, exists, nonce, now, readJson } from './common.mjs';
import { bundleRoot } from './setup.mjs';
import { activeJob, launchJob } from './jobs.mjs';
import { check } from './check.mjs';

const NODE_ID = /^n-[0-9a-f]{12}$/;
const ATTEMPT_ID = /^[0-9a-f]{32}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const ACTIVE = ['QUEUED', 'RUNNING', 'STOPPING'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const REVIEW_NOT_ISOLATED = 'Review was not independently isolated (same chat)';
export const REVIEW_HOST_OPTIONS = Object.freeze(['chat', 'claude', 'codex', 'api']);

// How the current run executes, for status, check and both dashboards.
export function executionSummary(config) {
  if (!config || typeof config.host !== 'string') return null;
  const review = typeof config.review_host === 'string' ? config.review_host : config.host;
  const chat = config.host === 'chat';
  const isolated = review !== 'chat';
  // With host chat the reviewer must have been named by the person. A review
  // host that differs from the builder was named; review_host_chosen records
  // an explicit review_host chat.
  const chosen = !(chat && review === 'chat' && config.review_host_chosen !== true);
  let line;
  if (chat) line = isolated ? `Execution: chat-hosted · review: ${review}` : 'Execution: chat-hosted (review not independently isolated)';
  else if (config.host === 'api') line = `Execution: managed API agent · review: ${review}`;
  else line = `Execution: separate CLI process (${config.host}) · review: ${review}${isolated ? '' : ' (chat-hosted, not independently isolated)'}`;
  return {
    host: config.host, review_host: review, mode: chat ? 'chat-hosted' : config.host === 'api' ? 'managed-api' : 'cli-provider', review_isolated: isolated, review_host_chosen: chosen, line,
    warning: isolated ? null : `${REVIEW_NOT_ISOLATED}: the REVIEW node is done by the same chat that built the change, so a PASS is not an independent check. Choose review_host claude or codex for an isolated review.`,
  };
}

// The configuration the current run uses: the bound copy of an active job, or
// the machine-local configuration when no job is running.
export async function currentExecution(root) {
  const loop = path.join(root, '.loop');
  const job = await activeJob(root).catch(() => null);
  const config = job?.bound_config ?? await readJson(path.join(loop, 'host.local.json'), 'host.local.json').catch(() => null);
  return executionSummary(config);
}

// Who reviewed a work item, as the orchestrator recorded it: the newest REVIEW
// provenance record of that item. Null when no review was recorded.
export async function recordedReview(root, workItemId) {
  if (typeof workItemId !== 'string' || !RECORD_ID.test(workItemId)) return null;
  const evidence = path.join(root, '.loop', 'evidence');
  const entries = await fs.readdir(evidence, { withFileTypes: true }).catch(() => []);
  let newest = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !RECORD_ID.test(entry.name)) continue;
    const record = await readJson(path.join(evidence, entry.name, 'provenance.json'), 'provenance').catch(() => null);
    if (!record || record.phase !== 'REVIEW' || record.work_item_id !== workItemId) continue;
    if (!newest || String(record.recorded_at) > String(newest.recorded_at)) newest = record;
  }
  if (!newest) return null;
  const isolated = newest.review_isolated !== false;
  return { run_id: newest.run_id, review_host: newest.review_host ?? null, review_isolated: isolated, warning: isolated ? null : REVIEW_NOT_ISOLATED };
}

// One answer for check and status: false when the recorded review of this item
// or the configured reviewer is this same chat, with a plain warning.
export async function reviewIndependence(root, workItemId, execution) {
  const recorded = await recordedReview(root, workItemId).catch(() => null);
  if (recorded && !recorded.review_isolated) return { review_isolated: false, review_warning: `${REVIEW_NOT_ISOLATED}: the recorded REVIEW of ${workItemId} was done by the chat that built the change, so its PASS is not an independent check.` };
  if (execution && !execution.review_isolated) return { review_isolated: false, review_warning: execution.warning };
  if (!recorded && !execution) return { review_isolated: null, review_warning: null };
  return { review_isolated: true, review_warning: null };
}

// .loop/scheduler/chat, and nothing else: no component may be a symlink, the
// directory is made owner-only, and its real path has to stay in the project.
// Checked again before every write, rename and removal in it.
export async function safeChatDir(root, { create = false } = {}) {
  const { loop, scheduler } = await assertControlPath(root);
  const dir = path.join(scheduler, 'chat');
  if (create && await exists(loop)) {
    await fs.mkdir(scheduler, { recursive: true, mode: 0o700 });
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  for (const part of [loop, scheduler, dir]) {
    const stat = await fs.lstat(part).catch(() => null);
    if (!stat) return dir;
    if (stat.isSymbolicLink()) throw new ControlError('UNSAFE_CONTROL_PATH', `refusing symlinked ${path.relative(root, part)}`);
    if (!stat.isDirectory()) throw new ControlError('UNSAFE_CONTROL_PATH', `${path.relative(root, part)} is not a directory`);
  }
  const expected = path.join(await fs.realpath(root), '.loop', 'scheduler', 'chat');
  if (await fs.realpath(dir) !== expected) throw new ControlError('UNSAFE_CONTROL_PATH', '.loop/scheduler/chat resolves outside the project');
  return dir;
}

// The provider result schema, taken from engine/provider-runtime.sh: the very
// schema the Codex and Claude providers hand their CLI as the output contract.
const schemaCache = new Map();
function resultSchema(phase) {
  if (!schemaCache.has(phase)) {
    const runtime = path.join(bundleRoot, 'engine', 'provider-runtime.sh');
    const run = spawnSync('bash', ['-c', 'f=$(mktemp "${TMPDIR:-/tmp}/chat-schema.XXXXXX") && . "$1" && provider_write_schema "$2" "$f" && cat "$f"; rc=$?; rm -f "$f"; exit $rc', 'schema', runtime, phase], { encoding: 'utf8' });
    if (run.status !== 0) throw new ControlError('CHAT_SCHEMA_UNAVAILABLE', 'the provider result schema could not be read');
    schemaCache.set(phase, JSON.parse(run.stdout));
  }
  return schemaCache.get(phase);
}

// The subset of JSON Schema that schema uses: type (one or several), const,
// enum, required, properties, additionalProperties false, items, maxItems.
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}
function schemaErrors(schema, value, where = 'result', errors = []) {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) { errors.push(`${where} must be ${types.join(' or ')}`); return errors; }
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) errors.push(`${where} must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`);
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${where}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) schemaErrors(schema.properties[key], item, `${where}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${where}.${key} is not allowed`);
    }
  }
  if (typeOf(value) === 'array') {
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${where} has more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => schemaErrors(schema.items, item, `${where}[${index}]`, errors));
  }
  return errors;
}
export function validateChatResult(phase, result) {
  const errors = schemaErrors(resultSchema(phase), result);
  if (errors.length) throw new ControlError('CHAT_RESULT_INVALID', `the result does not match the ${phase} provider result schema: ${errors.slice(0, 8).join('; ')}`, { phase, errors: errors.slice(0, 32) });
  return result;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function readPending(dir) {
  const file = path.join(dir, 'pending.json');
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  const pending = await readJson(file, 'chat pending node').catch(() => null);
  if (!pending || typeof pending.node_id !== 'string' || !NODE_ID.test(pending.node_id) || typeof pending.attempt_id !== 'string' || !ATTEMPT_ID.test(pending.attempt_id)) return null;
  return pending;
}

const sameAttempt = (pending, nodeId, attemptId) => Boolean(pending && pending.node_id === nodeId && pending.attempt_id === attemptId);
const attemptBase = (dir, nodeId, attemptId) => path.join(dir, `${nodeId}.${attemptId}`);

// The attempt waiting for a chat result right now, or why the pointer is stale.
async function waitingNode(root, dir) {
  const pending = await readPending(dir);
  if (!pending) return { pending: null };
  const job = await activeJob(root).catch(() => null);
  const state = await readJson(path.join(root, '.loop', 'state.json'), 'state').catch(() => null);
  const bound = state && state.work_item_id === pending.work_item_id && state.round === pending.round && state.phase === pending.phase;
  const live = Boolean(job && ACTIVE.includes(job.status)) && alive(pending.provider_pid);
  return { pending, job, state, current: Boolean(bound && live) };
}

async function briefOf(dir, pending) {
  return readJson(`${attemptBase(dir, pending.node_id, pending.attempt_id)}.brief.json`, 'chat node brief');
}

// Whether any wait of this node ever existed (a brief of some attempt).
async function knownNode(dir, nodeId) {
  const names = await fs.readdir(dir).catch(() => []);
  return names.some((name) => name.startsWith(`${nodeId}.`) && name.endsWith('.brief.json'));
}

function offered(pending, wrapper, job, execution, idempotent) {
  return {
    ok: true, idempotent, node_id: pending.node_id, attempt_id: pending.attempt_id, label: wrapper?.label ?? pending.label ?? null,
    phase: pending.phase, work_item_id: pending.work_item_id, round: pending.round,
    job_id: job?.job_id ?? null, deadline_at: new Date(pending.deadline_epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    execution, review_isolated: execution?.review_isolated ?? null, ...(execution?.warning ? { warning: execution.warning } : {}),
    brief: wrapper?.brief ?? null,
    next_action: `Give ONLY brief.prompt to a fresh sub-agent. It returns one ${pending.phase === 'REVIEW' ? 'verdict' : 'result'} JSON; pass it to chat_submit with node_id ${pending.node_id} and attempt_id ${pending.attempt_id}.`,
  };
}

function reviewHostRequired(execution) {
  if (!execution || execution.host !== 'chat' || execution.review_host_chosen) return;
  throw new ControlError('CHAT_REVIEW_HOST_REQUIRED', 'with host chat, choose who reviews before the run starts: run configure with host chat and review_host chat (this same chat; the review is then not independently isolated), claude or codex (a separate CLI process that reviews independently)', { options: [...REVIEW_HOST_OPTIONS] });
}

export async function chatNext(root, args = {}, channel = 'mcp-user') {
  const dir = await safeChatDir(root, { create: true });
  const execution = await currentExecution(root);
  reviewHostRequired(execution);
  const first = await waitingNode(root, dir);
  if (first.current) return offered(first.pending, await briefOf(dir, first.pending), first.job, execution, true);

  let job = await activeJob(root).catch(() => null);
  let launched = false;
  if (!job || !ACTIVE.includes(job.status)) {
    const config = await readJson(path.join(root, '.loop', 'host.local.json'), 'host.local.json').catch(() => null);
    if (config?.host !== 'chat' && config?.review_host !== 'chat') {
      throw new ControlError('CHAT_HOST_NOT_CONFIGURED', 'chat-hosted execution needs the chat host: run configure with host chat and review_host chat, claude or codex', { host: config?.host ?? null, options: [...REVIEW_HOST_OPTIONS] });
    }
    reviewHostRequired(executionSummary(config));
    // Exactly the path `run` takes, with one node: hold, authorization record,
    // budgets, channel and job fencing are all checked there, unchanged.
    job = (await launchJob(root, 'run', { request_id: `chat-${Date.now()}-${nonce(6)}`, max_nodes: 1 }, channel)).job;
    launched = true;
  }
  const deadline = Date.now() + Math.max(1, Math.min(Number(process.env.CHAT_NEXT_WAIT_SECONDS) || 20, 120)) * 1000;
  while (Date.now() < deadline) {
    const waiting = await waitingNode(root, dir);
    if (waiting.current) return offered(waiting.pending, await briefOf(dir, waiting.pending), waiting.job, execution, false);
    const current = await activeJob(root).catch(() => null);
    if (!current || current.job_id !== job.job_id || !ACTIVE.includes(current.status)) { job = current ?? job; break; }
    await sleep(100);
  }
  const finished = await activeJob(root).catch(() => null) ?? job;
  const situation = await check(root);
  const running = finished && ACTIVE.includes(finished.status);
  return {
    ok: true, idempotent: false, launched, node_id: null, attempt_id: null, phase: situation.phase, brief: null, job_id: finished?.job_id ?? null,
    job_status: finished?.status ?? null, job_error: finished?.last_error ?? null, execution, check: situation,
    next_action: running
      ? `No brief is waiting: the ${situation.phase} node is running outside this chat (for example a CLI reviewer, or the verifiers). Call chat_next again in a moment.`
      : situation.next_action,
  };
}

const alreadySubmitted = (nodeId, attemptId) => new ControlError('CHAT_NODE_ALREADY_SUBMITTED', `node ${nodeId} (attempt ${attemptId}) already received its result; an attempt takes exactly one submission`, { node_id: nodeId, attempt_id: attemptId });
const stale = (nodeId, attemptId, why, waiting = null) => new ControlError('CHAT_NODE_STALE', `node ${nodeId} (attempt ${attemptId}) ${why}; call chat_next`, { node_id: nodeId, attempt_id: attemptId, waiting_node_id: waiting?.node_id ?? null, waiting_attempt_id: waiting?.attempt_id ?? null });

export async function chatSubmit(root, args, channel = 'mcp-user') {
  const nodeId = args.node_id; const attemptId = args.attempt_id; const result = args.result;
  if (typeof nodeId !== 'string' || !NODE_ID.test(nodeId)) throw new ControlError('INVALID_INPUT', 'node_id is invalid');
  if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) throw new ControlError('INVALID_INPUT', 'attempt_id is invalid; pass the attempt_id chat_next returned with the brief');
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ControlError('INVALID_INPUT', 'result must be one JSON object');
  const dir = await safeChatDir(root);
  const base = attemptBase(dir, nodeId, attemptId);
  const resultFile = `${base}.result.json`; const consumedFile = `${base}.consumed.json`;
  const waiting = await waitingNode(root, dir);
  if (!sameAttempt(waiting.pending, nodeId, attemptId)) {
    if (await exists(consumedFile)) throw alreadySubmitted(nodeId, attemptId);
    if (await exists(`${base}.brief.json`) || await knownNode(dir, nodeId)) {
      throw stale(nodeId, attemptId, `is not the attempt waiting now${waiting.pending ? ` (waiting: ${waiting.pending.node_id}, attempt ${waiting.pending.attempt_id})` : ''}`, waiting.pending);
    }
    throw new ControlError('CHAT_NODE_UNKNOWN', `no chat node ${nodeId} exists; call chat_next`, { node_id: nodeId, attempt_id: attemptId });
  }
  if (await exists(resultFile) || await exists(consumedFile)) throw alreadySubmitted(nodeId, attemptId);
  if (!waiting.current) throw stale(nodeId, attemptId, 'no longer belongs to the current run and round');
  const pending = waiting.pending;
  validateChatResult(pending.phase, result);

  // Exactly once: the result file is linked into place, which fails when it
  // already exists, so two submissions racing each other cannot both land.
  // Right before that the waiting attempt is checked once more.
  const temp = path.join(dir, `.${nodeId}.${process.pid}.${nonce(6)}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify({ schema_version: 1, node_id: nodeId, attempt_id: attemptId, result })}\n`, { mode: 0o600, flag: 'wx' });
  try {
    await safeChatDir(root);
    const recheck = await waitingNode(root, dir);
    if (!sameAttempt(recheck.pending, nodeId, attemptId) || !recheck.current) throw stale(nodeId, attemptId, 'stopped waiting before the result could be handed over', recheck.pending);
    await fs.link(temp, resultFile);
  } catch (error) { if (error.code === 'EEXIST') throw alreadySubmitted(nodeId, attemptId); throw error; }
  finally { await fs.rm(temp, { force: true }); }
  await fs.appendFile(path.join(dir, 'submissions.log'), `${JSON.stringify({ at: now(), node_id: nodeId, attempt_id: attemptId, label: pending.label ?? null, phase: pending.phase, channel })}\n`, { mode: 0o600 });

  // Wait, bounded, until the provider has taken this attempt's result and the
  // orchestrator has finished the node: the job ended, or it already offers the
  // next node. Accepted means taken: a result nobody took is withdrawn.
  const jobId = waiting.job?.job_id;
  const readJob = async () => (jobId ? readJson(path.join(root, '.loop', 'control', 'jobs', `${jobId}.json`), 'job').catch(() => null) : null);
  const deadline = Date.now() + Math.max(1, Math.min(Number(process.env.CHAT_SUBMIT_WAIT_SECONDS) || 900, 3600)) * 1000;
  let consumed = false; let finished = false; let next = null;
  while (Date.now() < deadline) {
    if (!consumed) consumed = await exists(consumedFile);
    const job = await readJob();
    const jobActive = Boolean(job && ACTIVE.includes(job.status));
    if (consumed) {
      const later = await waitingNode(root, dir);
      if (later.current && !sameAttempt(later.pending, nodeId, attemptId)) { finished = true; next = { node_id: later.pending.node_id, attempt_id: later.pending.attempt_id, phase: later.pending.phase }; break; }
      if (!jobActive) { finished = true; break; }
    } else if (!jobActive || !alive(pending.provider_pid)) {
      // The provider is gone and did not take it (or took it this very moment).
      consumed = await exists(consumedFile);
      if (!consumed) break;
      continue;
    }
    await sleep(100);
  }
  if (!consumed) {
    // Withdraw it with one rename, so the provider either took it whole before
    // this or cannot take it at all, and a later chat_next is not confused by it.
    await safeChatDir(root);
    const withdrawn = `${base}.withdrawn.json`;
    const took = await fs.rename(resultFile, withdrawn).then(() => false, () => true);
    await fs.rm(withdrawn, { force: true });
    if (!took || !await exists(consumedFile)) throw stale(nodeId, attemptId, 'was not taken by the run (the node ended or timed out first); nothing was accepted');
    consumed = true;
  }
  const loop = path.join(root, '.loop');
  const state = await readJson(path.join(loop, 'state.json'), 'state').catch(() => null);
  const provenance = await readJson(path.join(loop, 'evidence', pending.run_id, 'provenance.json'), 'provenance').catch(() => null);
  const evidence = [];
  for (const id of provenance?.evidence_ids ?? []) {
    if (typeof id !== 'string' || !RECORD_ID.test(id)) continue;
    const record = await readJson(path.join(loop, 'evidence', `${id}.json`), 'evidence').catch(() => null);
    evidence.push({ evidence_id: id, evidence_type: record?.evidence_type ?? null, result: record?.result ?? null, observation: record?.details?.observation ?? null });
  }
  const situation = await check(root);
  const job = await readJob();
  return {
    ok: true, node_id: nodeId, attempt_id: attemptId, label: pending.label ?? null, phase: pending.phase, accepted: consumed, node_finished: finished,
    gate: { phase: pending.phase, outcome: provenance?.outcome ?? null, gate_status: state?.gates?.[pending.phase]?.status ?? null, evidence, host: provenance?.host ?? null, review_isolated: provenance?.review_isolated ?? null },
    job: job ? { job_id: job.job_id, status: job.status, last_error: job.last_error ?? null } : null,
    next_node: next, check: situation,
    next_action: next ? `Another node is waiting (${next.phase}); call chat_next.`
      : situation.run_status === 'RUNNING' ? 'The run continues; call chat_next for the next node.' : situation.next_action,
  };
}

// Cancel or pause asked while a chat node waits: the waiting attempt ends at
// once as BLOCKED instead of at its timeout. Never used to pass a node.
export async function abandonWaitingNode(root) {
  const dir = await safeChatDir(root).catch(() => null);
  if (!dir) return false;
  const pending = await readPending(dir);
  if (!pending) return false;
  await fs.writeFile(`${attemptBase(dir, pending.node_id, pending.attempt_id)}.abort`, `${now()}\n`, { mode: 0o600 }).catch(() => null);
  return true;
}
