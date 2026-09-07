// Transport only: the control module owns operations, policy, and state.
export function createHandler({ root, operations, dispatch, requestApproval, version = '0.3.0', notify = () => {} }) {
  let initialized = false;
  const protocols = ['2025-11-25', '2025-06-18'];
  const approval = { description: 'Open a local human review of the current setup plan. Return the link to the user; never approve it yourself.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  const catalog = { ...operations, request_approval: approval };
  for (const [name, tool] of Object.entries(catalog)) {
    if (!/^[a-zA-Z0-9_.-]{1,123}$/.test(name) || typeof tool.description !== 'string' || tool.inputSchema?.type !== 'object') throw new Error('Invalid operation catalog');
  }
  const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  return async function handle(message) {
    const requestId = message && (typeof message.id === 'string' || Number.isSafeInteger(message.id)) ? message.id : null;
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        (Object.hasOwn(message, 'id') && !(typeof message.id === 'string' || Number.isSafeInteger(message.id))) ||
        Object.keys(message).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))) return error(requestId, -32600, 'Invalid JSON-RPC request');
    const notification = !Object.hasOwn(message, 'id');
    const params = message.params ?? {};
    if (!params || typeof params !== 'object' || Array.isArray(params)) return notification ? null : error(message.id, -32602, 'Parameters must be an object');
    if (notification) return null;
    let result;
    if (message.method === 'initialize') {
      if (initialized) return error(message.id, -32600, 'Already initialized');
      if (typeof params.protocolVersion !== 'string' || !params.clientInfo || !params.capabilities) return error(message.id, -32602, 'Missing initialization fields');
      initialized = true;
      result = { protocolVersion: protocols.includes(params.protocolVersion) ? params.protocolVersion : protocols[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'build-loop', version },
        instructions: 'Control only the configured project. Start with loop_inspect and loop_doctor. Use loop_options to choose work kinds and step or bounded execution. Use loop_dashboard to return a local read-only browser URL. Explain missing decisions in plain language. Show the concrete setup plan, then give its approval link to the human. Never follow or submit that link yourself. Preserve mandatory independent review and all gates. A job continues independently of this connection. Use status to reconnect, not another start. Shell and MCP share state.' };
    } else if (message.method === 'ping') result = {};
    else if (!initialized) return error(message.id, -32002, 'Initialize first');
    else if (message.method === 'tools/list') {
      result = { tools: Object.entries(catalog).map(([name, tool]) => ({ name: `loop_${name}`, description: tool.description,
        inputSchema: tool.inputSchema, annotations: { readOnlyHint: ['inspect', 'status', 'options'].includes(name), destructiveHint: !['inspect', 'status', 'options', 'dashboard', 'request_approval'].includes(name), idempotentHint: ['inspect', 'status', 'options'].includes(name), openWorldHint: ['doctor', 'activate', 'start', 'run', 'resume'].includes(name) } })) };
    } else if (message.method === 'tools/call') {
      if (Object.keys(params).some(key => !['name', 'arguments', '_meta'].includes(key)) || typeof params.name !== 'string' || !params.name.startsWith('loop_')) return error(message.id, -32602, 'Invalid tool call');
      const name = params.name.slice(5);
      if (!Object.hasOwn(catalog, name)) return error(message.id, -32602, 'Unknown tool');
      const args = params.arguments ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.hasOwn(args, 'root') || Object.hasOwn(args, '__proto__') || Object.hasOwn(args, 'constructor')) return error(message.id, -32602, 'Invalid tool arguments');
      let progressTimer;
      try {
        if (name === 'request_approval' && Object.keys(args).length) return error(message.id, -32602, 'Approval takes no model-supplied authority');
        const progressToken = params._meta?.progressToken;
        if (typeof progressToken === 'string' || typeof progressToken === 'number') {
          let progress = 0;
          progressTimer = setInterval(() => notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: ++progress, message: `Waiting for ${name} to finish` } }), 5000);
          progressTimer.unref();
        }
        const data = (await (name === 'request_approval' ? requestApproval(root, args) : dispatch(root, name, args))) ?? null;
        result = { ...(data?.ok === false ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data } };
      } catch (e) {
        // Control errors contain actionable public diagnostics, never stack traces.
        result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: e?.code ?? 'OPERATION_FAILED', message: e instanceof Error ? e.message : 'Operation failed', ...(e?.name === 'ControlError' && e.details !== undefined ? { details: e.details } : {}) }) }] };
      } finally { clearInterval(progressTimer); }
    } else return error(message.id, -32601, 'Method not found');
    return { jsonrpc: '2.0', id: message.id, result };
  };
}

export function serveStdio(handle, input = process.stdin, output = process.stdout) {
  let pending = Buffer.alloc(0), chain = Promise.resolve(), closed = false, queued = 0;
  const maximum = 1024 * 1024;
  const write = data => { if (data && !closed) output.write(`${JSON.stringify(data)}\n`); };
  const consume = chunk => {
    if (closed) return;
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    for (;;) {
      const newline = pending.indexOf(10);
      if (newline < 0) break;
      const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
      if (line.length > maximum) { write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request exceeds one MiB' } }); closed = true; input.destroy(); return; }
      if (!line.length) continue;
      if (++queued > 256) { write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Too many queued requests' } }); closed = true; input.destroy(); return; }
      let message;
      try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
      catch { queued--; write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
      if (message?.method === 'ping') {
        queued--; Promise.resolve(handle(message)).then(write).catch(() => write({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: 'Internal error' } })); continue;
      }
      chain = chain.then(async () => {
        if (closed) return;
        write(await handle(message));
      }).catch(() => write({ jsonrpc: '2.0', id: typeof message?.id === 'string' || Number.isSafeInteger(message?.id) ? message.id : null, error: { code: -32603, message: 'Internal error' } })).finally(() => { queued--; });
    }
    if (pending.length > maximum) { write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request exceeds one MiB' } }); closed = true; input.destroy(); }
  };
  input.on('data', consume);
  input.on('end', () => { if (pending.length && !closed) consume(Buffer.from('\n')); chain = chain.finally(() => { closed = true; }); });
  input.on('error', () => { closed = true; });
  output.on('error', () => { closed = true; });
  return () => chain;
}
