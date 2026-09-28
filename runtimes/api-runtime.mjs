// Managed API runtime: one bounded node for one approved team member, over
// the OpenAI Responses or Anthropic Messages protocol, with Node's own fetch.
//
// What it guarantees, and what it does not:
// - It runs only for a team whose signed proposal a person approved
//   (verifyTeamBinding), and only a managed_api member of it.
// - It starts no process: no agent CLI, no shell. The model acts only through
//   list_files, read_file and write_file (runtimes/api-tools.mjs).
// - Every reply has to report a model that is exactly the requested model or
//   one of the member's allowed_resolved_models. Anything else, or no model
//   at all, stops the node; there is no fallback to another model.
// - Turns, tokens (as the provider reports them) and wall-clock seconds are
//   bounded by the member's budget. A reply without token usage stops the
//   node, because the budget could not be counted. There is no money budget:
//   the runtime cannot see prices, so it does not pretend to cap spend.
// - Its output is only a node result or a review verdict for the orchestrator,
//   which still runs the verifiers, checks every changed path and decides
//   every gate. The runtime never writes state, evidence or a gate.
// - The credential is read from the one environment variable the approved
//   team names, sent only in the protocol's auth header, and never logged.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_ENDPOINTS, recordReadiness, verifyTeamBinding } from '../control/team.mjs';
import { createToolbox } from './api-tools.mjs';
import { beginApiObservation } from './api-observability.mjs';
import { ProtocolError, protocolFor } from './api-protocols.mjs';

export const PHASES = Object.freeze(['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER', 'SCOUT']);
const MAX_OUTPUT_TOKENS_PER_TURN = 8192;
const MAX_CALLS_PER_TURN = 16;
const MAX_TOOL_OUTPUT = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// Which roles may take which phase. REVIEW is a reviewer's alone, so the
// member who built never judges its own work.
const PHASE_ROLES = Object.freeze({
  DEFINE: ['builder'], DESIGN: ['builder'], EXECUTE: ['builder'], HANDOVER: ['builder'],
  VALIDATE: ['builder', 'reviewer', 'analyst'], REVIEW: ['reviewer'], SCOUT: ['analyst', 'reviewer'],
});

const RESULT_SHAPE = '{"schema_version":1,"status":"DONE"|"BLOCKED","defect_class":null|"requirement"|"design"|"artifact","blocker":null|"<text>","notes":"<text>"}';
const REVIEW_SHAPE = '{"schema_version":1,"verdict_id":"<id>","run_id":"<brief run_id>","work_item_id":"<brief work_item_id>","phase":"REVIEW","gate_id":"REVIEW","nonce":"<brief nonce>","result":"PASS"|"FAIL","reviewer":"<name>","independent":true,"revision":"<brief revision>","captured_at":"<date-time>","evidence_refs":["<brief refs>"],"findings":[{"severity":"BLOCKING"|"HIGH"|"MEDIUM"|"LOW","category":"requirement"|"design"|"artifact"|"safety","evidence":"<text>","disposition":"OPEN"|"DISMISSED"}]}';
const SCOUT_SHAPE = '{"schema_version":1,"status":"OK"|"BLOCKED","proposals":[{"title":"<text>","outcome":"<text>","constraints":["<text>"],"evidence":["<text>"]}]}';

export class Blocked extends Error {}
export class TransportError extends Error {}

export function selectMember(config, phase, requestedId = '') {
  const roles = PHASE_ROLES[phase];
  if (!roles) throw new Blocked(`invalid phase: ${phase}`);
  if (config.execution_policy === 'native_only') throw new Blocked('the approved team is native_only; no managed API member may run');
  if (requestedId) {
    const member = config.members.find((item) => item.id === requestedId);
    if (!member) throw new Blocked(`member ${requestedId} is not in the approved team`);
    if (member.execution_kind !== 'managed_api') throw new Blocked(`member ${member.id} is ${member.execution_kind}, not managed_api`);
    if (!roles.includes(member.role)) throw new Blocked(`member ${member.id} is a ${member.role}; ${phase} needs ${roles.join(' or ')}`);
    return member;
  }
  for (const role of roles) {
    const member = config.members.find((item) => item.role === role && item.execution_kind === 'managed_api');
    if (member) return member;
  }
  throw new Blocked(`the approved team has no managed_api ${roles.join(' or ')} for ${phase}`);
}

export function modelApproved(member, reported) {
  return typeof reported === 'string' && (reported === member.requested_model || member.allowed_resolved_models.includes(reported));
}

export function extractJson(reply) {
  const fenced = [...reply.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g)];
  let candidate = fenced.length ? fenced[fenced.length - 1][1] : null;
  if (candidate === null) {
    const lines = reply.split('\n');
    let start = -1;
    lines.forEach((line, index) => { if (line.startsWith('{')) start = index; });
    if (start < 0) return null;
    candidate = lines.slice(start).join('\n');
  }
  try { return JSON.parse(candidate); } catch { return null; }
}

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value, keys) => isObject(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

// The same contract hosts/codex/provider.sh checks with jq.
export function resultProblem(phase, result, brief) {
  if (phase === 'REVIEW') {
    const keys = ['schema_version', 'verdict_id', 'run_id', 'work_item_id', 'phase', 'gate_id', 'nonce', 'result', 'reviewer', 'independent', 'revision', 'captured_at', 'evidence_refs', 'findings'];
    if (!sameKeys(result, keys)) return 'verdict does not have exactly the verdict fields';
    if (result.schema_version !== 1 || result.phase !== 'REVIEW' || result.gate_id !== 'REVIEW' || result.independent !== true) return 'verdict is not an independent REVIEW verdict';
    for (const key of ['run_id', 'work_item_id', 'nonce', 'revision']) if (result[key] !== brief[key]) return `verdict does not echo the challenge ${key}`;
    if (JSON.stringify(result.evidence_refs) !== JSON.stringify(brief.evidence_refs)) return 'verdict does not echo the challenge evidence_refs';
    if (!['PASS', 'FAIL'].includes(result.result)) return 'verdict result must be PASS or FAIL';
    if (![result.verdict_id, result.reviewer, result.captured_at].every((value) => typeof value === 'string' && value)) return 'verdict_id, reviewer and captured_at must be text';
    if (!Array.isArray(result.findings) || !result.findings.every((item) => sameKeys(item, ['severity', 'category', 'evidence', 'disposition'])
      && ['BLOCKING', 'HIGH', 'MEDIUM', 'LOW'].includes(item.severity) && ['requirement', 'design', 'artifact', 'safety'].includes(item.category)
      && typeof item.evidence === 'string' && ['OPEN', 'DISMISSED'].includes(item.disposition))) return 'verdict findings are invalid';
    return null;
  }
  if (phase === 'SCOUT') {
    if (!isObject(result) || Object.keys(result).some((key) => !['schema_version', 'status', 'proposals', 'notes'].includes(key))) return 'scout result has unknown fields';
    if (result.schema_version !== 1 || !['OK', 'BLOCKED'].includes(result.status) || !Array.isArray(result.proposals) || result.proposals.length > 5) return 'scout result does not match the provider contract';
    if (result.notes !== undefined && typeof result.notes !== 'string') return 'scout notes must be text';
    if (result.status === 'BLOCKED' && result.proposals.length) return 'a blocked scout returns no proposals';
    if (!result.proposals.every((item) => sameKeys(item, ['title', 'outcome', 'constraints', 'evidence']) && typeof item.title === 'string' && typeof item.outcome === 'string' && strings(item.constraints) && strings(item.evidence))) return 'scout proposals are invalid';
    return null;
  }
  if (!sameKeys(result, ['schema_version', 'status', 'defect_class', 'blocker', 'notes'])) return 'result does not have exactly the provider result fields';
  if (result.schema_version !== 1 || !['DONE', 'BLOCKED'].includes(result.status)) return 'result status must be DONE or BLOCKED';
  if (![null, 'requirement', 'design', 'artifact'].includes(result.defect_class)) return 'result defect_class is invalid';
  if (!(result.blocker === null || typeof result.blocker === 'string') || typeof result.notes !== 'string') return 'result blocker or notes is invalid';
  if (result.status === 'BLOCKED' && !result.blocker) return 'a BLOCKED result needs a concrete blocker';
  return null;
}

function systemPrompt(member, brief, tools) {
  const phase = brief.phase;
  const shape = phase === 'REVIEW' ? REVIEW_SHAPE : phase === 'SCOUT' ? SCOUT_SHAPE : RESULT_SHAPE;
  const names = tools.map((tool) => tool.name);
  const writing = names.includes('write_file')
    ? `write_file accepts only these node paths: ${(brief.allowed_paths || []).join(', ') || '(none)'}; frozen: ${(brief.frozen_paths || []).join(', ') || '(none)'}.`
    : 'You cannot change any file in this node.';
  return [
    `You are build-loop team member ${member.id} (${member.role}) performing exactly one bounded ${phase} node for work item ${brief.work_item_id}.`,
    `You act only through these tools: ${names.join(', ') || 'none'}. There is no shell, no network and no other tool. Paths are relative to the project root.`,
    writing,
    'Never read or repeat credentials. You do not decide gates, approve work or certify your own output; the runner verifies everything you produce.',
    `When you are done, finish your reply with exactly this JSON shape, filled with valid values, inside a \`\`\`json fenced block, and put nothing after it:\n${shape}`,
  ].join('\n\n');
}

async function readProtectedPaths(root) {
  try {
    const adapter = JSON.parse(await fs.readFile(path.join(root, '.loop', 'project.adapter.json'), 'utf8'));
    if (!Array.isArray(adapter.protected_paths) || adapter.protected_paths.some(x => typeof x !== 'string')) throw new Error('invalid protected paths');
    return adapter.protected_paths;
  } catch { throw new Blocked('project adapter is missing or invalid; protected paths cannot be verified'); }
}

function redactor(secrets) {
  const values = [...new Set(secrets.filter(value => typeof value === 'string' && value))].sort((a, b) => b.length - a.length);
  return value => values.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
}
function redactValues(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactValues(item, redact));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactValues(item, redact)]));
  return value;
}

async function readBody(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return response.text();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); throw new TransportError('provider reply is larger than the runtime accepts'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function record(root, team, member, entry) {
  // Readiness is reporting, not a gate: a host key that cannot be reached here
  // only means team_status keeps saying configured_unverified.
  try { await recordReadiness(root, { member_id: member.id, team_digest: team.team_digest, ...entry }); } catch { /* not recorded */ }
}

// Runs the tool loop. Returns { result } or throws Blocked / TransportError.
async function converse({ root, team, member, brief, env, fetchImpl, turnsOverride, observation }) {
  const protocol = protocolFor(member.provider);
  const credential = member.credential_env ? env[member.credential_env] : null;
  if (member.credential_env && !credential) throw new Blocked(`the credential variable ${member.credential_env} named by the approved team is not set`);
  // Only credential names already declared in the approved roster are read.
  // Another member's key must not travel in a work item or verifier excerpt.
  const redact = redactor(team.config.members.map(item => item.credential_env ? env[item.credential_env] : null));
  const base = member.endpoint ?? DEFAULT_ENDPOINTS[member.provider];
  const toolbox = createToolbox({ root, member, brief, protectedPaths: member.tool_scope.length ? await readProtectedPaths(root) : [] });
  const conversation = protocol.start({ system: redact(systemPrompt(member, brief, toolbox.definitions)), prompt: redact(brief.prompt ?? '') });
  const budget = member.budget;
  const maxTurns = turnsOverride ?? budget.max_turns;
  const deadline = Date.now() + budget.max_seconds * 1000;
  let tokens = 0; let verifiedRecorded = false;
  const usage = { turns: 0, tokens: 0, tool_calls: 0 };

  for (let turn = 1; turn <= maxTurns; turn++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Blocked(`time budget of ${budget.max_seconds}s is used up`);
    const remainingTokens = budget.max_total_tokens - tokens;
    if (remainingTokens <= 0) throw new Blocked(`token budget of ${budget.max_total_tokens} is used up`);
    const body = protocol.body(conversation, { model: member.requested_model, tools: toolbox.definitions, maxOutputTokens: Math.min(MAX_OUTPUT_TOKENS_PER_TURN, remainingTokens) });
    let response;
    try {
      const reply = await fetchImpl(`${base}${protocol.path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(remainingMs),
        headers: { 'content-type': 'application/json', accept: 'application/json', ...protocol.headers(credential) },
        body: JSON.stringify(body),
      });
      const raw = await readBody(reply);
      if (!reply.ok) {
        if (reply.status === 401 || reply.status === 403) {
          await record(root, team, member, { state: 'failed', source: 'provider-error', detail: `the provider refused the credential (HTTP ${reply.status})` });
          throw new Blocked(`the provider refused the credential in ${member.credential_env || 'the request'} (HTTP ${reply.status})`);
        }
        throw new TransportError(`provider returned HTTP ${reply.status}`);
      }
      try { response = JSON.parse(raw); } catch { throw new TransportError('provider reply is not JSON'); }
    } catch (error) {
      if (error instanceof Blocked || error instanceof TransportError) throw error;
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Blocked(`time budget of ${budget.max_seconds}s is used up`);
      throw new TransportError(`provider request failed: ${redact(error?.cause?.code || error?.message || 'network error')}`);
    }
    usage.turns = turn;
    let parsed;
    try { parsed = protocol.parse(response); } catch (error) { throw new TransportError(error instanceof ProtocolError ? error.message : 'provider reply cannot be read'); }
    if (!modelApproved(member, parsed.model)) {
      const shown = parsed.model ? redact(String(parsed.model)).slice(0, 80) : 'no model';
      await record(root, team, member, { state: 'failed', source: 'provider-response', resolved_model: parsed.model ? redact(String(parsed.model)).slice(0, 80) : null, detail: `the provider reported ${shown}, which the approved team does not allow for ${member.id}` });
      throw new Blocked(`the provider reported ${shown}, not ${member.requested_model} or an allowed resolved model; no fallback is used`);
    }
    if (!verifiedRecorded) {
      verifiedRecorded = true;
      await record(root, team, member, { state: 'verified', source: 'provider-response', resolved_model: parsed.model, detail: `a ${protocol.name} reply reported an approved model` });
    }
    if (parsed.tokens === null) throw new Blocked('the provider reported no token usage, so the token budget cannot be enforced');
    tokens += parsed.tokens;
    if (!Number.isSafeInteger(tokens)) throw new Blocked('reported token usage exceeds the safely countable range');
    usage.tokens = tokens;
    if (observation) await observation.response(parsed.model, usage);
    if (tokens > budget.max_total_tokens) throw new Blocked(`token budget of ${budget.max_total_tokens} is exceeded (${tokens} reported)`);
    if (parsed.stop === 'truncated') throw new Blocked('the provider stopped at its output limit before finishing');
    if (parsed.stop === 'refused') throw new Blocked('the provider refused the request');
    if (parsed.stop === 'failed') throw new TransportError('provider reply did not complete');
    if (parsed.stop === 'end') {
      const result = extractJson(parsed.text);
      if (result === null) throw new TransportError(`no JSON result in the final reply: ${redact(parsed.text).slice(0, 2000)}`);
      const problem = resultProblem(brief.phase, result, brief);
      if (problem) throw new TransportError(`${problem}: ${redact(JSON.stringify(result)).slice(0, 2000)}`);
      // A key the model somehow saw is never passed on in its result.
      return { result: redactValues(result, redact), usage };
    }
    if (parsed.calls.length > MAX_CALLS_PER_TURN) throw new Blocked(`the model asked for ${parsed.calls.length} tool calls in one turn; at most ${MAX_CALLS_PER_TURN} are run`);
    const results = [];
    for (const call of parsed.calls) {
      usage.tool_calls++;
      const args = redactValues(call.args, redact);
      const outcome = args === null ? { ok: false, output: 'tool arguments must be a JSON object' } : await toolbox.call(call.name, args);
      results.push({ ok: outcome.ok, output: redact(outcome.output).slice(0, MAX_TOOL_OUTPUT) });
    }
    protocol.continue(conversation, response, parsed, results);
  }
  throw new Blocked(`turn budget of ${maxTurns} is used up before a final result`);
}

function blockedOutcome(phase, reason) {
  // REVIEW has no BLOCKED verdict: the contract is to exit nonzero so the run
  // blocks, exactly like the chat provider does.
  if (phase === 'REVIEW') return { exitCode: 3, result: null, error: reason };
  if (phase === 'SCOUT') return { exitCode: 0, result: { schema_version: 1, status: 'BLOCKED', proposals: [], notes: reason }, error: null };
  return { exitCode: 0, result: { schema_version: 1, status: 'BLOCKED', defect_class: null, blocker: reason, notes: 'managed API runtime stopped the node' }, error: null };
}

// One node. Never throws: returns { exitCode, result, error, usage }.
export async function runApiNode({ root, brief, env = process.env, fetchImpl = globalThis.fetch, memberId = '' }) {
  const phase = brief?.phase;
  if (!PHASES.includes(phase)) return { exitCode: 64, result: null, error: `invalid phase: ${String(phase).slice(0, 32)}` };
  let observation;
  try {
    const binding = await verifyTeamBinding(root);
    const member = selectMember(binding.config, phase, memberId);
    observation = await beginApiObservation(root, binding, member, brief);
    const { result, usage } = await converse({ root, team: binding, member, brief, env, fetchImpl, observation });
    await observation.finish(result.status === 'BLOCKED' || result.result === 'FAIL' ? 'BLOCKED' : 'DONE', usage);
    return { exitCode: 0, result, error: null, usage, member_id: member.id };
  } catch (error) {
    if (observation) await observation.finish('BLOCKED').catch(() => null);
    if (error instanceof TransportError) return { exitCode: 1, result: null, error: error.message };
    if (error instanceof Blocked) return blockedOutcome(phase, error.message);
    if (error?.code && String(error.code).startsWith('TEAM_')) return blockedOutcome(phase, `${error.code}: ${error.message}`);
    return { exitCode: 1, result: null, error: `managed API runtime failed: ${error?.code || error?.name || 'error'}` };
  }
}

// A deliberate, single, minimal request that shows whether a member's
// provider answers with an approved model. It is a real call when the
// endpoint is a paid API, so nothing runs it implicitly; team_status never does.
export async function verifyMemberReadiness(root, memberId, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const binding = await verifyTeamBinding(root);
  const member = binding.config.members.find((item) => item.id === memberId);
  if (!member || member.execution_kind !== 'managed_api') throw new Blocked(`member ${memberId} is not a managed_api member of the approved team`);
  const brief = { phase: 'VALIDATE', work_item_id: 'readiness', prompt: 'Readiness check. Call no tool. Reply only with the result JSON with status DONE and notes "ready".', allowed_paths: [], frozen_paths: [] };
  const probe = { ...member, tool_scope: [] };
  try {
    await converse({ root, team: binding, member: probe, brief, env, fetchImpl, turnsOverride: 1 });
    return { ok: true, member_id: memberId, state: 'verified' };
  } catch (error) {
    await record(root, binding, member, { state: 'failed', source: 'provider-error', detail: 'the explicit readiness probe did not complete successfully' });
    return { ok: false, member_id: memberId, state: 'failed', detail: error.message };
  }
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--brief', '--result'].includes(argv[i]) || typeof argv[i + 1] !== 'string') { process.stderr.write('usage: api-runtime.mjs --brief <file> --result <file>\n'); return 64; }
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.brief || !args.result) { process.stderr.write('usage: api-runtime.mjs --brief <file> --result <file>\n'); return 64; }
  let brief;
  try { brief = JSON.parse(await fs.readFile(args.brief, 'utf8')); } catch { process.stderr.write('the node brief is not JSON\n'); return 65; }
  if (process.env.LOOP_PHASE && brief.phase !== process.env.LOOP_PHASE) { process.stderr.write('the brief phase does not match LOOP_PHASE\n'); return 65; }
  const root = await fs.realpath(process.env.LOOP_ROOT || process.cwd());
  const outcome = await runApiNode({ root, brief, env: process.env, memberId: process.env.API_TEAM_MEMBER || '' });
  if (outcome.error) process.stderr.write(`${outcome.error}\n`);
  if (outcome.usage) process.stderr.write(`managed API usage: member ${outcome.member_id}, ${outcome.usage.turns} turn(s), ${outcome.usage.tokens} token(s), ${outcome.usage.tool_calls} tool call(s)\n`);
  if (outcome.result) await fs.writeFile(args.result, `${JSON.stringify(outcome.result)}\n`, { mode: 0o600 });
  return outcome.exitCode;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
export const runtimePath = fileURLToPath(import.meta.url);
