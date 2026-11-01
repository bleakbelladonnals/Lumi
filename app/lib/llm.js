// OpenAI-compatible client for DeepSeek, Kimi (Moonshot), GLM, Qwen or any endpoint with tool calling.
// "OpenAI-compatible" is looser than it sounds, so this file absorbs the differences we know about:
//  - streamed tool calls: some vendors repeat the function name in every chunk, leave out `index`,
//    or send the whole call in one chunk. stitcher() handles all three.
//  - thinking models (Kimi K2 thinking, DeepSeek with thinking on) return `reasoning_content` and
//    reject the next request unless it is sent back on the assistant message that made the tool call.
//  - some models only accept a fixed temperature, and some endpoints reject `tool_choice`.
//    A 400 that names the parameter is retried once without it, and remembered for this process.
//  - some models put <think>...</think> or ```json fences around JSON. extractJson() strips them.
// Check a new vendor before switching: npm run check-model
const OpenAI = require('openai');
const { AGENT } = require('./config');

const configured = () => Boolean(process.env.LLM_API_KEY && process.env.LLM_BASE_URL && process.env.LLM_MODEL);

let client = null;
function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.LLM_API_KEY,
      baseURL: process.env.LLM_BASE_URL,
      timeout: AGENT.timeoutMs,
      maxRetries: 0, // retries are handled below so we can tell the user what happened
    });
  }
  return client;
}

// Free users get the cheaper model when one is configured (A3: lower-cost model for Free).
function modelFor(plan) {
  if (plan === 'free' && process.env.LLM_MODEL_FREE) return process.env.LLM_MODEL_FREE;
  return process.env.LLM_MODEL;
}

// Parameters a vendor turned out not to accept. Filled in at runtime from 400 errors.
const dropped = new Set();

// LLM_TEMPERATURE=default leaves temperature out (for models that only accept their own value).
function temperatureFor(fallback) {
  if (dropped.has('temperature')) return undefined;
  const raw = process.env.LLM_TEMPERATURE;
  if (raw === 'default' || raw === 'none') return undefined;
  const n = Number(raw);
  return raw && Number.isFinite(n) ? n : fallback;
}

// LLM_EXTRA_BODY: vendor-specific fields as JSON, e.g. {"thinking":{"type":"disabled"}}
function extraBody() {
  if (!process.env.LLM_EXTRA_BODY) return {};
  try { return JSON.parse(process.env.LLM_EXTRA_BODY); } catch { return {}; }
}

function buildRequest({ model, messages, tools, temperature, stream }) {
  const req = { model, messages, stream: Boolean(stream), ...extraBody() };
  if (tools) {
    req.tools = tools;
    if (!dropped.has('tool_choice')) req.tool_choice = 'auto';
  }
  const t = temperatureFor(temperature);
  if (t !== undefined) req.temperature = t;
  return req;
}

class LlmError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

// The vendor's own words, so a 400 says what is wrong instead of "something went wrong".
const providerMessage = (err) => String(err?.error?.message || err?.message || '').replace(/^\d{3}\s*/, '').slice(0, 300);

function classify(err) {
  if (err instanceof LlmError) return err;
  const status = err?.status;
  if (status === 401 || status === 403) return new LlmError('auth', 'The model API key was rejected. Check LLM_API_KEY in .env.', err);
  if (status === 429) return new LlmError('rate_limit', 'The model provider is rate limiting us. Try again in a minute.', err);
  if (status === 404) return new LlmError('model', 'Model not found. Check LLM_MODEL and LLM_BASE_URL in .env.', err);
  if (status === 400 || status === 422) {
    return new LlmError('bad_request', `The model provider rejected the request: ${providerMessage(err)}. Run "npm run check-model" to see which setting it needs.`, err);
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError || /timed? ?out/i.test(err?.message || '')) {
    return new LlmError('timeout', 'The model took too long to answer. Try again.', err);
  }
  if (status >= 500) return new LlmError('provider', 'The model provider had an error. Try again.', err);
  if (err instanceof OpenAI.APIConnectionError) return new LlmError('network', 'Could not reach the model provider. Check LLM_BASE_URL and your network.', err);
  return new LlmError('unknown', `Something went wrong talking to the model: ${providerMessage(err)}`, err);
}

// A 400 that names a parameter we can live without: drop it and try once more.
function droppable(err) {
  if (err?.status !== 400 && err?.status !== 422) return null;
  const msg = providerMessage(err).toLowerCase();
  if (msg.includes('temperature') && !dropped.has('temperature')) return 'temperature';
  if (msg.includes('tool_choice') && !dropped.has('tool_choice')) return 'tool_choice';
  return null;
}

const retryable = (e) => ['rate_limit', 'timeout', 'provider', 'network'].includes(e.code);

async function withRetry(fn) {
  let adapted = 0;
  let retried = false;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const param = adapted < 2 && !(err instanceof LlmError) ? droppable(err) : null;
      if (param) {
        dropped.add(param);
        adapted += 1;
        console.warn(`[llm] provider rejected "${param}", retrying without it`);
        continue;
      }
      const e = classify(err);
      if (retried || !retryable(e)) throw e;
      retried = true;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

// Collects streamed tool-call fragments into whole calls. Vendors differ:
//  OpenAI/DeepSeek: name once, then argument pieces, each chunk has `index`.
//  Some: the name repeated in every chunk (plain concatenation gives "get_postget_post").
//  Some: no `index`, matched by `id`, or by "the call in progress" when neither is sent.
//  Some: the full arguments string resent each chunk, or arguments as an object.
function stitcher() {
  const calls = [];
  return {
    add(tc) {
      let slot = null;
      if (Number.isInteger(tc.index)) slot = calls[tc.index] ||= { id: '', name: '', arguments: '' };
      else if (tc.id) slot = calls.find((c) => c && c.id === tc.id);
      if (!slot) {
        // An id we have not seen starts a new call; no id continues the call in progress.
        const last = calls.filter(Boolean).at(-1);
        if (!tc.id && last) slot = last;
        else { slot = { id: '', name: '', arguments: '' }; calls.push(slot); }
      }
      if (tc.id && !slot.id) slot.id = tc.id;
      const name = tc.function?.name;
      if (name && !slot.name.endsWith(name)) slot.name = slot.name && !name.startsWith(slot.name) ? slot.name + name : name;
      let args = tc.function?.arguments;
      if (args && typeof args !== 'string') args = JSON.stringify(args);
      if (args) {
        if (slot.arguments && args.startsWith(slot.arguments) && looksComplete(args)) slot.arguments = args;
        else if (!(looksComplete(slot.arguments) && args === slot.arguments)) slot.arguments += args;
      }
    },
    result: () => calls.filter((c) => c && c.name).map((c, i) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` })),
  };
}
const looksComplete = (s) => { if (!s) return false; try { JSON.parse(s); return true; } catch { return false; } };

// Streams one assistant turn. Calls onText(delta) as text arrives and returns
// { content, toolCalls, reasoning } once the turn ends.
async function streamTurn({ messages, tools, plan, onText }) {
  return withRetry(async () => {
    let content = '';
    let reasoning = '';
    const stitch = stitcher();
    let started = false;
    try {
      const stream = await getClient().chat.completions.create(buildRequest({ model: modelFor(plan), messages, tools, temperature: 0.4, stream: true }));
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta || choice?.message; // a few vendors send `message` in the last chunk
        if (!delta) continue;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        if (delta.content) {
          started = true;
          content += delta.content;
          onText?.(delta.content);
        }
        for (const tc of delta.tool_calls || []) stitch.add(tc);
      }
    } catch (err) {
      // Once text has reached the user a retry would duplicate it, so fail instead.
      if (started) { const e = classify(err); e.code = 'interrupted'; throw e; }
      throw err;
    }
    return { content, toolCalls: stitch.result(), reasoning };
  });
}

// Non-streaming call that must return JSON. Used inside the generate_post tool.
async function completeJson({ messages, plan }) {
  return withRetry(async () => {
    const res = await getClient().chat.completions.create(buildRequest({ model: modelFor(plan), messages, temperature: 0.8 }));
    return res.choices?.[0]?.message?.content || '';
  });
}

// Pulls the JSON object out of a model answer that may carry <think> blocks or ``` fences.
function extractJson(text) {
  const clean = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

// For tests: forget which parameters were dropped.
const _reset = () => { dropped.clear(); client = null; };

module.exports = { configured, streamTurn, completeJson, extractJson, modelFor, LlmError, stitcher, dropped, _reset };
