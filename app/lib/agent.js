// Agent loop: the model sees the tools, decides which to call, we run them and feed results back,
// until it answers in plain text (or hits the step limit).
const merchant = require('../data/merchant.json');
const llm = require('./llm');
const tools = require('./tools');
const store = require('./store');
const quota = require('./quota');
const { AGENT, PLANS } = require('./config');
const { QuotaError } = require('./generate');
const performance = require('./performance');

const conversations = new Map(); // user_id -> messages (in memory; restarts clear it)

const PAGES = { home: 'Home (this period\'s results)', write: 'Write (the post wizard)', results: 'Results (all posts)', plan: 'Plan and billing' };

function snapshot(user) {
  const s = performance.summary(user, { days: 30 });
  if (s.locked) {
    const p = s.latest_post;
    return p ? `Free plan: only the latest post is visible (${p.product}, ${p.channel}, ${p.date}: ${p.clicks} clicks, ${p.orders} orders). Totals and rankings are hidden.`
      : 'Free plan: no posts yet.';
  }
  const t = s.totals;
  const ch = s.change_pct.orders == null ? '' : ` (${s.change_pct.orders >= 0 ? '+' : ''}${s.change_pct.orders}% orders vs the 30 days before)`;
  return [`Last 30 days: ${t.posts} posts, ${t.clicks} clicks, ${t.orders} orders, $${t.revenue}${ch}.`, ...s.findings.map((f) => `- ${f}`)].join('\n');
}

function systemPrompt(user, { page, planAtStart } = {}) {
  const plan = PLANS[user.plan];
  const m = merchant.merchant;
  const credits = quota.status(user).left;
  const catalog = merchant.products.map((p) =>
    `- ${p.id} ${p.name}: $${p.price}, ${p.stock} in stock, rated ${p.rating} (${p.review_count} reviews). ${p.selling_points.join('; ')}.`);
  return [
    '# Who you are',
    `You are Lumi, the marketing assistant inside ${m.name}'s dashboard. ${m.name} sells ${m.category.toLowerCase()} on ${m.store} and posts on Instagram and TikTok. You talk to the owner, ${m.owner}, who is busy and not a marketer.`,
    'Your goal: help them see which posts bring orders, and get the next good post out with as little effort as possible.',
    '',
    '# What you know right now',
    `Today is ${new Date(performance.asOf()).toISOString().slice(0, 10)}. Plan: ${plan.name}. Credits left this month: ${credits} (writing a post costs 1).`,
    page && PAGES[page] ? `They are looking at: ${PAGES[page]}.` : null,
    planAtStart && planAtStart !== user.plan
      ? `The plan changed from ${PLANS[planAtStart].name} to ${plan.name} during this chat. Earlier answers were limited by the old plan: call tools again instead of repeating them.`
      : null,
    'Products (use these ids in tools):',
    ...catalog,
    'Results snapshot:',
    snapshot(user),
    '',
    '# How to decide',
    '- Questions about results ("how am I doing", "what works", "which post"): call get_results_summary, or get_post for one post.',
    '- Questions about products (price, stock, what it is): answer from the product list above, no tool needed.',
    '- "What do customers say" or before quoting a customer: call find_reviews.',
    '- Any request to write a post: call propose_post with one product, channel and angle. Pick them from the results (best angle, best channel, best-earning product that is in stock) unless the merchant named them. If results matter for the choice and you have not seen them this chat, call get_results_summary first. Call propose_post in the same turn; never end a writing turn without it, and never say a card is shown unless you called propose_post. You cannot write the post yourself: Lumi writes it when the merchant presses the button on the card, and typing "yes" does not press it.',
    '- Only call propose_post when they ask for a post or what to post next. After answering other questions, name the next step in words.',
    '- Changes to a post already written ("shorter", "warmer", "mention gift wrap"): call revise_post. It is free.',
    '- A link for the bio, a story, an email or an ad: call create_tracked_link.',
    '- Instagram and TikTok captions cannot hold clickable links. The discount code in the caption tracks the sale; the link goes in the bio or a story sticker.',
    '',
    '# How to answer',
    '- Lead with the answer and one number. Then at most 3 short points. End with one next step they can take in Lumi, said as a suggestion, not a question.',
    '- You cannot post for them. They post on Instagram or TikTok themselves, then press "I\'ve posted it" on the Write page so Lumi can track it.',
    '- Plain words, short sentences, no tables, no headings. Under 120 words unless they ask for more.',
    '- The merchant sees every card (results, proposal, post versions), so do not repeat captions or lists that are on a card.',
    '- Reply in the language of the merchant\'s own typed messages, including any short note before a tool call. "Yes, write it." is sent by the proposal button and does not change the language.',
    '- After the button wrote a post (the message says so), say in one or two sentences which version you would start with and why. The versions are on a card.',
    '',
    '# Grounding',
    '- Every price, stock level, review quote and result number must come from the product list above or a tool result. Never invent discounts, awards, reviews or numbers.',
    '- Quote totals, averages and percentages exactly as given. Do not add up, divide or round numbers yourself.',
    '',
    '# Plan and credits',
    '- If a tool returns quota_exceeded, say plainly they are out of credits this month and Pro gives 300 a month. Do not retry.',
    '- On the Free plan, results beyond the latest post are hidden. Say what you can see and that Pro shows the full picture. Do not guess hidden numbers. You can still propose posts, using the product list.',
    '',
    '# Examples',
    'User: "write me a post"',
    'You: call get_results_summary if you have not yet, then propose_post (e.g. the best-earning in-stock product, the best angle and channel), then one sentence such as "Behind-the-scenes posts sell best for you, so here is one for the Gift Box on TikTok. Press the button if it looks right."',
    'User: "how did last month go?"',
    'You: call get_results_summary, then "<orders> orders and $<revenue> from <posts> posts, <change> on the month before. <best angle> posts did best... Next: write one more of those." (numbers from the tool, never from this example)',
  ].filter((line) => line != null).join('\n');
}

// Keep the last N messages but never start in the middle of a tool exchange.
function trimmed(history) {
  let start = Math.max(0, history.length - AGENT.historyMessages);
  while (start < history.length && history[start].role !== 'user') start += 1;
  return history.slice(start);
}

function parseArgs(raw) {
  if (!raw || !raw.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

const clip = (obj) => {
  const s = JSON.stringify(obj);
  return s.length > 12000 ? s.slice(0, 12000) + '…(truncated)' : s;
};


// Runs one tool call, reports it to the browser, and returns what goes back to the model.
async function runTool(call, user, emit, { byServer = false } = {}) {
  const args = parseArgs(call.arguments);
  emit({ type: 'tool_start', id: call.id, name: call.name, args: args.ok ? args.value : call.arguments });
  const started = Date.now();
  let payload;
  let ok = true;
  let card = null;
  let error = null;
  let stopAfter = false;
  if (!args.ok) {
    ok = false;
    error = 'bad_arguments';
    payload = { error: 'Arguments were not valid JSON. Call the tool again with valid JSON arguments.' };
  } else {
    try {
      const out = await tools.run(call.name, args.value, { user, byServer });
      payload = out.result;
      card = out.card;
      stopAfter = Boolean(out.stopAfter);
    } catch (err) {
      ok = false;
      if (err instanceof QuotaError) {
        error = 'quota_exceeded';
        payload = user.plan === 'pro'
          ? { error: 'quota_exceeded', message: `No credits left this month (${err.status.used}/${err.status.limit}).`, options: 'A top-up adds 200 credits for $9 on the Plan page. Credits reset on the 1st.' }
          : { error: 'quota_exceeded', message: `No credits left this month (${err.status.used}/${err.status.limit}).`, upgrade: 'Pro: $29/month, 300 credits' };
        emit({ type: 'paywall', reason: 'quota', quota: quota.status(user) });
      } else {
        error = err.code || 'tool_error';
        payload = { error: err.message };
      }
    }
  }
  store.track('agent_tool_called', { user_id: user.id, tool: call.name, ok, error, latency_ms: Date.now() - started });
  emit({ type: 'tool_end', id: call.id, name: call.name, ok, error, result: payload, card });
  return { payload, ok, stopAfter };
}

const plansAtStart = new Map(); // user_id -> plan when the chat started

// context.pressed = the proposal whose "Write 3 versions" button was pressed. The server writes that post
// itself, so one press spends at most one credit whatever the model does, and nothing typed can spend one.
async function chat(user, text, emit, context = {}) {
  const history = conversations.get(user.id) || [];
  if (!history.length) plansAtStart.set(user.id, user.plan);
  context = { ...context, planAtStart: plansAtStart.get(user.id) };
  const turnStart = history.length;
  let stopNext = false;
  let wrote = null;

  try {
    if (context.pressed) {
      const call = { id: `btn_${context.pressed}`, name: 'generate_post', arguments: JSON.stringify({ proposal_id: context.pressed }) };
      const r = await runTool(call, user, emit, { byServer: true });
      emit({ type: 'quota', quota: quota.status(user) });
      wrote = r;
      // Sent as part of the user's message rather than as a tool call, so every vendor accepts it
      // (thinking models reject a tool call they did not make themselves).
      history.push({ role: 'user', content: `${text}\n\n[I pressed "Write 3 versions". Lumi's result: ${clip(r.payload)}]` });
      stopNext = true;
    } else {
      history.push({ role: 'user', content: text });
    }

    for (let step = 0; step < AGENT.maxSteps; step += 1) {
      let turn;
      try {
        turn = await llm.streamTurn({
          messages: [{ role: 'system', content: systemPrompt(user, context) }, ...trimmed(history)],
          // After a proposal or a button press there is nothing left to do but say a sentence.
          tools: stopNext ? undefined : tools.definitions,
          plan: user.plan,
          onText: (delta) => emit({ type: 'text', delta }),
        });
      } catch (err) {
        // The post is already written and on screen; a failed sentence about it should not look like a failure.
        if (wrote && step === 0 && err.code !== 'interrupted') {
          const note = wrote.ok ? 'Here are 3 versions. Pick one to use it, or tell me what to change.' : 'That did not work, and no credit was used. Press the button again to retry.';
          emit({ type: 'text', delta: note });
          history.push({ role: 'assistant', content: note });
          conversations.set(user.id, history);
          return { steps: 1 };
        }
        throw err;
      }
      const { content, toolCalls, reasoning } = turn;

      if (!toolCalls.length) {
        history.push({ role: 'assistant', content });
        conversations.set(user.id, history);
        return { steps: step + 1 };
      }

      history.push({
        role: 'assistant',
        content: content || '',
        // Thinking models need their reasoning back on the message that made the tool call.
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
      });

      for (const call of toolCalls) {
        const r = await runTool(call, user, emit);
        if (r.stopAfter) stopNext = true;
        history.push({ role: 'tool', tool_call_id: call.id, content: clip(r.payload) });
      }
      emit({ type: 'quota', quota: quota.status(user) });
    }

    const note = `\n\nI stopped after ${AGENT.maxSteps} steps to avoid going in circles. Try asking in a more specific way.`;
    emit({ type: 'text', delta: note });
    history.push({ role: 'assistant', content: note.trim() });
    conversations.set(user.id, history);
    return { steps: AGENT.maxSteps, stopped: true };
  } catch (err) {
    // Roll the failed turn back so a dangling tool call cannot break the next turn.
    history.splice(turnStart);
    conversations.set(user.id, history);
    throw err;
  }
}

function reset(user) {
  conversations.delete(user.id);
  plansAtStart.delete(user.id);
}

module.exports = { chat, reset, systemPrompt };
