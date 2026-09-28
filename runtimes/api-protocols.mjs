// Wire formats for the two managed API protocols. Each adapter only builds a
// request body and reads a response; it never decides anything. The runtime
// sends the request with Node's own fetch and enforces model, budget and tool
// policy on what comes back.
//
// OpenAI Responses (openai, local, mock providers): POST {base}/responses,
// stateless (store:false). Every output item goes back as input on the next
// turn, followed by one function_call_output per function_call.
//
// Anthropic Messages (anthropic provider): POST {base}/messages. The assistant
// content goes back unchanged, followed by one user turn of tool_result blocks.

export class ProtocolError extends Error {}

const text = (value) => (typeof value === 'string' ? value : '');

function parseArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}

function countedTokens(usage, extra = []) {
  if (!usage) return null;
  const counts = [usage.input_tokens, usage.output_tokens, ...extra.map(key => usage[key] ?? 0)];
  if (counts.some(value => !Number.isSafeInteger(value) || value < 0)) return null;
  const total = counts.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

export const openaiResponses = {
  name: 'openai-responses',
  path: '/responses',
  headers(credential) {
    return credential ? { authorization: `Bearer ${credential}` } : {};
  },
  start({ system, prompt }) {
    return { system, input: [{ role: 'user', content: prompt }] };
  },
  body(conversation, { model, tools, maxOutputTokens }) {
    const body = {
      model, instructions: conversation.system, input: conversation.input,
      max_output_tokens: maxOutputTokens, store: false, include: ['reasoning.encrypted_content'],
    };
    if (tools.length) {
      body.tools = tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: true }));
      body.tool_choice = 'auto';
    }
    return body;
  },
  parse(response) {
    if (!response || typeof response !== 'object' || !Array.isArray(response.output)) throw new ProtocolError('the Responses reply has no output array');
    const calls = []; const texts = [];
    for (const item of response.output) {
      if (item?.type === 'function_call') calls.push({ id: text(item.call_id), name: text(item.name), args: parseArguments(item.arguments) });
      else if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) if (part?.type === 'output_text') texts.push(text(part.text));
      }
    }
    const usage = response.usage;
    const tokens = countedTokens(usage);
    let stop;
    if (response.status === 'incomplete') stop = 'truncated';
    else if (response.status === 'failed' || response.error) stop = 'failed';
    else if (calls.length) stop = 'tool';
    else if (response.status === 'completed') stop = 'end';
    else stop = 'failed';
    return { model: typeof response.model === 'string' ? response.model : null, tokens, calls, text: texts.join('\n'), stop };
  },
  continue(conversation, response, parsed, results) {
    conversation.input.push(...response.output);
    for (const [index, call] of parsed.calls.entries()) conversation.input.push({ type: 'function_call_output', call_id: call.id, output: results[index].output });
  },
};

export const anthropicMessages = {
  name: 'anthropic-messages',
  path: '/messages',
  headers(credential) {
    return { 'anthropic-version': '2023-06-01', ...(credential ? { 'x-api-key': credential } : {}) };
  },
  start({ system, prompt }) {
    return { system, messages: [{ role: 'user', content: prompt }] };
  },
  body(conversation, { model, tools, maxOutputTokens }) {
    const body = { model, max_tokens: maxOutputTokens, system: conversation.system, messages: conversation.messages };
    if (tools.length) body.tools = tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    return body;
  },
  parse(response) {
    if (!response || typeof response !== 'object' || !Array.isArray(response.content)) throw new ProtocolError('the Messages reply has no content array');
    const calls = []; const texts = [];
    for (const block of response.content) {
      if (block?.type === 'tool_use') calls.push({ id: text(block.id), name: text(block.name), args: parseArguments(block.input) });
      else if (block?.type === 'text') texts.push(text(block.text));
    }
    const usage = response.usage;
    const tokens = countedTokens(usage, ['cache_creation_input_tokens', 'cache_read_input_tokens']);
    const stop = { tool_use: 'tool', end_turn: 'end', stop_sequence: 'end', max_tokens: 'truncated', refusal: 'refused' }[response.stop_reason] || 'failed';
    return { model: typeof response.model === 'string' ? response.model : null, tokens, calls, text: texts.join('\n'), stop: stop === 'tool' && !calls.length ? 'failed' : stop };
  },
  continue(conversation, response, parsed, results) {
    conversation.messages.push({ role: 'assistant', content: response.content });
    conversation.messages.push({ role: 'user', content: parsed.calls.map((call, index) => ({ type: 'tool_result', tool_use_id: call.id, content: results[index].output, ...(results[index].ok ? {} : { is_error: true }) })) });
  },
};

export function protocolFor(provider) {
  if (provider === 'anthropic') return anthropicMessages;
  if (['openai', 'local', 'mock'].includes(provider)) return openaiResponses;
  throw new ProtocolError(`no managed API protocol for provider ${provider}`);
}
