// TEST DOUBLE ONLY. A fake OpenAI-compatible endpoint so `npm test` runs without an API key.
// It imitates a model choosing tools so the real agent loop, quota and events can be exercised.
// The app itself never routes by keywords; at runtime the real model decides.
const http = require('http');

const VARIANTS = { variants: [
  { label: 'Maker story', hook: 'Fresh from the kiln', caption: 'Fresh from the kiln. {LINK} Code {CODE} gets 10% off.', hashtags: ['#ceramics'] },
  { label: 'Customer voice', hook: 'Warm coffee', caption: 'Coffee still warm at 9am. https://example.com/x {CODE}', hashtags: ['#mug'] },
  { label: 'Gift', hook: 'Gift idea', caption: 'For the person who wants nothing. {LINK} {CODE}', hashtags: ['#gift'] },
] };

function decide(body) {
  const msgs = body.messages || [];
  const last = msgs[msgs.length - 1];
  const system = String(msgs[0]?.content || '');
  // Inner, non-streaming calls from generate_post and revise_post: return JSON.
  if (!body.stream) {
    if (system.includes('You edit social media captions')) return { content: JSON.stringify({ caption: 'Shorter now. {CODE}', hashtags: ['#short'] }) };
    return { content: JSON.stringify(VARIANTS) };
  }
  // The agent loop drops tools after a proposal: the model may only write a sentence.
  if (!body.tools) return { content: 'Here is my suggestion. Press the button if it looks right.' };
  if (last.role === 'tool') return { content: 'Done. Behind-the-scenes posts sell best for you.' };
  const accepted = system.includes('ACCEPTED PROPOSALS') && system.match(/- (prop_[a-f0-9]+):/);
  if (accepted) return { tool: { name: 'generate_post', arguments: JSON.stringify({ proposal_id: accepted[1] }) } };
  const text = String(last.content || '').toLowerCase();
  const forced = text.match(/force-generate (prop_[a-f0-9]+)/);
  if (forced) return { tool: { name: 'generate_post', arguments: JSON.stringify({ proposal_id: forced[1] }) } };
  const revise = text.match(/shorter (post_[a-f0-9]+)/);
  if (revise) return { tool: { name: 'revise_post', arguments: JSON.stringify({ post_id: revise[1], variant: 2, instruction: 'shorter' }) } };
  if (text.includes('broken-json')) return { tool: { name: 'find_reviews', arguments: '{"product_id": ' } };
  if (text.includes('write') || text.includes('draft')) return { tool: { name: 'propose_post', arguments: JSON.stringify({ product_id: 'p1', channel: 'instagram', angle: 'behind_the_scenes', reason: 'Behind-the-scenes posts sell best.' }) } };
  if (text.includes('link')) return { tool: { name: 'create_tracked_link', arguments: JSON.stringify({ product_id: 'p3', channel: 'instagram', placement: 'bio' }) } };
  if (text.includes('best') || text.includes('worked') || text.includes('orders')) return { tool: { name: 'get_results_summary', arguments: JSON.stringify({ days: 30 }) } };
  return { content: 'Hello from the stub model.' };
}

function start(port = 0) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
      const body = JSON.parse(raw || '{}');
      const out = decide(body);
      if (!body.stream) {
        const message = out.tool
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: out.tool }] }
          : { role: 'assistant', content: out.content };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'stub', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: out.tool ? 'tool_calls' : 'stop' }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (out.tool) {
        const args = out.tool.arguments;
        send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: out.tool.name, arguments: '' } }] });
        // Split arguments across chunks the way real providers do.
        const mid = Math.floor(args.length / 2);
        send({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, mid) } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }] });
        send({}, 'tool_calls');
      } else {
        for (const word of out.content.split(/(?<= )/)) send({ content: word });
        send({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { start };
if (require.main === module) start(Number(process.env.STUB_PORT) || 4010).then((s) => console.log('stub LLM on', s.address().port));
