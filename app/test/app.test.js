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

async function chat(c, message, extra = {}) {
  const r = await c('/api/chat', { method: 'POST', body: { message, ...extra } });
  const text = await r.text();
  if (!r.ok) return [{ type: 'http_error', status: r.status, ...JSON.parse(text || '{}') }];
  return text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}
// The "Write 3 versions" button on a proposal card.
const press = (c, id) => chat(c, 'Yes, write it.', { proposal_id: id });
const me = async (c) => (await (await c('/api/me')).json()).user;
async function upgrade(c, cycle = 'monthly') {
  const co = await (await c('/api/billing/checkout', { method: 'POST', body: { item: 'pro', cycle } })).json();
  const r = await c(`/api/billing/simulate-pay/${co.checkout.id}`, { method: 'POST' });
  assert.equal(r.status, 200);
  return co.checkout;
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
  const user = await signup(c, 'agent@test.com', null);
  const evs = await chat(c, 'Which post worked best?');
  const start = evs.find((e) => e.type === 'tool_start');
  assert.equal(start.name, 'get_results_summary');
  const end = evs.find((e) => e.type === 'tool_end');
  assert.equal(end.ok, true);
  assert.equal(end.result.locked, true, 'free user gets trimmed results from the tool');
  assert.equal(end.result.totals, undefined);
  const tools = require('../lib/tools');
  const oldPost = await tools.run('get_post', { post_id: 'h1' }, { user });
  assert.equal(oldPost.result.locked, true, 'Free cannot inspect an older post through the assistant');
  assert.notEqual(oldPost.result.id, 'h1');
  assert.ok(evs.some((e) => e.type === 'text'));
  assert.equal(evs.at(-1).type, 'done');
  assert.ok((await events('agent_tool_called')).some((e) => e.tool === 'get_results_summary'));
});

test('generation requires exactly three distinct versions and refunds a failed attempt', async () => {
  const c = client();
  const user = await signup(c, 'three-versions@test.com', null);
  const before = await me(c);
  const store = require('../lib/store');
  const stubModel = require('./stub-llm');
  stubModel.quirks.variantCount = 2;
  try {
    const failed = await c('/api/generate', { method: 'POST', body: { product_id: 'p1', channel: 'instagram', angle: 'behind_the_scenes', request_id: 'req_bad_variants' } });
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).error, 'bad_output');
    assert.equal((await me(c)).quota.used, before.quota.used, 'a bad model response uses no credit');
    assert.equal(store.db.posts.filter((p) => p.user_id === user.id).length, 0, 'a bad model response creates no draft');
  } finally {
    delete stubModel.quirks.variantCount;
  }
  const ok = await (await c('/api/generate', { method: 'POST', body: { product_id: 'p1', channel: 'instagram', angle: 'behind_the_scenes', request_id: 'req_three_variants' } })).json();
  assert.equal(ok.post.variants.length, 3);
  assert.equal(new Set(ok.post.variants.map((v) => v.caption)).size, 3);
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

  // Typing "yes" is not enough: the model has no tool that writes a post.
  evs = await chat(c, `force-generate ${id}`);
  let end = evs.find((e) => e.type === 'tool_end');
  assert.equal(end.name, 'generate_post');
  assert.equal(end.error, 'unknown_tool');
  assert.equal(evs.at(-1).quota.used, 0);

  // The button: the server writes the post in the same request.
  evs = await press(c, id);
  assert.ok((await events('proposal_accepted')).some((e) => e.proposal_id === id));
  end = evs.find((e) => e.type === 'tool_end');
  assert.equal(end.name, 'generate_post');
  assert.equal(end.ok, true);
  assert.equal(end.card.type, 'post');
  for (const v of end.card.post.variants) {
    assert.doesNotMatch(v.caption, /https?:\/\//, 'Instagram captions carry no URL');
    assert.match(v.caption, /JC-[A-Z0-9]{4}/, 'the discount code tracks the sale');
  }
  assert.equal(evs.at(-1).quota.used, 1);

  // Pressing again, or the model asking again, cannot write it twice.
  evs = await press(c, id);
  assert.equal(evs[0].status, 409);
  assert.equal(evs[0].error, 'already_written');
  evs = await chat(c, `force-generate ${id}`);
  assert.equal(evs.find((e) => e.type === 'tool_end').error, 'unknown_tool');
  assert.equal(evs.at(-1).quota.used, 1);

  // Edits are free.
  evs = await chat(c, `make it shorter ${end.card.post.id}`);
  const rev = evs.find((e) => e.type === 'tool_end');
  assert.equal(rev.name, 'revise_post');
  assert.equal(rev.ok, true);
  assert.match(rev.card.post.variants[1].caption, /^Shorter now/);
  assert.equal(evs.at(-1).quota.used, 1);
});

test('out of credits: the press hits the paywall, spends nothing, and the button works again later', async () => {
  const c = client();
  await signup(c, 'agentgen@test.com', null);
  await c('/api/demo/use-credits', { method: 'POST', body: { leave: 0 } });
  let evs = await chat(c, 'Write another one');
  const id = evs.find((e) => e.type === 'tool_end').card.proposal.id;
  evs = await press(c, id);
  const end = evs.find((e) => e.type === 'tool_end');
  assert.equal(end.error, 'quota_exceeded');
  assert.ok(evs.some((e) => e.type === 'paywall'));
  await c('/api/demo/use-credits', { method: 'POST', body: { leave: 1 } });
  evs = await press(c, id);
  assert.equal(evs.find((e) => e.type === 'tool_end').ok, true);
  assert.equal(evs.at(-1).quota.left, 0);
});

test('double charge: a double press, a double click on Write, or two tabs spend one credit', async () => {
  const c = client();
  await signup(c, 'double@test.com', null);
  const id = (await chat(c, 'Write a post')).find((e) => e.type === 'tool_end').card.proposal.id;
  // Two presses at once: one writes, the other is turned away while the first is running.
  const both = await Promise.all([press(c, id), press(c, id)]);
  const written = both.filter((evs) => evs.some((e) => e.type === 'tool_end' && e.ok));
  assert.equal(written.length, 1);
  assert.ok(both.some((evs) => evs[0].type === 'http_error' && [409].includes(evs[0].status)));
  assert.equal((await me(c)).quota.used, 1);

  // An unrelated message after the press spends nothing.
  const evs = await chat(c, 'thanks, how are you');
  assert.ok(!evs.some((e) => e.type === 'tool_end'));
  assert.equal((await me(c)).quota.used, 1);

  // The Write page: the same request_id twice (double click, or a retry after a dropped connection).
  const body = { product_id: 'p2', channel: 'tiktok', angle: 'gift_idea', request_id: 'req_same' };
  const [a, b] = await Promise.all([1, 2].map(() => c('/api/generate', { method: 'POST', body })));
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], 'the second one is told the first is still running');
  const retry = await (await c('/api/generate', { method: 'POST', body })).json();
  assert.equal(retry.replayed, true);
  assert.equal((await me(c)).quota.used, 2);
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

  const newer = await (await c('/api/generate', { method: 'POST', body: { product_id: 'p4', channel: 'facebook', angle: 'customer_review' } })).json();
  await c(`/api/posts/${newer.post.id}/publish`, { method: 'POST', body: { variant: 0 } });
  home = await (await c('/api/home')).json();
  assert.equal(home.summary.latest_post.id, newer.post.id, 'same-day posts are ordered by their full creation time');
});

test('Pro summary matches the demo history and names the next post to write', async () => {
  const c = client();
  await signup(c, 'pro-summary@test.com', null);
  await upgrade(c);
  const home = await (await c('/api/home')).json();
  assert.equal(home.summary.locked, false);
  assert.deepEqual([home.summary.totals.posts, home.summary.totals.orders, home.summary.totals.revenue], [7, 31, 1444]);
  assert.equal(home.summary.change_pct.orders, 107);
  assert.equal(home.summary.by_angle[0].name, 'Behind the scenes');
  assert.equal(home.recommendation.product_id, 'p6');
  assert.equal(home.recommendation.angle, 'behind_the_scenes');
});

test('tracked link: clicks are de-duplicated, orders are idempotent, and product attribution is isolated', async () => {
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

  const orderBody = { order_id: 'web_order_same_001', product_id: 'p6', discount_code: gen.post.discount_code.toLowerCase() };
  const order = await (await fetch(`${base}/api/shop/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderBody) })).json();
  assert.equal(order.order.attribution_method, 'discount_code');
  assert.equal(order.order.post_id, gen.post.id);
  assert.equal(order.order.value, 57.6);
  const replay = await (await fetch(`${base}/api/shop/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderBody) })).json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.order.order_id, order.order.order_id);
  assert.equal((await events('order_attributed')).filter((e) => e.order_id === order.order.order_id).length, 1);

  const wrongProduct = await (await fetch(`${base}/api/shop/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_id: 'web_order_cross_001', product_id: 'p5', discount_code: gen.post.discount_code, ref: code }) })).json();
  assert.equal(wrongProduct.discount_applied, false);
  assert.equal(wrongProduct.order.post_id, null);
  assert.equal(wrongProduct.order.attribution_method, null);

  const results = await (await c('/api/results')).json();
  const live = results.posts.find((p) => p.id === gen.post.id);
  assert.equal(live.clicks, 1);
  assert.equal(live.orders, 1);
});

test('metrics use post-upgrade clicks, the current UTC month, and Results-only weekly views', () => {
  const store = require('../lib/store');
  const metrics = require('../lib/metrics');
  const now = Date.parse('2032-05-15T12:00:00.000Z');
  const lengths = Object.fromEntries(['users', 'links', 'clicks', 'events'].map((k) => [k, store.db[k].length]));
  const id = 'usr_metrics_boundary';
  try {
    store.db.users.push({ id, plan: 'pro', created_at: '2032-05-01T00:00:00.000Z', pro_since: '2032-05-10T00:00:00.000Z' });
    store.db.links.push({ code: 'metrics-link', user_id: id, post_id: 'metrics-post' });
    store.db.events.push(
      { name: 'subscription_started', user_id: id, plan: 'pro', ts: '2032-04-30T23:59:59.999Z' },
      { name: 'subscription_started', user_id: id, plan: 'pro', ts: '2032-05-10T00:00:00.000Z' },
      { name: 'subscription_started', user_id: id, plan: 'pro', ts: '2032-05-16T00:00:00.000Z' },
      { name: 'report_viewed', user_id: id, plan: 'pro', report_type: 'home', ts: '2032-05-14T00:00:00.000Z' },
      { name: 'report_viewed', user_id: id, plan: 'pro', report_type: 'dashboard', ts: '2032-05-14T00:00:00.000Z' },
    );
    const beforeClick = metrics.compute(now);
    assert.equal(beforeClick.a4.month2.value, 1);
    assert.equal(beforeClick.leading.weekly_results_open_rate.numerator, 1, 'Home views do not count as Results opens');
    const baseHits = beforeClick.a4.month1.numerator;
    store.db.clicks.push({ link_code: 'metrics-link', unique: true, is_bot: false, ts: '2032-05-09T23:59:59.999Z' });
    assert.equal(metrics.compute(now).a4.month1.numerator, baseHits, 'pre-upgrade clicks do not activate Month 1');
    store.db.clicks.push({ link_code: 'metrics-link', unique: true, is_bot: false, ts: '2032-05-11T00:00:00.000Z' });
    assert.equal(metrics.compute(now).a4.month1.numerator, baseHits + 1);
  } finally {
    for (const [k, length] of Object.entries(lengths)) store.db[k].splice(length);
  }
});

test('browser can only send whitelisted events', async () => {
  const ok = await fetch(`${base}/api/track`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'landing_view', props: { utm_source: 'ig' } }) });
  assert.equal(ok.status, 200);
  const bad = await fetch(`${base}/api/track`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'subscription_started', props: {} }) });
  assert.equal(bad.status, 400);
});

test('billing: one subscription per user, an old unpaid checkout cannot be paid once on Pro', async () => {
  const c = client();
  const user = await signup(c, 'billing@test.com', null);
  const a = await (await c('/api/billing/checkout', { method: 'POST', body: { item: 'pro' } })).json();
  const again = await (await c('/api/billing/checkout', { method: 'POST', body: { item: 'pro' } })).json();
  assert.equal(again.checkout.id, a.checkout.id, 'pressing Upgrade twice reuses the open checkout');
  const yearly = await (await c('/api/billing/checkout', { method: 'POST', body: { item: 'pro', cycle: 'yearly' } })).json();
  const monthly = await (await c('/api/billing/checkout', { method: 'POST', body: { item: 'pro' } })).json();
  assert.notEqual(monthly.checkout.id, a.checkout.id, 'switching cycle replaced the first checkout');

  assert.equal((await c(`/api/billing/simulate-pay/${monthly.checkout.id}`, { method: 'POST' })).status, 200);
  // The yearly checkout from before is closed now; paying it is refused, not a second subscription.
  const old = await c(`/api/billing/simulate-pay/${yearly.checkout.id}`, { method: 'POST' });
  assert.equal(old.status, 409);
  assert.equal((await c('/api/billing/checkout', { method: 'POST', body: { item: 'pro' } })).status, 409);

  // Even if the provider's webhook arrives for it anyway, the money is refunded and nothing else changes.
  const crypto = require('crypto');
  const raw = JSON.stringify({ type: 'checkout.completed', checkout_id: yearly.checkout.id });
  const sig = crypto.createHmac('sha256', 'demo-webhook-secret').update(raw).digest('hex');
  const hook = await (await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sig }, body: raw })).json();
  assert.equal(hook.refunded, true);
  // A repeated webhook for the paid one is a no-op.
  const raw2 = JSON.stringify({ type: 'checkout.completed', checkout_id: monthly.checkout.id });
  const sig2 = crypto.createHmac('sha256', 'demo-webhook-secret').update(raw2).digest('hex');
  assert.equal((await (await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sig2 }, body: raw2 })).json()).duplicate, true);

  assert.equal((await events('subscription_started')).filter((e) => e.user_id === user.id).length, 1);
  assert.equal((await events('payment_refunded')).filter((e) => e.user_id === user.id).length, 1);
  const u = await me(c);
  assert.equal(u.plan, 'pro');
  assert.equal(u.subscription.status, 'active');
});

test('billing: cancel keeps Pro until the period ends, can be undone, then moves to Free', async () => {
  const c = client();
  const user = await signup(c, 'cancel@test.com', null);
  await upgrade(c);
  let r = await (await c('/api/billing/cancel', { method: 'POST' })).json();
  assert.equal(r.user.plan, 'pro', 'still Pro: the period is paid for');
  assert.equal(r.user.subscription.status, 'canceling');
  assert.ok(r.user.subscription.ends_at);
  assert.equal((await c('/api/billing/checkout', { method: 'POST', body: { item: 'pro' } })).status, 409, 'no paying twice while canceling');

  r = await (await c('/api/billing/resume', { method: 'POST' })).json();
  assert.equal(r.user.subscription.status, 'active');
  await c('/api/billing/cancel', { method: 'POST' });

  // A top-up checkout opened while on Pro...
  const addon = await (await c('/api/billing/checkout', { method: 'POST', body: { item: 'addon' } })).json();
  // ...the period runs out:
  r = await (await c('/api/demo/end-period', { method: 'POST' })).json();
  assert.equal(r.user.plan, 'free');
  assert.equal(r.user.subscription, null, 'Free and no subscription: one consistent state');
  assert.ok((await events('subscription_ended')).some((e) => e.user_id === user.id));
  // ...so it can no longer be paid, and no new top-up can be bought.
  assert.equal((await c(`/api/billing/simulate-pay/${addon.checkout.id}`, { method: 'POST' })).status, 409);
  assert.equal((await c('/api/billing/checkout', { method: 'POST', body: { item: 'addon' } })).status, 409);
  assert.equal((await me(c)).quota.limit, 10);
  // Upgrading again works and starts a fresh subscription.
  await upgrade(c);
  assert.equal((await me(c)).subscription.status, 'active');
});

test('top-up credits carry over to next month; plan credits reset', async () => {
  const quota = require('../lib/quota');
  const user = { id: 'usr_carry', plan: 'pro', quota: { period: '2000-01', used: 350, reserved: 0, bonus: 200 } };
  const st = quota.status(user);
  assert.equal(st.used, 0);
  assert.equal(st.limit, 300 + 150, '50 of the 200 top-up credits were used, 150 carry over');
  const untouched = { id: 'usr_carry2', plan: 'pro', quota: { period: '2000-01', used: 10, reserved: 0, bonus: 200 } };
  assert.equal(quota.status(untouched).limit, 500);
  const free = { id: 'usr_carry3', plan: 'free', quota: { period: '2000-01', used: 10, reserved: 0, bonus: 0 } };
  assert.equal(quota.status(free).limit, 10);
  // Leaving Pro mid-month after using all 300 plan credits keeps the 200 unused top-up credits.
  const leaving = { id: 'usr_carry4', plan: 'pro', quota: { period: new Date().toISOString().slice(0, 7), used: 300, reserved: 0, bonus: 200 } };
  leaving.plan = 'free';
  quota.onPlanChange(leaving, 'pro');
  assert.equal(quota.status(leaving).left, 200);
});

test('model vendors: tool calls work with repeated names, no index, one chunk, thinking models and fixed temperature', async () => {
  const llm = require('../lib/llm');
  const { quirks } = require('./stub-llm');
  const modes = [
    { repeatName: true },
    { noIndex: true },
    { noIndex: true, repeatName: true },
    { oneChunk: true },
    { thinking: true },
    { fixedTemperature: true },
    { noToolChoice: true },
  ];
  try {
    for (const mode of modes) {
      for (const k of Object.keys(quirks)) delete quirks[k];
      Object.assign(quirks, mode);
      llm._reset();
      const c = client();
      await signup(c, `vendor-${Object.keys(mode).join('-')}@test.com`, null);
      const evs = await chat(c, 'Which post worked best?');
      const label = JSON.stringify(mode);
      assert.ok(!evs.some((e) => e.type === 'error'), `${label}: ${evs.find((e) => e.type === 'error')?.message}`);
      const end = evs.find((e) => e.type === 'tool_end');
      assert.equal(end?.name, 'get_results_summary', label);
      assert.equal(end.ok, true, label);
      assert.ok(evs.some((e) => e.type === 'text'), `${label}: answered after the tool`);
    }
  } finally {
    for (const k of Object.keys(quirks)) delete quirks[k];
    llm._reset();
  }
});

test('stitcher: tool-call fragments from different vendors become whole calls', () => {
  const { stitcher } = require('../lib/llm');
  const run = (chunks) => { const s = stitcher(); chunks.forEach((c) => s.add(c)); return s.result(); };
  // Two parallel calls, OpenAI style.
  let calls = run([
    { index: 0, id: 'a', function: { name: 'get_post', arguments: '' } },
    { index: 1, id: 'b', function: { name: 'find_reviews', arguments: '' } },
    { index: 0, function: { arguments: '{"post_id":' } },
    { index: 1, function: { arguments: '{"product_id":"p1"}' } },
    { index: 0, function: { arguments: '"x"}' } },
  ]);
  assert.deepEqual(calls.map((c) => [c.id, c.name, JSON.parse(c.arguments)]), [['a', 'get_post', { post_id: 'x' }], ['b', 'find_reviews', { product_id: 'p1' }]]);
  // Full arguments resent in every chunk, and arguments as an object.
  calls = run([{ id: 'a', function: { name: 'get_post', arguments: '{"post_id":"x"}' } }, { id: 'a', function: { name: 'get_post', arguments: '{"post_id":"x"}' } }]);
  assert.equal(calls[0].arguments, '{"post_id":"x"}');
  calls = run([{ id: 'a', function: { name: 'get_post', arguments: { post_id: 'x' } } }]);
  assert.deepEqual(JSON.parse(calls[0].arguments), { post_id: 'x' });
  // Two calls without index, told apart by id.
  calls = run([{ id: 'a', function: { name: 'get_post', arguments: '{}' } }, { id: 'b', function: { name: 'find_reviews', arguments: '{' } }, { function: { arguments: '}' } }]);
  assert.deepEqual(calls.map((c) => [c.name, c.arguments]), [['get_post', '{}'], ['find_reviews', '{}']]);
});

test('JSON answers wrapped in <think> or code fences are still read', () => {
  const { extractJson } = require('../lib/llm');
  assert.deepEqual(extractJson('<think>maybe {a} or {b}</think>\n```json\n{"variants":[1]}\n```'), { variants: [1] });
  assert.equal(extractJson('no json here'), null);
});
