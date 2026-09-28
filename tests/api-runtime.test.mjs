// Managed API runtime against a local HTTP fixture that speaks the OpenAI
// Responses and Anthropic Messages protocols. No test contacts a real
// provider or spends anything. What is checked: a genuine tool loop, path
// protection, a read-only reviewer, exact model enforcement without fallback,
// turn, token and time budgets, the approval binding, credential handling,
// and that the output is only a node result the orchestrator still judges.
import assert from 'node:assert/strict';
import { readApiObservation } from '../runtimes/api-observability.mjs';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { signApproval } from '../control/approval-store.mjs';
import { loadTeam, teamConfigure, teamStatus } from '../control/team.mjs';
import { runApiNode, selectMember, verifyMemberReadiness } from '../runtimes/api-runtime.mjs';
import { openaiResponses, anthropicMessages } from '../runtimes/api-protocols.mjs';
import { effectivePath } from '../control/common.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.BUILD_LOOP_APPROVAL_STORE = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-runtime-approval-store-')));
await fs.chmod(process.env.BUILD_LOOP_APPROVAL_STORE, 0o700);

const OPENAI_SECRET = 'fixture-openai-credential-0001';
const ANTHROPIC_SECRET = 'fixture-anthropic-credential-0002';
const DOTENV_SECRET = 'fixture-dotenv-value-0003';
const env = { TEAM_TEST_OPENAI_KEY: OPENAI_SECRET, TEAM_TEST_ANTHROPIC_KEY: ANTHROPIC_SECRET };
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async (file) => fs.stat(file).then(() => true, () => false);

// One local fixture server for the whole file; each test installs its handler.
const requests = [];
let handler = () => ({ status: 500, body: {} });
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const entry = { path: req.url, headers: req.headers, body: JSON.parse(raw) };
  requests.push(entry);
  const reply = await handler(entry, requests.length);
  res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
  res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
server.unref();
after(() => { server.closeAllConnections(); server.close(); });
const serve = (fn) => { requests.length = 0; handler = fn; };

const usage = { input_tokens: 10, output_tokens: 5 };
const openai = (model, output, extra = {}) => ({ body: { id: 'resp-fixture', object: 'response', status: 'completed', model, output, usage, ...extra } });
const call = (id, name, args) => ({ type: 'function_call', id: `fc-${id}`, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' });
const message = (text) => ({ type: 'message', id: 'msg-fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const anthropic = (model, content, stopReason) => ({ body: { id: 'msg-fixture', type: 'message', role: 'assistant', model, content, stop_reason: stopReason, usage } });
const fenced = (value) => `Finished.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const done = (notes = 'done') => ({ schema_version: 1, status: 'DONE', defect_class: null, blocker: null, notes });
const verdictFor = (brief) => ({
  schema_version: 1, verdict_id: 'verdict-1', run_id: brief.run_id, work_item_id: brief.work_item_id, phase: 'REVIEW', gate_id: 'REVIEW',
  nonce: brief.nonce, result: 'PASS', reviewer: 'reviewer-1', independent: true, revision: brief.revision,
  captured_at: '2026-01-01T00:00:00Z', evidence_refs: brief.evidence_refs, findings: [],
});

const budget = { max_turns: 4, max_total_tokens: 10000, max_seconds: 30 };
const builder = (extra = {}) => ({
  id: 'builder-1', role: 'builder', provider: 'openai', execution_kind: 'managed_api', requested_model: 'gpt-test',
  allowed_resolved_models: ['gpt-test-2026-01-01'], tool_scope: ['list_files', 'read_file', 'write_file'],
  data_scope: { read_paths: ['**'], write_paths: ['src/**'] }, credential_env: 'TEAM_TEST_OPENAI_KEY', endpoint, budget, ...extra,
});
const reviewer = (extra = {}) => ({
  id: 'reviewer-1', role: 'reviewer', provider: 'anthropic', execution_kind: 'managed_api', requested_model: 'claude-test',
  tool_scope: ['list_files', 'read_file'], data_scope: { read_paths: ['**'], write_paths: [] }, credential_env: 'TEAM_TEST_ANTHROPIC_KEY', endpoint, budget, ...extra,
});

async function project({ members = [builder(), reviewer()], approved = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-runtime-test-')));
  await fs.mkdir(path.join(root, '.loop', 'work-items'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'app.txt'), 'app content\n');
  await fs.writeFile(path.join(root, '.env'), `TOKEN=${DOTENV_SECRET}\n`);
  await fs.writeFile(path.join(root, '.git', 'config'), '[core]\n');
  await fs.writeFile(path.join(root, '.loop', 'state.json'), JSON.stringify({ schema_version: 1, phase: 'EXECUTE' }));
  await fs.writeFile(path.join(root, '.loop', 'project.adapter.json'), JSON.stringify({ protected_paths: ['src/protected/**'] }));
  await fs.writeFile(path.join(root, '.loop', 'work-items', 'WI-001.md'), '# WI-001\n');
  await teamConfigure(root, { config: { schema_version: 1, team_id: 'api-team', mode: 'sequential', execution_policy: 'api_only', members } });
  if (approved) {
    const team = await loadTeam(root);
    const receipt = { approval_id: team.proposal_id, setup_digest: team.team_digest, channel: 'local-http-user', approved_at: '2026-01-01T00:00:00Z', decision: 'APPROVE' };
    receipt.host_signature = await signApproval(root, receipt);
    await fs.writeFile(path.join(root, '.loop', 'control', 'team.approval.json'), JSON.stringify(receipt));
  }
  return root;
}

const brief = (phase, extra = {}) => ({
  schema_version: 1, run_id: `run-WI-001-1-${phase}`, node_id: `${phase.toLowerCase()}-1`, gate_id: phase, work_item_id: 'WI-001', phase,
  prompt: `Perform ${phase}.`, allowed_paths: phase === 'EXECUTE' ? ['src/**'] : ['.loop/work-items/**'], frozen_paths: ['requirements/**'], ...extra,
});
const reviewBrief = () => brief('REVIEW', { nonce: 'nonce-1', revision: 'rev-1', evidence_refs: ['run-1-orchestrator'], allowed_paths: [], frozen_paths: [] });
const toolOutputs = (request) => Object.fromEntries(request.body.input.filter((item) => item.type === 'function_call_output').map((item) => [item.call_id, item.output]));
const readiness = (root, id) => readJson(path.join(root, '.loop', 'scheduler', 'team', 'readiness', `${id}.json`));

test('a builder runs a genuine OpenAI Responses tool loop inside its allowed paths', async () => {
  const root = await project();
  serve((entry, n) => n === 1
    ? openai('gpt-test-2026-01-01', [call('c1', 'list_files', { path: 'src' }), call('c2', 'write_file', { path: 'src/hello.txt', content: 'hello\n' }), call('c3', 'read_file', { path: 'src/app.txt' })])
    : openai('gpt-test-2026-01-01', [message(fenced(done('wrote src/hello.txt')))]));
  const outcome = await runApiNode({ root, brief: brief('EXECUTE'), env });
  assert.equal(outcome.exitCode, 0, outcome.error);
  assert.deepEqual(outcome.result, done('wrote src/hello.txt'));
  assert.equal(await fs.readFile(path.join(root, 'src', 'hello.txt'), 'utf8'), 'hello\n');
  assert.equal(requests.length, 2);
  const [first, second] = requests;
  assert.equal(first.path, '/v1/responses');
  assert.equal(first.headers.authorization, `Bearer ${OPENAI_SECRET}`);
  assert.equal(first.body.model, 'gpt-test');
  assert.equal(first.body.store, false);
  assert.ok(first.body.max_output_tokens <= 8192);
  assert.deepEqual(first.body.tools.map((tool) => tool.name), ['list_files', 'read_file', 'write_file']);
  assert.ok(first.body.tools.every((tool) => tool.type === 'function' && tool.strict === true));
  assert.equal(second.body.model, 'gpt-test', 'the requested model stays the requested model on every turn');
  const outputs = toolOutputs(second);
  assert.deepEqual(JSON.parse(outputs.c1).files, ['src/app.txt']);
  assert.deepEqual(JSON.parse(outputs.c2), { written: 'src/hello.txt', bytes: 6 });
  assert.equal(outputs.c3, 'app content\n');
  assert.ok(second.body.input.some((item) => item.type === 'function_call' && item.call_id === 'c2'), 'the function calls go back with their outputs');
  assert.deepEqual(outcome.usage, { turns: 2, tokens: 30, tool_calls: 3 });
  const observed = await readApiObservation(root);
  assert.equal(observed.status, 'DONE');
  assert.equal(observed.member_id, 'builder-1');
  assert.equal(observed.reported_model, 'gpt-test-2026-01-01');
  assert.deepEqual(observed.usage, outcome.usage);
  assert.match(observed.session_id, /^api-node-/);
  assert.ok(observed.finished_at);
  assert.equal(JSON.stringify(observed).includes(OPENAI_SECRET), false);
  const record = await readiness(root, 'builder-1');
  assert.equal(record.state, 'verified');
  assert.equal(record.source, 'provider-response');
  assert.equal(record.resolved_model, 'gpt-test-2026-01-01');
  const status = await teamStatus(root, { env });
  assert.equal(status.members.find((member) => member.id === 'builder-1').readiness.state, 'verified');
});

test('tools refuse escapes, runner-owned records, secrets, symlinks, frozen and protected paths', async () => {
  const root = await project();
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-runtime-outside-')));
  await fs.symlink(outside, path.join(root, 'src', 'link'));
  const attempts = [
    ['w1', 'write_file', { path: '../escape.txt', content: 'x' }, /\.\./],
    ['w2', 'write_file', { path: path.join(outside, 'abs.txt'), content: 'x' }, /relative/],
    ['w3', 'write_file', { path: '.loop/control/evil.json', content: '{}' }, /only \.loop file/],
    ['w4', 'write_file', { path: '.loop/state.json', content: '{}' }, /only \.loop file/],
    ['w5', 'write_file', { path: '.loop/work-items/WI-001.md', content: 'x' }, /only \.loop file/],
    ['w6', 'write_file', { path: 'docs/out.md', content: 'x' }, /write_paths/],
    ['w7', 'write_file', { path: 'src/protected/a.txt', content: 'x' }, /protected/],
    ['w8', 'write_file', { path: 'requirements/spec.md', content: 'x' }, /write_paths/],
    ['w9', 'write_file', { path: 'src/link/a.txt', content: 'x' }, /symlink/],
    ['w10', 'write_file', { path: '.env', content: 'x' }, /secrets/],
    ['r1', 'read_file', { path: '.env' }, /secrets/],
    ['r2', 'read_file', { path: '.loop/control/team.json' }, /runner-owned/],
    ['r3', 'read_file', { path: '.git/config' }, /\.git/],
    ['r4', 'read_file', { path: 'src/link/../../x' }, /\.\./],
    ['l1', 'list_files', { path: '.loop/control' }, /runner-owned/],
    ['x1', 'run_shell', { command: 'id' }, /not available/],
  ];
  serve((entry, n) => n === 1
    ? openai('gpt-test', attempts.map(([id, name, args]) => call(id, name, args)).slice(0, 16))
    : openai('gpt-test', [message(fenced(done()))]));
  const outcome = await runApiNode({ root, brief: brief('EXECUTE', { frozen_paths: ['src/frozen/**'] }), env });
  assert.equal(outcome.exitCode, 0, outcome.error);
  const outputs = toolOutputs(requests[1]);
  for (const [id, , , pattern] of attempts) assert.match(outputs[id], pattern, `${id}: ${outputs[id]}`);
  assert.equal(await exists(path.join(path.dirname(root), 'escape.txt')), false);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(await exists(path.join(root, '.loop', 'control', 'evil.json')), false);
  assert.equal(await fs.readFile(path.join(root, '.loop', 'work-items', 'WI-001.md'), 'utf8'), '# WI-001\n');
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), `TOKEN=${DOTENV_SECRET}\n`);
  assert.ok(!JSON.stringify(requests).includes(DOTENV_SECRET), 'a secret file never reaches the provider');

  // A frozen path inside the member's own write_paths is still refused.
  serve((entry, n) => n === 1 ? openai('gpt-test', [call('f1', 'write_file', { path: 'src/frozen/a.txt', content: 'x' })]) : openai('gpt-test', [message(fenced(done()))]));
  await runApiNode({ root, brief: brief('EXECUTE', { frozen_paths: ['src/frozen/**'] }), env });
  assert.match(toolOutputs(requests[1]).f1, /frozen/);
  assert.equal(await exists(path.join(root, 'src', 'frozen', 'a.txt')), false);

  // DEFINE edits only the work item file.
  serve((entry, n) => n === 1
    ? openai('gpt-test', [call('d1', 'write_file', { path: '.loop/work-items/WI-001.md', content: '# WI-001\n\n## Acceptance criteria\n- AC-1\n' }), call('d2', 'write_file', { path: 'src/app.txt', content: 'x' })])
    : openai('gpt-test', [message(fenced(done()))]));
  await runApiNode({ root, brief: brief('DEFINE'), env });
  const defineOutputs = toolOutputs(requests[1]);
  assert.match(defineOutputs.d1, /written/);
  assert.match(defineOutputs.d2, /only the work item/);
  assert.equal(await fs.readFile(path.join(root, 'src', 'app.txt'), 'utf8'), 'app content\n');
});

test('an Anthropic Messages reviewer reads but can never write', async () => {
  const root = await project();
  const challenge = reviewBrief();
  serve((entry, n) => n === 1
    ? anthropic('claude-test', [
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/app.txt' } },
      { type: 'tool_use', id: 't2', name: 'write_file', input: { path: 'src/app.txt', content: 'changed' } },
    ], 'tool_use')
    : anthropic('claude-test', [{ type: 'text', text: fenced(verdictFor(challenge)) }], 'end_turn'));
  const outcome = await runApiNode({ root, brief: challenge, env });
  assert.equal(outcome.exitCode, 0, outcome.error);
  assert.deepEqual(outcome.result, verdictFor(challenge));
  const [first, second] = requests;
  assert.equal(first.path, '/v1/messages');
  assert.equal(first.headers['x-api-key'], ANTHROPIC_SECRET);
  assert.equal(first.headers['anthropic-version'], '2023-06-01');
  assert.equal(first.headers.authorization, undefined);
  assert.equal(first.body.model, 'claude-test');
  assert.deepEqual(first.body.tools.map((tool) => tool.name), ['list_files', 'read_file']);
  const results = second.body.messages[2].content;
  assert.equal(second.body.messages[1].role, 'assistant');
  assert.deepEqual(results[0], { type: 'tool_result', tool_use_id: 't1', content: 'app content\n' });
  assert.equal(results[1].tool_use_id, 't2');
  assert.equal(results[1].is_error, true);
  assert.match(results[1].content, /not available/);
  assert.equal(await fs.readFile(path.join(root, 'src', 'app.txt'), 'utf8'), 'app content\n');

  // A verdict that does not echo the challenge is a provider failure.
  serve(() => anthropic('claude-test', [{ type: 'text', text: fenced({ ...verdictFor(challenge), nonce: 'guessed' }) }], 'end_turn'));
  const wrong = await runApiNode({ root, brief: challenge, env });
  assert.equal(wrong.exitCode, 1);
  assert.equal(wrong.result, null);
  assert.match(wrong.error, /nonce/);

  // REVIEW belongs to a reviewer, never to the builder.
  serve(() => openai('gpt-test', [message(fenced(done()))]));
  const self = await runApiNode({ root, brief: challenge, env, memberId: 'builder-1' });
  assert.equal(self.exitCode, 3);
  assert.match(self.error, /needs reviewer/);
  assert.equal(requests.length, 0);
});

test('only the requested model or an approved resolved model is accepted, with no fallback', async () => {
  const root = await project();
  serve(() => openai('gpt-other', [message(fenced(done()))]));
  let outcome = await runApiNode({ root, brief: brief('EXECUTE'), env });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, 'BLOCKED');
  assert.match(outcome.result.blocker, /gpt-other.*no fallback/);
  assert.equal(requests.length, 1, 'no second request with another model');
  const record = await readiness(root, 'builder-1');
  assert.equal(record.state, 'failed');
  assert.equal(record.resolved_model, 'gpt-other');
  assert.equal((await teamStatus(root, { env })).members.find((member) => member.id === 'builder-1').readiness.state, 'failed');

  serve(() => { const reply = openai('gpt-test', [message(fenced(done()))]); delete reply.body.model; return reply; });
  outcome = await runApiNode({ root, brief: brief('EXECUTE'), env });
  assert.equal(outcome.result.status, 'BLOCKED');
  assert.match(outcome.result.blocker, /no model/);

  // REVIEW has no BLOCKED verdict: the runtime exits nonzero so the run blocks.
  serve(() => anthropic('claude-other', [{ type: 'text', text: fenced(verdictFor(reviewBrief())) }], 'end_turn'));
  outcome = await runApiNode({ root, brief: reviewBrief(), env });
  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.result, null);
  assert.match(outcome.error, /claude-other/);
});

test('turn, token and time budgets block instead of passing', async () => {
  const root = await project();
  serve(() => openai('gpt-test', [call(`c${requests.length}`, 'list_files', { path: 'src' })]));
  let outcome = await runApiNode({ root, brief: brief('EXECUTE'), env });
  assert.equal(outcome.result.status, 'BLOCKED');
  assert.match(outcome.result.blocker, /turn budget of 4/);
  assert.equal(requests.length, 4);

  serve(() => openai('gpt-test', [message(fenced(done()))], { usage: { input_tokens: 9000, output_tokens: 2000 } }));
  outcome = await runApiNode({ root, brief: brief('EXECUTE'), env });
  assert.match(outcome.result.blocker, /token budget of 10000/);

  serve(() => openai('gpt-test', [message(fenced(done()))], { usage: undefined }));
  outcome = await runApiNode({ root, brief: brief('EXECUTE'), env });
  assert.match(outcome.result.blocker, /no token usage/);

  serve(() => openai('gpt-test', [message('partial')], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
  outcome = await runApiNode({ root, brief: brief('EXECUTE'), env });
  assert.match(outcome.result.blocker, /output limit/);

  const timedOut = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  outcome = await runApiNode({ root, brief: brief('EXECUTE'), env, fetchImpl: timedOut });
  assert.match(outcome.result.blocker, /time budget of 30s/);
});

test('nothing is sent without an approved team and an explicit credential variable', async () => {
  const unapproved = await project({ approved: false });
  serve(() => openai('gpt-test', [message(fenced(done()))]));
  let outcome = await runApiNode({ root: unapproved, brief: brief('EXECUTE'), env });
  assert.equal(outcome.result.status, 'BLOCKED');
  assert.match(outcome.result.blocker, /TEAM_APPROVAL_REQUIRED/);
  outcome = await runApiNode({ root: unapproved, brief: reviewBrief(), env });
  assert.equal(outcome.exitCode, 3);
  assert.equal(requests.length, 0);

  const root = await project();
  outcome = await runApiNode({ root, brief: brief('EXECUTE'), env: { OPENAI_API_KEY: OPENAI_SECRET } });
  assert.equal(outcome.result.status, 'BLOCKED');
  assert.match(outcome.result.blocker, /TEAM_TEST_OPENAI_KEY .*not set/);
  assert.equal(requests.length, 0, 'no other variable is scraped for a key');

  serve(() => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${OPENAI_SECRET}` } } }));
  outcome = await runApiNode({ root, brief: brief('EXECUTE'), env });
  assert.match(outcome.result.blocker, /refused the credential/);
  assert.ok(!JSON.stringify(outcome).includes(OPENAI_SECRET));
  assert.equal((await readiness(root, 'builder-1')).state, 'failed');

  serve(() => ({ status: 500, body: { error: { message: 'overloaded' } } }));
  outcome = await runApiNode({ root, brief: brief('EXECUTE'), env });
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.result, null);
  assert.match(outcome.error, /HTTP 500/);
  assert.equal(requests.length, 1, 'no silent retry');

  // A key the model repeats is redacted from the result it hands on.
  serve(() => openai('gpt-test', [message(fenced(done(`the key is ${OPENAI_SECRET}`)))]));
  outcome = await runApiNode({ root, brief: brief('EXECUTE'), env });
  assert.equal(outcome.result.notes, 'the key is [redacted]');
  serve((request, turn) => turn === 1
    ? openai('gpt-test', [call('secret-echo', 'write_file', { path: 'src/app.txt', content: `credential ${OPENAI_SECRET}` })])
    : openai('gpt-test', [message(fenced(done()))]));
  outcome = await runApiNode({ root, brief: brief('EXECUTE'), env });
  assert.equal(outcome.exitCode, 0, outcome.error);
  assert.equal(await fs.readFile(path.join(root, 'src/app.txt'), 'utf8'), 'credential [redacted]', 'a repeated credential never reaches a file-tool write');
  serve(() => openai('gpt-test', [message(fenced(done()))]));
  outcome = await runApiNode({ root, brief: brief('EXECUTE', { prompt: `An accidental excerpt contains ${OPENAI_SECRET} and ${ANTHROPIC_SECRET}.` }), env });
  assert.equal(outcome.exitCode, 0, outcome.error);
  assert.ok(!JSON.stringify(requests[0].body).includes(OPENAI_SECRET));
  assert.ok(!JSON.stringify(requests[0].body).includes(ANTHROPIC_SECRET), 'other approved member credentials never enter a prompt');
});

test('a local or mock member speaks the Responses protocol without any credential', async () => {
  const root = await project({ members: [builder({ provider: 'mock', credential_env: null }), reviewer()] });
  serve(() => openai('gpt-test', [message(fenced(done()))]));
  const outcome = await runApiNode({ root, brief: brief('EXECUTE'), env: {} });
  assert.equal(outcome.exitCode, 0, outcome.error);
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].path, '/v1/responses');
});

test('VALIDATE is read-only even for a builder, and readiness can be checked on purpose', async () => {
  const root = await project();
  serve(() => openai('gpt-test', [message(fenced(done()))]));
  const outcome = await runApiNode({ root, brief: brief('VALIDATE'), env });
  assert.equal(outcome.exitCode, 0, outcome.error);
  assert.deepEqual(requests[0].body.tools.map((tool) => tool.name), ['list_files', 'read_file']);

  serve(() => openai('gpt-test-2026-01-01', [message(fenced(done('ready')))]));
  const check = await verifyMemberReadiness(root, 'builder-1', { env });
  assert.equal(check.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.tools, undefined, 'the readiness probe offers no tool');
  assert.equal((await readiness(root, 'builder-1')).resolved_model, 'gpt-test-2026-01-01');

  const team = await loadTeam(root);
  assert.throws(() => selectMember({ ...team.config, execution_policy: 'native_only' }, 'EXECUTE'), /native_only/);
  assert.equal(selectMember(team.config, 'SCOUT').id, 'reviewer-1');
});

test('readiness needs no active adapter and an unsuccessful probe replaces earlier verified readiness', async () => {
  const root = await project();
  await fs.unlink(path.join(root, '.loop', 'project.adapter.json'));
  serve(() => openai('gpt-test', [message(fenced(done('ready')))]));
  assert.equal((await verifyMemberReadiness(root, 'builder-1', { env })).ok, true);
  serve(() => openai('gpt-test', [message('invalid result')]));
  assert.equal((await verifyMemberReadiness(root, 'builder-1', { env })).ok, false);
  assert.equal((await readiness(root, 'builder-1')).state, 'failed');
  const node = await runApiNode({ root, brief: brief('EXECUTE'), env });
  assert.equal(node.result.status, 'BLOCKED', 'file tools still require the active adapter');
});

test('both API protocols reject negative, fractional, string and overflowing reported usage', () => {
  for (const value of [-1, 0.5, '5', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(openaiResponses.parse(openai('gpt-test', [], { usage: { input_tokens: value, output_tokens: 5 } }).body).tokens, null);
    const response = anthropic('claude-test', [], 'end_turn').body;
    response.usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: value };
    assert.equal(anthropicMessages.parse(response).tokens, null);
  }
  assert.equal(openaiResponses.parse(openai('gpt-test', [], { usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 } }).body).tokens, null);
});

test('every one of the six runner phases gets only a node result; the runner keeps the gates', async () => {
  const root = await project();
  const snapshot = async () => {
    const files = {};
    async function walk(dir, rel) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (child === 'scheduler') continue;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), child);
        else files[child] = await fs.readFile(path.join(dir, entry.name), 'utf8');
      }
    }
    await walk(path.join(root, '.loop'), '');
    return files;
  };
  const before = await snapshot();
  for (const phase of ['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER']) {
    const nodeBrief = phase === 'REVIEW' ? reviewBrief() : brief(phase);
    serve((entry) => entry.path === '/v1/messages'
      ? anthropic('claude-test', [{ type: 'text', text: fenced(verdictFor(nodeBrief)) }], 'end_turn')
      : openai('gpt-test', [message(fenced(done()))]));
    const outcome = await runApiNode({ root, brief: nodeBrief, env });
    assert.equal(outcome.exitCode, 0, `${phase}: ${outcome.error}`);
    assert.deepEqual(outcome.result, phase === 'REVIEW' ? verdictFor(nodeBrief) : done(), phase);
    assert.equal(requests[0].path, phase === 'REVIEW' ? '/v1/messages' : '/v1/responses', `${phase} goes to the ${phase === 'REVIEW' ? 'reviewer' : 'builder'}`);
  }
  assert.deepEqual(await snapshot(), before, 'the runtime writes no state, evidence, gate or control record');
});

function runProvider(root, nodeBrief, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(repo, 'hosts', 'api', 'provider.sh'), [], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, BUILD_LOOP_APPROVAL_STORE: process.env.BUILD_LOOP_APPROVAL_STORE, LOOP_ROOT: root, LOOP_PHASE: nodeBrief.phase, LOOP_RUN_ID: nodeBrief.run_id, LOOP_WORK_ITEM: 'WI-001', ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(nodeBrief));
  });
}

test('hosts/api/provider.sh follows the provider stdin/stdout contract', async () => {
  const root = await project();
  serve((entry, n) => n === 1
    ? openai('gpt-test', [call('c1', 'write_file', { path: 'src/out.txt', content: 'out\n' })])
    : openai('gpt-test', [message(fenced(done(`noted ${OPENAI_SECRET}`)))]));
  const desktopPath = effectivePath('/usr/bin:/bin');
  assert.equal(desktopPath.split(path.delimiter)[0], path.dirname(process.execPath), 'GUI workers use the active bundled Node runtime before a system Node');
  let run = await runProvider(root, brief('EXECUTE'), { ...env, PATH: desktopPath });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout.trim().split('\n').length, 1, 'stdout is one JSON line');
  assert.deepEqual(JSON.parse(run.stdout), done('noted [redacted]'));
  assert.equal(await fs.readFile(path.join(root, 'src', 'out.txt'), 'utf8'), 'out\n');
  assert.ok(!run.stderr.includes(OPENAI_SECRET) && !run.stdout.includes(OPENAI_SECRET));
  assert.match(run.stderr, /managed API usage: member builder-1, 2 turn/);

  // A policy stop is a BLOCKED result for a build phase ...
  serve(() => openai('gpt-other', [message(fenced(done()))]));
  run = await runProvider(root, brief('EXECUTE'), env);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, 'BLOCKED');

  // ... and a nonzero exit for REVIEW.
  serve(() => anthropic('claude-other', [{ type: 'text', text: fenced(verdictFor(reviewBrief())) }], 'end_turn'));
  run = await runProvider(root, reviewBrief(), env);
  assert.notEqual(run.code, 0);
  assert.equal(run.stdout, '');

  serve(() => anthropic('claude-test', [{ type: 'text', text: fenced(verdictFor(reviewBrief())) }], 'end_turn'));
  run = await runProvider(root, reviewBrief(), env);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), verdictFor(reviewBrief()));
});

test('the managed API path starts no process and names no agent CLI', async () => {
  for (const name of await fs.readdir(path.join(repo, 'runtimes'))) {
    const source = await fs.readFile(path.join(repo, 'runtimes', name), 'utf8');
    assert.doesNotMatch(source, /child_process|\bspawn\(|\bexecFile\(|\bexecSync\(|\bfork\(/, name);
  }
  const wrapper = await fs.readFile(path.join(repo, 'hosts', 'api', 'provider.sh'), 'utf8');
  assert.doesNotMatch(wrapper, /CODEX_BIN|CLAUDE_BIN|\bcodex exec\b|\bclaude -p\b/);
  assert.match(wrapper, /provider_run_timed "\$node_bin" "\$provider_dir\/runtimes\/api-runtime\.mjs"/);
});
