// Agent evaluation. Runs each case in eval/cases.json against the configured model and checks:
//   1. tool choice: required tools were called, forbidden ones were not (per turn in multi-turn cases)
//   2. credit safety: no credit is spent unless the merchant pressed the proposal button (must be 100%)
//   3. grounding: every $ amount in the answer appears in tool results, the prompt context or the price list
//   4. format: no tables, short answers
//   5. platform: Instagram and TikTok captions carry the discount code and no URL
//   6. language: replies in Chinese when asked in Chinese
// Usage: npm run eval            (uses app/.env)
//        npm run eval -- --only perf-top-post,flow-accept-edit
require('../lib/env').load();
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-eval-')), 'db.json');
const llm = require('../lib/llm');
const store = require('../lib/store');
const agent = require('../lib/agent');
const proposals = require('../lib/proposals');
const quota = require('../lib/quota');

if (!llm.configured()) {
  console.error('No model configured. Fill in LLM_API_KEY, LLM_BASE_URL and LLM_MODEL in app/.env first.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const only = argv.find((a) => a.startsWith('--only='))?.slice(7) || (onlyIdx >= 0 ? argv[onlyIdx + 1] : '') || '';
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'))
  .filter((c) => !only || only.split(',').includes(c.id));
const PRICE_LIST = [29, 24, 9, 19, 288, 10, 15, 20];

// Price thresholds such as "under $25" are framing, not facts, so they are not checked.
const dollars = (text) => [...text.replace(/\b(under|below|less than)[\s-]+\$\s?\d[\d,]*/gi, '').matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
const numbersIn = (obj) => new Set([...JSON.stringify(obj).matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])));

const words = (t) => (t.match(/[A-Za-z0-9$%.,']+|[\u4e00-\u9fff]/g) || []).length; // a Chinese character counts as a word
const hasTable = (t) => /^\s*\|.*\|\s*$/m.test(t);

async function runCase(c) {
  const user = { id: store.id('usr'), email: `${c.id}@eval.local`, plan: c.plan || 'pro', created_at: new Date().toISOString(), first_touch: null };
  store.db.users.push(user);
  const turns = c.turns || [{ say: c.prompt, expect_all: c.expect_all, expect_any: c.expect_any, forbid: c.forbid, expect_none: c.expect_none }];
  const notes = [];
  let toolPass = true;
  let groundPass = true;
  let formatPass = true;
  let platformPass = true;
  let langPass = true;
  let pressed = 0;
  const allCalls = [];
  const turnCalls = [];
  let lastText = '';
  const started = Date.now();
  const known = new Set(PRICE_LIST); // the model sees earlier tool results in its history, so numbers carry over between turns

  for (const [i, t] of turns.entries()) {
    const tag = turns.length > 1 ? `turn ${i + 1}: ` : '';
    if (t.press_button) {
      const open = store.db.proposals.filter((p) => p.user_id === user.id && p.status === 'proposed').at(-1);
      if (!open) { toolPass = false; notes.push(`${tag}no proposal to press`); break; }
      proposals.accept(user, open.id);
      pressed += 1;
    }
    for (const n of numbersIn(agent.systemPrompt(user))) known.add(n);
    const calls = [];
    let text = '';
    let error = null;
    try {
      await agent.chat(user, t.say, (ev) => {
        if (ev.type === 'text') text += ev.delta;
        if (ev.type === 'tool_start') { calls.push(ev.name); if (text && !text.endsWith('\n')) text += '\n\n'; }
        if (ev.type === 'tool_end') {
          for (const n of numbersIn(ev.result)) known.add(n);
          const post = ev.card?.type === 'post' ? ev.card.post : null;
          if (post && ['instagram', 'tiktok'].includes(post.channel)) {
            for (const v of post.variants) {
              if (/https?:\/\//.test(v.caption) || !v.caption.includes(post.discount_code)) { platformPass = false; notes.push(`${tag}caption breaks ${post.channel} rules`); break; }
            }
          }
        }
      });
    } catch (err) {
      error = `${err.code || 'error'}: ${err.message}`;
    }
    allCalls.push(...calls);
    turnCalls.push(calls);
    lastText = text;

    const missing = (t.expect_all || []).filter((x) => !calls.includes(x));
    const anyOk = !t.expect_any || t.expect_any.some((x) => calls.includes(x));
    const forbidden = (t.forbid || []).filter((x) => calls.includes(x));
    const noneOk = !t.expect_none || calls.length === 0;
    if (error || missing.length || !anyOk || forbidden.length || !noneOk) toolPass = false;
    if (error) notes.push(tag + error);
    if (missing.length) notes.push(`${tag}missing ${missing.join(', ')}`);
    if (!anyOk) notes.push(`${tag}expected one of ${t.expect_any.join(', ')}`);
    if (forbidden.length) notes.push(`${tag}called forbidden ${forbidden.join(', ')}`);
    if (!noneOk) notes.push(`${tag}expected no tool calls`);

    const unsupported = dollars(text).filter((d) => !known.has(d));
    if (unsupported.length) { groundPass = false; notes.push(`${tag}unsupported $ amounts: ${unsupported.join(', ')}`); }
    const n = words(text);
    if (hasTable(text)) { formatPass = false; notes.push(`${tag}table in answer`); }
    if (n > 170) { formatPass = false; notes.push(`${tag}answer too long (${n} words)`); }
    if (c.expect_language === 'zh' && t.say && /[\u4e00-\u9fff]/.test(t.say) && !/[\u4e00-\u9fff]/.test(text)) { langPass = false; notes.push(`${tag}wrong language`); }
  }

  // Credit safety: every credit spent must match a button press.
  const used = quota.status(user).used;
  const creditPass = used <= pressed;
  if (!creditPass) notes.push(`spent ${used} credit(s) with ${pressed} button press(es)`);

  return {
    id: c.id,
    prompt: turns.map((t) => (t.press_button ? '[button] ' : '') + t.say).join(' / '),
    tools_called: allCalls,
    turn_tools: turnCalls,
    tool_choice: toolPass,
    credit_safe: creditPass,
    grounded: groundPass,
    format: formatPass,
    platform: platformPass,
    language: langPass,
    pass: toolPass && creditPass && groundPass && formatPass && platformPass && langPass,
    notes: notes.join('; '),
    latency_ms: Date.now() - started,
    turns: turns.length,
    answer: lastText.slice(0, 500),
  };
}

(async () => {
  console.log(`Running ${cases.length} cases on ${process.env.LLM_MODEL} (${process.env.LLM_BASE_URL})\n`);
  const rows = [];
  for (const c of cases) {
    const r = await runCase(c);
    rows.push(r);
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(22)} ${(r.turn_tools.map((t) => t.join(' > ') || '(no tools)').join(' | ')).padEnd(60)} ${String(r.latency_ms).padStart(6)} ms  ${r.notes}`);
  }
  const rate = (k) => Math.round((rows.filter((r) => r[k]).length / rows.length) * 100);
  // Questions (no writing involved) should need about one tool call; the design target is 1.5 or fewer.
  const qa = rows.filter((r) => r.turns === 1 && !r.tools_called.some((t) => ['propose_post', 'generate_post', 'revise_post'].includes(t)));
  const single = rows.filter((r) => r.turns === 1).map((r) => r.latency_ms).sort((a, b) => a - b);
  const summary = {
    model: process.env.LLM_MODEL,
    base_url: process.env.LLM_BASE_URL,
    run_at: new Date().toISOString(),
    cases: rows.length,
    pass_rate_pct: rate('pass'),
    tool_choice_pct: rate('tool_choice'),
    credit_safe_pct: rate('credit_safe'),
    grounded_pct: rate('grounded'),
    format_pct: rate('format'),
    platform_pct: rate('platform'),
    language_pct: rate('language'),
    avg_tool_calls_per_question: Math.round((qa.reduce((n, r) => n + r.tools_called.length, 0) / Math.max(1, qa.length)) * 10) / 10,
    median_latency_ms: single[Math.floor(single.length / 2)],
  };
  const line = `pass ${summary.pass_rate_pct}% · tool choice ${summary.tool_choice_pct}% · credit safety ${summary.credit_safe_pct}% · grounded ${summary.grounded_pct}% · format ${summary.format_pct}% · platform rules ${summary.platform_pct}% · language ${summary.language_pct}% · ${summary.avg_tool_calls_per_question} tool calls per question · median ${summary.median_latency_ms} ms per single-turn case`;
  console.log(`\n${line}`);

  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const slug = String(process.env.LLM_MODEL).replace(/[^a-z0-9.-]+/gi, '_');
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify({ summary, rows }, null, 2));
  const md = [
    `# Eval results: ${summary.model}`,
    '',
    `Run ${summary.run_at.slice(0, 16).replace('T', ' ')} UTC · ${summary.cases} cases · ${line}`,
    '',
    '| Case | Result | Tools called | Notes |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.id} | ${r.pass ? 'pass' : 'FAIL'} | ${r.turn_tools.map((t) => t.join(' → ') || '–').join(' ／ ')} | ${r.notes.replace(/\|/g, '/') || ''} |`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, `${slug}.md`), md);
  console.log(`Saved eval/results/${slug}.json and .md`);
  store.flush();
  process.exit(summary.pass_rate_pct === 100 ? 0 : 1);
})();
