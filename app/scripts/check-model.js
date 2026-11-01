// Checks that the model in app/.env can do what Lumi needs before you switch to it:
//   npm run check-model
// 1. stream plain text   2. call a tool with valid JSON arguments   3. take the tool result back and answer
// 4. return JSON for post writing. Prints what to change in .env when a step fails.
require('../lib/env').load();
const llm = require('../lib/llm');
const tools = require('../lib/tools');

const ok = (s) => console.log(`  PASS  ${s}`);
const bad = (s, hint) => { console.log(`  FAIL  ${s}`); if (hint) console.log(`        ${hint}`); };

async function main() {
  if (!llm.configured()) {
    console.log('Set LLM_API_KEY, LLM_BASE_URL and LLM_MODEL in app/.env first.');
    process.exit(1);
  }
  console.log(`Checking ${process.env.LLM_MODEL} at ${process.env.LLM_BASE_URL}\n`);
  let failed = 0;
  const system = { role: 'system', content: 'You are a shop assistant. Use the tools to answer questions about results.' };

  // 1. Plain text
  try {
    const t = await llm.streamTurn({ messages: [system, { role: 'user', content: 'Say hello in five words.' }] });
    if (t.content.trim()) ok(`streams text ("${t.content.trim().slice(0, 40)}")`);
    else { failed += 1; bad('streams text: the answer was empty', 'Thinking models sometimes put everything in reasoning. Try a non-thinking model, or LLM_EXTRA_BODY to turn thinking off.'); }
  } catch (err) {
    failed += 1;
    bad(`streams text: ${err.message}`, 'Check LLM_BASE_URL (it usually ends in /v1) and LLM_MODEL.');
    return finish(failed);
  }

  // 2. Tool call
  const messages = [system, { role: 'user', content: 'Which of my posts brought the most orders in the last 30 days?' }];
  let turn;
  try {
    turn = await llm.streamTurn({ messages, tools: tools.definitions });
  } catch (err) {
    failed += 1;
    bad(`tool call request: ${err.message}`, 'The endpoint may not support tools for this model. Pick a model the vendor lists as supporting function calling.');
    return finish(failed);
  }
  const call = turn.toolCalls[0];
  const names = new Set(tools.definitions.map((d) => d.function.name));
  if (!call) {
    failed += 1;
    const leaked = /tool_call|<\|tool|"name"\s*:/.test(turn.content);
    bad('calls a tool: the model answered in text instead', leaked
      ? 'The tool call came back as text. This endpoint does not parse tool calls for this model; use another model or endpoint.'
      : 'The model chose not to use tools. Lumi depends on this; try a stronger model.');
    return finish(failed);
  }
  let args = null;
  try { args = JSON.parse(call.arguments || '{}'); } catch { /* reported below */ }
  if (names.has(call.name) && args) ok(`calls a tool (${call.name} ${JSON.stringify(args)})`);
  else { failed += 1; bad(`calls a tool: got name "${call.name}", arguments ${call.arguments}`, 'The streamed tool call was not readable. Please report this vendor so lib/llm.js stitcher() can learn its format.'); }
  if (turn.reasoning) ok(`thinking model: reasoning_content is captured and sent back (${turn.reasoning.length} chars)`);

  // 3. Round trip with the tool result
  messages.push({
    role: 'assistant',
    content: turn.content || '',
    ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
    tool_calls: turn.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
  });
  for (const c of turn.toolCalls) {
    messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ top_post: { product: 'Speckled Mug', orders: 9, revenue: 342 } }) });
  }
  try {
    const t = await llm.streamTurn({ messages, tools: tools.definitions });
    if (t.content.trim()) ok(`answers from the tool result ("${t.content.trim().slice(0, 50)}…")`);
    else if (t.toolCalls.length) ok('takes the tool result back (it asked for another tool, which is allowed)');
    else { failed += 1; bad('answers from the tool result: empty answer'); }
  } catch (err) {
    failed += 1;
    bad(`answers from the tool result: ${err.message}`, /reasoning/i.test(err.message) ? 'This thinking model wants its reasoning back; lib/llm.js sends reasoning_content, so check the vendor docs for the field name.' : null);
  }

  // 4. JSON for post writing
  try {
    const text = await llm.completeJson({ messages: [{ role: 'system', content: 'Return JSON only.' }, { role: 'user', content: 'Return {"variants":[{"caption":"hi"}]}' }] });
    if (llm.extractJson(text)?.variants) ok('returns JSON for post writing');
    else { failed += 1; bad(`returns JSON: could not read "${text.slice(0, 80)}"`); }
  } catch (err) {
    failed += 1;
    bad(`returns JSON: ${err.message}`);
  }
  finish(failed);
}

function finish(failed) {
  if (llm.dropped.size) {
    console.log(`\nThis vendor rejected: ${[...llm.dropped].join(', ')}. Lumi leaves ${llm.dropped.size > 1 ? 'them' : 'it'} out automatically after the first try.`);
    if (llm.dropped.has('temperature')) console.log('To skip that first failed try, add LLM_TEMPERATURE=default to .env.');
  }
  console.log(failed ? `\n${failed} check(s) failed. Lumi will not work reliably with this model.` : '\nAll checks passed. Lumi can use this model.');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
