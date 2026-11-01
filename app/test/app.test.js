// End-to-end tests against the real server, with a stub model. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let base;
let server;
let stub;

test.before(async () => {
  stub = await require('./stub-llm').start();
  process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-')), 'db.json');
  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
  process.env.LLM_MODEL = 'stub-model';
  const app = require('../server');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.BASE_URL = base;
});

test.after(() => { server.close(); stub.close(); });

function client() {
  let cookie = '';
  return async (p, { method = 'GET', body, headers = {}, redirect = 'follow' } = {}) => {
    const res = await fetch(base + p, {
      method,
      redirect,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) {
      const [kv] = c.split(';');
      const [k] = kv.split('=');
      cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; ');
    }
    return res;
  };
}

const events = async (name) => (await (await fetch(`${base}/api/admin/events?limit=500`)).json()).events.filter((e) => e.name === name);

async function signup(c, email, touch = { utm_source: 'tiktok', utm_medium: 'paid', utm_campaign: 'q4', ttclid: 'CLICK123' }) {
  const r = await c('/api/signup', { method: 'POST', body: { email, anonymous_id: 'anon_test', first_touch: touch, last_touch: touch } });
  assert.equal(r.status, 200);
  return (await r.json()).user;
}

async function chat(c, message) {
  const r = await c('/api/chat', { method: 'POST', body: { message } });
  const text = await r.text();
  return text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}

test('UTM captured at sign-up is carried on sign_up and subscription_started, and a postback is queued', async () => {
  const c = client();
  const user = await signup(c, 'utm@test.com');
  const su = (await events('sign_up')).find((e) => e.user_id === user.id);
  assert.equal(su.utm_source, 'tiktok');
  assert.equal(su.ttclid, 'CLICK123');

  const co = await (await c('/api/billing/checkout', { method: 'POST', body: { item: 'pro' } })).json();
  const paid = await c(`/api/billing/simulate-pay/${co.checkout.id}`, { method: 'POST' });
  assert.equal(paid.status, 200);
  const ss = (await events('subscription_started')).find((e) => e.user_id === user.id);
  assert.equal(ss.utm_source, 'tiktok');
  assert.equal(ss.ttclid, 'CLICK123');
  assert.equal(ss.price, 29);
  const metrics = await (await fetch(`${base}/api/admin/metrics`)).json();
  assert.ok(metrics.outbox.some((o) => o.payload.event_id === ss.event_id), 'postback uses the same event_id');
});

test('webhook rejects a bad signature and plan does not change', async () => {
  const r = await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': 'nope' }, body: '{"checkout_id":"x"}' });
  assert.equal(r.status, 400);
});

test('free quota is enforced on the server, even when calling the API directly', async () => {
  const c = client();
  await signup(c, 'quota@test.com', null);
  for (let i = 0; i < 10; i += 1) {
    const r = await c('/api/generate', { method: 'POST', body: { product_id: 'p1', channel: 'instagram', angle: 'behind_the_scenes' } });
    assert.equal(r.status, 200, `generation ${i + 1}`);
  }
  const r11 = await c('/api/generate', { method: 'POST', body: { product_id: 'p1', channel: 'instagram', angle: 'behind_the_scenes' } });
  assert.equal(r11.status, 402);
  const body = await r11.json();
  assert.equal(body.error, 'quota_exceeded');
  assert.equal(body.quota.left, 0);
});

test('concurrent requests cannot overspend the quota', async () => {
  const c = client();
  await signup(c, 'race@test.com', null);
  await c('/api/demo/use-credits', { method: 'POST', body: { leave: 3 } });
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    c('/api/generate', { method: 'POST', body: { product_id: 'p2', channel: 'tiktok', angle: 'gift_idea' } }).then((r) => r.status)));
  assert.equal(results.filter((s) => s === 200).length, 3);
  assert.equal(results.filter((s) => s === 402).length, 5);
});

test('agent picks the tool, streams text, trims Free results on the server, and logs agent_tool_called', async () => {
  const c = client();
  await signup(c, 'agent@test.com', null);
  const evs = await chat(c, 'Which post worked best?');
  const start = evs.find((e) => e.type === 'tool_start');
  assert.equal(start.name, 'get_results_summary');
  const end = evs.find((e) => e.type === 'tool_end');
  assert.equal(end.ok, true);
  assert.equal(end.result.locked, true, 'free user gets trimmed results from the tool');
  assert.equal(end.result.totals, undefined);
  assert.ok(evs.some((e) => e.type === 'text'));
  assert.equal(evs.at(-1).type, 'done');
  assert.ok((await events('agent_tool_called')).some((e) => e.tool === 'get_results_summary'));
});

test('a credit is only spent after the merchant presses the button on the proposal', async () => {
  const c = client();
  await signup(c, 'propose@test.com', null);
  let evs = await chat(c, 'Write a post for me');
  const tools = evs.filter((e) => e.type === 'tool_end');
  assert.equal(tools.length, 1, 'the agent stops after proposing');
  assert.equal(tools[0].name, 'propose_post');
  assert.equal(tools[0].card.type, 'proposal');
  const id = tools[0].card.proposal.id;
  assert.equal(evs.at(-1).quota.used, 0);
  assert.ok((await events('post_proposed')).some((e) => e.proposal_id === id));

  // Typing "yes" is not enough: generate_post is refused until the button is pressed.
  evs = await chat(c, `force-generate ${id}`);
  let end = evs.find((e) => e.type === 'tool_end');
  assert.equal(end.name, 'generate_post');
  assert.equal(end.error, 'needs_confirmation');
  assert.equal(evs.at(-1).quota.used, 0);

  const acc = await c(`/api/proposals/${id}/accept`, { method: 'POST' });
  assert.equal(acc.status, 200);
  assert.ok((await events('proposal_accepted')).some((e) => e.proposal_id === id));
  evs = await chat(c, 'Yes, write it.');
  end = evs.find((e) => e.type === 'tool_end');
  assert.equal(end.name, 'generate_post');
  assert.equal(end.ok, true);
  assert.equal(end.card.type, 'post');
  for (const v of end.card.post.variants) {
    assert.doesNotMatch(v.caption, /https?:\/\//, 'Instagram captions carry no URL');
    assert.match(v.caption, /JC-[A-Z0-9]{4}/, 'the discount code tracks the sale');
  }
  assert.equal(evs.at(-1).quota.used, 1);

  // The same proposal cannot be written twice.
  evs = await chat(c, `force-generate ${id}`);
  assert.equal(evs.find((e) => e.type === 'tool_end').error, 'already_written');
  assert.equal(evs.at(-1).quota.used, 1);

  // Edits are free.
  evs = await chat(c, `make it shorter ${end.card.post.id}`);
  const rev = evs.find((e) => e.type === 'tool_end');
  assert.equal(rev.name, 'revise_post');
  assert.equal(rev.ok, true);
  assert.match(rev.card.post.variants[1].caption, /^Shorter now/);
  assert.equal(evs.at(-1).quota.used, 1);
});

test('out of credits: the accepted proposal hits the paywall and can be pressed again later', async () => {
  const c = client();
  await signup(c, 'agentgen@test.com', null);
  await c('/api/demo/use-credits', { method: 'POST', body: { leave: 0 } });
  let evs = await chat(c, 'Write another one');
  const id = evs.find((e) => e.type === 'tool_end').card.proposal.id;
  await c(`/api/proposals/${id}/accept`, { method: 'POST' });
  evs = await chat(c, 'Yes, write it.');
  const end = evs.find((e) => e.type === 'tool_end');
  assert.equal(end.error, 'quota_exceeded');
  assert.ok(evs.some((e) => e.type === 'paywall'));
  const again = await (await c(`/api/proposals/${id}/accept`, { method: 'POST' })).json();
  assert.equal(again.proposal.status, 'accepted');
});

test('invalid tool arguments go back to the model instead of crashing', async () => {
  const c = client();
  await signup(c, 'badjson@test.com', null);
  const evs = await chat(c, 'broken-json please');
  const end = evs.find((e) => e.type === 'tool_end');
  assert.equal(end.ok, false);
  assert.equal(end.error, 'bad_arguments');
  assert.equal(evs.at(-1).type, 'done');
});

test('"I\'ve posted it" logs post_published once, and only published posts count in results', async () => {
  const c = client();
  await signup(c, 'publish@test.com', null);
  const gen = await (await c('/api/generate', { method: 'POST', body: { product_id: 'p3', channel: 'tiktok', angle: 'gift_idea' } })).json();
  let home = await (await c('/api/home')).json();
  assert.notEqual(home.summary.latest_post?.id, gen.post.id, 'an unpublished draft is not a result yet');
  assert.equal(home.drafts[0].id, gen.post.id);
  assert.equal(home.getting_started.find((s) => s.key === 'publish').done, false);

  for (let i = 0; i < 2; i += 1) {
    const r = await c(`/api/posts/${gen.post.id}/publish`, { method: 'POST', body: { variant: 1 } });
    assert.equal(r.status, 200);
  }
  const pub = (await events('post_published')).filter((e) => e.post_id === gen.post.id);
  assert.equal(pub.length, 1);
  assert.equal(pub[0].variant, 2);
  home = await (await c('/api/home')).json();
  assert.equal(home.summary.latest_post.id, gen.post.id);
  assert.ok(home.summary.waiting_for_first_click.some((p) => p.id === gen.post.id));
  assert.equal(home.getting_started.find((s) => s.key === 'publish').done, true);
});

test('Pro summary matches the demo history and names the next post to write', async () => {
  const c = client();
  await signup(c, 'pro-summary@test.com', null);
  const co = await (await c('/api/billing/checkout', { method: 'POST', body: { item: 'pro' } })).json();
  await c(`/api/billing/simulate-pay/${co.checkout.id}`, { method: 'POST' });
  const home = await (await c('/api/home')).json();
  assert.equal(home.summary.locked, false);
  assert.deepEqual([home.summary.totals.posts, home.summary.totals.orders, home.summary.totals.revenue], [7, 31, 1444]);
  assert.equal(home.summary.change_pct.orders, 107);
  assert.equal(home.summary.by_angle[0].name, 'Behind the scenes');
  assert.equal(home.recommendation.product_id, 'p6');
  assert.equal(home.recommendation.angle, 'behind_the_scenes');
});

test('tracked link: unique clicks are de-duplicated, bots ignored, orders attributed by code', async () => {
  const c = client();
  await signup(c, 'links@test.com', null);
  const gen = await (await c('/api/generate', { method: 'POST', body: { product_id: 'p6', channel: 'instagram', angle: 'gift_idea' } })).json();
  const code = gen.post.link_code;
  const ua = { 'User-Agent': 'Mozilla/5.0 test' };
  const r1 = await fetch(`${base}/r/${code}`, { redirect: 'manual', headers: ua });
  assert.equal(r1.status, 302);
  await fetch(`${base}/r/${code}`, { redirect: 'manual', headers: ua });
  await fetch(`${base}/r/${code}`, { redirect: 'manual', headers: { 'User-Agent': 'facebookexternalhit/1.1' } });
  const clicks = (await events('tracked_link_click')).filter((e) => e.link_id === code);
  assert.equal(clicks.length, 3);
  assert.equal(clicks.filter((e) => e.unique).length, 1);
  assert.equal(clicks.filter((e) => e.is_bot).length, 1);

  const order = await (await fetch(`${base}/api/shop/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product_id: 'p6', discount_code: gen.post.discount_code.toLowerCase() }) })).json();
  assert.equal(order.order.attribution_method, 'discount_code');
  assert.equal(order.order.post_id, gen.post.id);
  assert.equal(order.order.value, 57.6);

  const results = await (await c('/api/results')).json();
  const live = results.posts.find((p) => p.id === gen.post.id);
  assert.equal(live.clicks, 1);
  assert.equal(live.orders, 1);
});

test('browser can only send whitelisted events', async () => {
  const ok = await fetch(`${base}/api/track`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'landing_view', props: { utm_source: 'ig' } }) });
  assert.equal(ok.status, 200);
  const bad = await fetch(`${base}/api/track`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'subscription_started', props: {} }) });
  assert.equal(bad.status, 400);
});
