// Transport only: the control module owns operations, policy, and state.
export function createHandler({ root, operations, dispatch, requestApproval, version = '0.6.2', notify = () => {} }) {
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
      // Opening the chat brings the control page up when the project's policy
      // asks for autostart. In the background; it never throws, and its outcome
      // never reaches the client.
      import('../control/control-page.mjs').then((page) => page.autostartControlPage(root, { reason: 'mcp-initialize' })).catch(() => {});
      result = { protocolVersion: protocols.includes(params.protocolVersion) ? params.protocolVersion : protocols[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'build-loop', version },
        instructions: 'Control only the configured project. Start with loop_inspect and loop_doctor. Use loop_options to choose work kinds and step or bounded execution. Use loop_dashboard to return a browser link to the dashboard; use loop_serve to start or find the long-lived control page, where the person sees the dashboard and makes the human decisions by typing the word. Control page links you receive are single-use (they open the page once, within 10 minutes); ask again for a fresh one. The durable access token is never given to a chat. Hand either link to the person and never open it or submit anything on it yourself. Explain missing decisions in plain language. Show the concrete setup plan, then give its approval link to the human. Never follow or submit that link yourself. Accepting a run, authorizing an item, promoting a proposal and releasing a project-wide hold are human decisions: those tools do not complete here. They return a link to a local page (the control page, when it is running) that shows the exact decision, frozen at that moment, and the person types the word ACCEPT, AUTHORIZE, PROMOTE or RELEASE into a field on it. Hand that link over and wait; never open it yourself. A project set to tty-only refuses those calls with CONFIRMATION_TTY_ONLY and the exact command for the person to run at their own terminal; report that command and do not work around it. loop_deauthorize also places a project-wide hold: while .loop/control/hold.json exists, loop_start, loop_run, loop_resume, loop_tick, loop_task and loop_scout are refused with PROJECT_ON_HOLD, and no new work item escapes it. Do not work around a hold; report it and ask the person to release it. loop_hold is available to you as well when something should stop now; loop_cancel and loop_handover keep working while a hold is on. Preserve mandatory independent review and all gates. A job continues independently of this connection. Use status to reconnect, not another start. Shell and MCP share state. To run the loop inside this chat, configure host chat together with the review_host the person chose (claude or codex for an independent review, or chat); never choose it for them, and without it loop_chat_next refuses with CHAT_REVIEW_HOST_REQUIRED. Call loop_chat_next, give only the returned brief.prompt to a fresh sub-agent, pass its JSON to loop_chat_submit with the node_id and attempt_id from loop_chat_next, and repeat until next_action names a human step. On CHAT_NODE_STALE call loop_chat_next again and use the new attempt_id. The engine still verifies every node. A review done by this same chat is not independently isolated: say so plainly to the person, especially before they accept.' };
    } else if (message.method === 'ping') result = {};
    else if (!initialized) return error(message.id, -32002, 'Initialize first');
    else if (message.method === 'tools/list') {
      result = { tools: Object.entries(catalog).map(([name, tool]) => ({ name: `loop_${name}`, description: tool.description,
        inputSchema: tool.inputSchema, annotations: { readOnlyHint: ['inspect', 'status', 'options', 'check', 'backlog_list', 'inbox_list'].includes(name), destructiveHint: !['inspect', 'status', 'options', 'dashboard', 'serve', 'request_approval', 'check', 'backlog_list', 'backlog_add', 'authorize', 'deauthorize', 'hold', 'release', 'scout', 'inbox_list', 'promote', 'discard'].includes(name), idempotentHint: ['inspect', 'status', 'options', 'check', 'backlog_list', 'inbox_list'].includes(name), openWorldHint: ['doctor', 'activate', 'start', 'run', 'resume', 'tick', 'scout', 'chat_next', 'chat_submit'].includes(name) } })) };
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
