// OpenAI-compatible client. Works with DeepSeek, Kimi, GLM, Qwen or any endpoint that supports tool calling.
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

class LlmError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

function classify(err) {
  const status = err?.status;
  if (status === 401 || status === 403) return new LlmError('auth', 'The model API key was rejected. Check LLM_API_KEY in .env.', err);
  if (status === 429) return new LlmError('rate_limit', 'The model provider is rate limiting us. Try again in a minute.', err);
  if (status === 404) return new LlmError('model', 'Model not found. Check LLM_MODEL and LLM_BASE_URL in .env.', err);
  if (err instanceof OpenAI.APIConnectionTimeoutError || /timed? ?out/i.test(err?.message || '')) {
    return new LlmError('timeout', 'The model took too long to answer. Try again.', err);
  }
  if (status >= 500) return new LlmError('provider', 'The model provider had an error. Try again.', err);
  if (err instanceof OpenAI.APIConnectionError) return new LlmError('network', 'Could not reach the model provider. Check LLM_BASE_URL and your network.', err);
  return new LlmError('unknown', 'Something went wrong talking to the model.', err);
}

const retryable = (e) => ['rate_limit', 'timeout', 'provider', 'network'].includes(e.code);

async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    const e = err instanceof LlmError ? err : classify(err);
    if (!retryable(e)) throw e;
    await new Promise((r) => setTimeout(r, 800));
    try {
      return await fn();
    } catch (err2) {
      throw err2 instanceof LlmError ? err2 : classify(err2);
    }
  }
}

// Streams one assistant turn. Calls onText(delta) as text arrives and returns
// { content, toolCalls } once the turn ends. Tool call fragments are stitched by index.
async function streamTurn({ messages, tools, plan, onText }) {
  return withRetry(async () => {
    let content = '';
    const calls = [];
    let started = false;
    try {
      const stream = await getClient().chat.completions.create({
        model: modelFor(plan),
        messages,
        ...(tools ? { tools, tool_choice: 'auto' } : {}),
        temperature: 0.4,
        stream: true,
      });
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          started = true;
          content += delta.content;
          onText?.(delta.content);
        }
        for (const tc of delta.tool_calls || []) {
          const slot = (calls[tc.index ?? calls.length] ||= { id: '', name: '', arguments: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.arguments += tc.function.arguments;
        }
      }
    } catch (err) {
      // Once text has reached the user a retry would duplicate it, so fail instead.
      const e = classify(err);
      if (started) e.code = 'interrupted';
      throw e;
    }
    const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
    return { content, toolCalls };
  });
}

// Non-streaming call that must return JSON. Used inside the generate_post tool.
async function completeJson({ messages, plan }) {
  return withRetry(async () => {
    const res = await getClient().chat.completions.create({
      model: modelFor(plan),
      messages,
      temperature: 0.8,
    });
    return res.choices?.[0]?.message?.content || '';
  });
}

module.exports = { configured, streamTurn, completeJson, modelFor, LlmError };
