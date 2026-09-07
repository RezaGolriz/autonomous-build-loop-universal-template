import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createHandler, serveStdio } from '../mcp/server.mjs';

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
function fixture() {
  const calls = [];
  return { calls, handle: createHandler({ root: '/fixed/project', operations: { status: { description: 'State', inputSchema: { type: 'object', additionalProperties: false } } },
    dispatch: async (...args) => { calls.push(args); return { run_status: 'PAUSED' }; }, requestApproval: async () => ({ approval_url: 'http://127.0.0.1:1234/review' }) }) };
}
test('MCP initializes, lists typed tools, and binds calls to configured root', async () => {
  const { calls, handle } = fixture();
  assert.equal((await handle({ jsonrpc: '2.0', id: 0, method: 'tools/list' })).error.code, -32002);
  assert.equal((await handle(init)).result.protocolVersion, '2025-11-25');
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map(t => t.name), ['loop_status', 'loop_request_approval']);
  assert.equal((await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'loop_status', arguments: {} } })).result.structuredContent.run_status, 'PAUSED');
  assert.deepEqual(calls, [['/fixed/project', 'status', {}]]);
});
test('MCP rejects root changes, unknown tools, duplicate initialize and forged approval', async () => {
  const { calls, handle } = fixture(); await handle(init);
  for (const params of [{ name: 'loop_status', arguments: { root: '/other' } }, { name: 'loop_exec' }, { name: 'loop_request_approval', arguments: { confirmed: true } }])
    assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params })).error.code, -32602);
  assert.equal((await handle(init)).error.code, -32600); assert.equal(calls.length, 0);
});
test('MCP newline framing handles partial UTF-8 input and returns parse errors without logging to stdout', async () => {
  const { handle } = fixture(); const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', chunk => text += chunk); const drained = serveStdio(handle, input, output);
  const message = Buffer.from(`${JSON.stringify(init)}\nnot-json\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  input.write(message.subarray(0, 17)); input.write(message.subarray(17)); input.end();
  await new Promise(resolve => input.on('end', resolve)); await drained();
  const replies = text.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 2); assert.equal(replies.find(reply => reply.error).error.code, -32700);
});
test('MCP limits oversized frames and pipelined requests before dispatch', async () => {
  for (const payload of [Buffer.alloc(1024 * 1024 + 1, 65), Buffer.from(`${JSON.stringify(init)}\n`.repeat(257))]) {
    const { calls, handle } = fixture(); const input = new PassThrough(), output = new PassThrough(); let text = '';
    output.on('data', chunk => text += chunk); const drained = serveStdio(handle, input, output);
    input.write(payload); await drained();
    assert.equal(JSON.parse(text.trim()).error.code, -32600); assert.equal(calls.length, 0);
  }
});
test('MCP processes the final frame when the client closes without a newline', async () => {
  const { handle } = fixture(); const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', chunk => text += chunk); const drained = serveStdio(handle, input, output);
  input.end(JSON.stringify(init)); await new Promise(resolve => input.on('end', resolve)); await drained();
  assert.equal(JSON.parse(text.trim()).id, init.id);
});
test('MCP preserves actionable control diagnostics without stacks', async () => {
  const handle = createHandler({ root: '/fixed/project', operations: { prepare: { description: 'Prepare', inputSchema: { type: 'object' } } }, dispatch: async () => {
    const error = new Error('More information is needed'); error.name = 'ControlError'; error.code = 'MISSING_INPUT'; error.details = { missing_inputs: ['request'] }; throw error;
  } });
  await handle(init);
  const reply = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'loop_prepare', arguments: {} } });
  assert.equal(reply.result.isError, true);
  assert.deepEqual(JSON.parse(reply.result.content[0].text), { code: 'MISSING_INPUT', message: 'More information is needed', details: { missing_inputs: ['request'] } });
});
test('MCP normalizes empty results and non-Error throws, and echoes malformed request IDs', async () => {
  const handle = createHandler({ root: '/fixed/project', operations: { status: { description: 'Status', inputSchema: { type: 'object' } } }, dispatch: async (_root, _operation, args) => { if (args.fail) throw null; } });
  await handle(init);
  const call = args => handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'loop_status', arguments: args } });
  assert.equal((await call({})).result.content[0].text, 'null');
  assert.equal((await call({ fail: true })).result.isError, true);
  assert.equal((await handle({ jsonrpc: '1.0', id: 87, method: 'ping' })).id, 87);
});
test('MCP answers ping while a tool is running and survives input errors', async () => {
  let finish; const blocking = new Promise(resolve => { finish = resolve; });
  const handle = async message => message.method === 'ping' ? { jsonrpc: '2.0', id: message.id, result: {} } : (await blocking, { jsonrpc: '2.0', id: message.id, result: {} });
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', chunk => text += chunk); const drained = serveStdio(handle, input, output);
  input.write('{"jsonrpc":"2.0","id":1,"method":"slow"}\n');
  await Promise.resolve(); input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(JSON.parse(text.trim()).id, 2);
  finish(); await drained(); assert.equal(text.trim().split('\n').length, 2);
  input.emit('error', new Error('test stream failure')); input.destroy();
});
