// Lumi v2 server. Run: npm start
require('./lib/env').load();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const store = require('./lib/store');
const quota = require('./lib/quota');
const agent = require('./lib/agent');
const llm = require('./lib/llm');
const performance = require('./lib/performance');
const metrics = require('./lib/metrics');
const proposals = require('./lib/proposals');
const merchant = require('./data/merchant.json');
const { generatePost, QuotaError } = require('./lib/generate');
const { recordClick, attributeOrder } = require('./lib/links');
const { PLANS, ADDON } = require('./lib/config');

const app = express();
app.set('trust proxy', true);
// The billing webhook needs the raw body to check its signature, so JSON parsing skips it.
const jsonBody = express.json({ limit: '100kb' });
app.use((req, res, next) => (req.path === '/api/billing/webhook' ? next() : jsonBody(req, res, next)));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- helpers ----------

const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
const currentUser = (req) => store.db.users.find((u) => u.id === cookies(req).lumi_uid);
const TOUCH_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ttclid', 'referrer', 'landing_path', 'ts'];
const cleanTouch = (t) => (t && typeof t === 'object'
  ? Object.fromEntries(TOUCH_KEYS.filter((k) => t[k]).map((k) => [k, String(t[k]).slice(0, 200)]))
  : null);
const sha256 = (s) => crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');

function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'not_signed_in', message: 'Sign up on the landing page first.' });
  req.user = user;
  next();
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    plan: user.plan,
    plan_info: PLANS[user.plan],
    quota: quota.status(user),
    first_touch: user.first_touch,
    subscription: store.db.subscriptions.find((s) => s.user_id === user.id && !s.ended_at) || null,
  };
}

// ---------- tracked links ----------

app.get('/r/:code', (req, res) => {
  const link = store.db.links.find((l) => l.code === req.params.code);
  if (!link) return res.status(404).send('Link not found');
  recordClick(link, { ip: req.ip, ua: req.get('user-agent') || '', referrer: req.get('referer') });
  // First-party cookie so an order without a discount code can still be attributed (last click, 30 days).
  res.cookie('lumi_ref', link.code, { maxAge: 30 * 864e5, sameSite: 'lax' });
  const q = new URLSearchParams({ ref: link.code, product: link.product_id, ...link.utm });
  res.redirect(302, `/shop?${q}`);
});

// ---------- events from the browser ----------

app.post('/api/track', (req, res) => {
  const { name, props = {} } = req.body || {};
  if (!store.CLIENT_EVENTS.has(name)) return res.status(400).json({ error: 'event_not_allowed' });
  const user = currentUser(req);
  const safe = Object.fromEntries(Object.entries(props).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 20));
  store.track(name, { ...safe, user_id: user?.id || null, plan: user?.plan || null }, 'client');
  res.json({ ok: true });
});

// ---------- account ----------

app.post('/api/signup', (req, res) => {
  const { email, anonymous_id, first_touch, last_touch, platform = 'web' } = req.body || {};
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'bad_email', message: 'Enter a valid email.' });
  let user = store.db.users.find((u) => u.email === email.toLowerCase());
  const isNew = !user;
  if (!user) {
    user = {
      id: store.id('usr'),
      email: email.toLowerCase(),
      plan: 'free',
      anonymous_id: anonymous_id || null,
      // Source is bound to the account at sign-up; every later event joins on user_id (A13).
      first_touch: cleanTouch(first_touch),
      last_touch: cleanTouch(last_touch),
      platform,
      created_at: new Date().toISOString(),
    };
    store.db.users.push(user);
    store.track('sign_up', {
      user_id: user.id,
      anonymous_id: user.anonymous_id,
      platform,
      ...Object.fromEntries(Object.entries(user.first_touch || {}).map(([k, v]) => [k === 'ts' ? 'first_touch_ts' : k, v])),
      last_touch_source: user.last_touch?.utm_source || null,
    });
  }
  res.cookie('lumi_uid', user.id, { httpOnly: true, sameSite: 'lax', maxAge: 365 * 864e5 });
  res.json({ user: publicUser(user), is_new: isNew });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('lumi_uid');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  res.json({
    user: user ? publicUser(user) : null,
    llm: { configured: llm.configured(), model: process.env.LLM_MODEL || null },
    plans: PLANS,
    addon: ADDON,
    demo_tools: process.env.DEMO_TOOLS !== 'off',
  });
});

app.get('/api/catalog', (req, res) => {
  res.json({ merchant: merchant.merchant, products: merchant.products, angles: merchant.angles });
});

// ---------- AI ----------

app.post('/api/chat', requireUser, async (req, res) => {
  const text = String(req.body?.message || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'empty_message' });
  if (!llm.configured()) return res.status(503).json({ error: 'llm_not_configured', message: 'Add LLM_API_KEY, LLM_BASE_URL and LLM_MODEL to app/.env, then restart.' });
  const allowed = quota.takeChatMessage(req.user);
  if (!allowed.ok) return res.status(429).json({ error: 'chat_limit', message: `Daily chat limit reached (${allowed.cap} messages on ${PLANS[req.user.plan].name}).` });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const emit = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  try {
    const page = ['home', 'write', 'results', 'plan'].includes(req.body?.page) ? req.body.page : null;
    await agent.chat(req.user, text, emit, { page });
    emit({ type: 'done', quota: quota.status(req.user) });
  } catch (err) {
    console.error('[chat]', err.code || '', err.cause?.message || err.message);
    emit({ type: 'error', code: err.code || 'error', message: err.message || 'Something went wrong.' });
  }
  res.end();
});

app.post('/api/chat/reset', requireUser, (req, res) => {
  agent.reset(req.user);
  res.json({ ok: true });
});

app.post('/api/generate', requireUser, async (req, res) => {
  if (!llm.configured()) return res.status(503).json({ error: 'llm_not_configured', message: 'Add LLM_API_KEY, LLM_BASE_URL and LLM_MODEL to app/.env, then restart.' });
  try {
    const { post, quota: q } = await generatePost(req.user, req.body || {}, { trigger: 'create_page' });
    res.json({ post: { ...post, product: performance.productName(post.product_id) }, quota: q });
  } catch (err) {
    if (err instanceof QuotaError) return res.status(402).json({ error: 'quota_exceeded', quota: err.status });
    const status = err.code === 'bad_input' ? 400 : 502;
    res.status(status).json({ error: err.code || 'error', message: err.message });
  }
});

// The button on a proposal card. This, not anything typed in chat, is what lets the assistant spend a credit.
app.post('/api/proposals/:id/accept', requireUser, (req, res) => {
  const out = proposals.accept(req.user, req.params.id);
  if (out.error) return res.status(404).json({ error: out.error });
  res.json({ proposal: out.proposal, quota: quota.status(req.user) });
});

app.get('/api/posts/:id', requireUser, (req, res) => {
  const post = store.db.posts.find((p) => p.id === req.params.id && p.user_id === req.user.id);
  if (!post) return res.status(404).json({ error: 'not_found' });
  res.json({ post: { ...post, product: performance.productName(post.product_id) } });
});

// "I've posted it": the merchant picked a version and published it. Results only count published posts.
app.post('/api/posts/:id/publish', requireUser, (req, res) => {
  const post = store.db.posts.find((p) => p.id === req.params.id && p.user_id === req.user.id);
  if (!post) return res.status(404).json({ error: 'not_found' });
  const i = Number(req.body?.variant) || 0;
  const v = post.variants[i];
  if (!v) return res.status(400).json({ error: 'bad_variant' });
  const first = !post.published_at;
  post.chosen_caption = v.caption;
  post.chosen_variant = i;
  post.published_at ||= new Date().toISOString();
  if (first) {
    store.track('post_published', {
      user_id: req.user.id, plan: req.user.plan, post_id: post.id, product_id: post.product_id, channel: post.channel,
      angle: post.angle, variant: i + 1, minutes_since_generated: Math.round((Date.now() - Date.parse(post.created_at)) / 60000),
    });
  }
  store.save();
  res.json({ ok: true, post });
});

app.get('/api/results', requireUser, (req, res) => {
  const { sort_by, group_by, days } = req.query;
  res.json(performance.build(req.user, { sort_by, group_by, days: Number(days) || undefined }));
});

app.get('/api/summary', requireUser, (req, res) => {
  res.json(performance.summary(req.user, { days: Number(req.query.days) || 30 }));
});

// Everything the home page needs in one call: this period, what to post next, and first-week progress.
app.get('/api/home', requireUser, (req, res) => {
  const { db } = store;
  const mine = db.posts.filter((p) => p.user_id === req.user.id);
  const codes = new Set(db.links.filter((l) => l.user_id === req.user.id).map((l) => l.code));
  const steps = [
    { key: 'connect', label: 'Connect your shop', done: true }, // the demo shop is connected at sign-up
    { key: 'write', label: 'Write your first post', done: mine.length > 0 },
    { key: 'publish', label: 'Post it and put the link in your bio', done: mine.some((p) => p.published_at) },
    { key: 'click', label: 'Get your first tracked click', done: db.clicks.some((c) => codes.has(c.link_code) && c.unique && !c.is_bot) },
  ];
  const drafts = mine.filter((p) => !p.published_at).slice(-3).reverse()
    .map((p) => ({ id: p.id, product: performance.productName(p.product_id), channel: p.channel, created_at: p.created_at }));
  res.json({
    summary: performance.summary(req.user, { days: Number(req.query.days) || 30 }),
    recommendation: performance.recommend(req.user) || fallbackRecommendation(mine),
    getting_started: steps.every((s) => s.done) ? null : steps,
    drafts,
    quota: quota.status(req.user),
  });
});

// Free users cannot see rankings, so their suggestion comes from the catalog alone: the best-rated, well-stocked product.
function fallbackRecommendation(mine = []) {
  const recent = new Set(mine.filter((p) => Date.now() - Date.parse(p.created_at) < 7 * 864e5).map((p) => p.product_id));
  const fresh = merchant.products.filter((x) => x.stock > 20 && !recent.has(x.id));
  const p = [...(fresh.length ? fresh : merchant.products)].sort((a, b) => b.rating * Math.log(b.review_count) - a.rating * Math.log(a.review_count))[0];
  const first = !mine.length;
  return { product_id: p.id, product: p.name, angle: 'ugc_review', angle_label: merchant.angles.ugc_review, channel: 'instagram', reason: `${p.name} is rated ${p.rating} from ${p.review_count} reviews, so real customer quotes make an easy ${first ? 'first ' : ''}post.`, from_catalog: true };
}

// ---------- simulated storefront (where tracked links land) ----------

app.get('/api/shop/link/:code', (req, res) => {
  const link = store.db.links.find((l) => l.code === req.params.code);
  const product = merchant.products.find((p) => p.id === (link?.product_id || req.query.product)) || merchant.products[0];
  const owner = link && store.db.users.find((u) => u.id === link.user_id);
  // Free plan links show a "Made with Lumi" badge (pricing table; doubles as a growth loop).
  res.json({ product, merchant: merchant.merchant.name, channel: link?.channel || null, badge: Boolean(owner && owner.plan === 'free') });
});

app.post('/api/shop/order', (req, res) => {
  const { product_id, quantity = 1, discount_code } = req.body || {};
  const product = merchant.products.find((p) => p.id === product_id);
  if (!product) return res.status(400).json({ error: 'bad_product' });
  const qty = Math.min(Math.max(Number(quantity) || 1, 1), 10);
  const ref = req.body?.ref || cookies(req).lumi_ref || null;
  const codeOk = discount_code && store.db.links.some((l) => l.discount_code?.toUpperCase() === String(discount_code).trim().toUpperCase());
  const value = Math.round(product.price * qty * (codeOk ? 0.9 : 1) * 100) / 100;
  const order = attributeOrder({ discount_code: codeOk ? discount_code : null, ref, value, product_id });
  res.json({ order, discount_applied: Boolean(codeOk) });
});

// ---------- billing (simulated provider; plan changes only on the webhook) ----------

const WEBHOOK_SECRET = process.env.BILLING_WEBHOOK_SECRET || 'demo-webhook-secret';
const sign = (body) => crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

app.post('/api/billing/checkout', requireUser, (req, res) => {
  const item = req.body?.item === 'addon' ? 'addon' : 'pro';
  const cycle = req.body?.cycle === 'yearly' ? 'yearly' : 'monthly';
  if (item === 'pro' && req.user.plan === 'pro') return res.status(400).json({ error: 'already_pro' });
  if (item === 'addon' && req.user.plan !== 'pro') return res.status(400).json({ error: 'pro_only', message: 'Top-ups are for Pro users.' });
  const price = item === 'addon' ? ADDON.price : cycle === 'yearly' ? PLANS.pro.priceYearlyPerMonth * 12 : PLANS.pro.price;
  const checkout = { id: store.id('chk'), user_id: req.user.id, item, cycle, price, status: 'open', created_at: new Date().toISOString() };
  store.db.checkouts.push(checkout);
  store.save();
  res.json({ checkout });
});

// Stands in for the payment provider's hosted page: it "pays" and then calls our webhook, signed.
app.post('/api/billing/simulate-pay/:id', requireUser, async (req, res) => {
  const checkout = store.db.checkouts.find((c) => c.id === req.params.id && c.user_id === req.user.id);
  if (!checkout) return res.status(404).json({ error: 'not_found' });
  const body = JSON.stringify({ type: 'checkout.completed', checkout_id: checkout.id, paid_at: new Date().toISOString() });
  const port = req.socket.localPort;
  const r = await fetch(`http://127.0.0.1:${port}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': sign(body) },
    body,
  });
  const out = await r.json();
  res.status(r.status).json({ ...out, user: publicUser(req.user) });
});

app.post('/api/billing/webhook', express.text({ type: '*/*' }), (req, res) => {
  const raw = typeof req.body === 'string' ? req.body : '';
  if (req.get('X-Signature') !== sign(raw)) return res.status(400).json({ error: 'bad_signature' });
  let evt;
  try { evt = JSON.parse(raw); } catch { return res.status(400).json({ error: 'bad_json' }); }
  const checkout = store.db.checkouts.find((c) => c.id === evt.checkout_id);
  if (!checkout) return res.status(404).json({ error: 'unknown_checkout' });
  if (checkout.status === 'paid') return res.json({ ok: true, duplicate: true }); // webhooks can repeat
  checkout.status = 'paid';
  const user = store.db.users.find((u) => u.id === checkout.user_id);

  if (checkout.item === 'addon') {
    quota.addTopUp(user);
    store.track('addon_purchased', { user_id: user.id, price: checkout.price, credits: ADDON.generations });
    return res.json({ ok: true });
  }

  user.plan = 'pro';
  user.pro_since = new Date().toISOString();
  const sub = { id: store.id('sub'), user_id: user.id, plan: 'pro', cycle: checkout.cycle, price: checkout.price, started_at: user.pro_since, canceled_at: null };
  store.db.subscriptions.push(sub);
  const ft = user.first_touch || {};
  const event = store.track('subscription_started', {
    user_id: user.id,
    plan: 'pro',
    cycle: checkout.cycle,
    price: checkout.price,
    platform: user.platform || 'web',
    utm_source: ft.utm_source || null,
    utm_medium: ft.utm_medium || null,
    utm_campaign: ft.utm_campaign || null,
    ttclid: ft.ttclid || null,
    days_since_signup: Math.floor((Date.now() - Date.parse(user.created_at)) / 864e5),
  });
  // Server-side conversion postback (A13). Same event_id as the browser pixel so the platform de-duplicates.
  if (ft.ttclid || ft.utm_source === 'tiktok') {
    store.db.outbox.push({
      destination: 'TikTok Events API (simulated, not sent)',
      payload: {
        event: 'Subscribe',
        event_id: event.event_id,
        event_time: Math.floor(Date.now() / 1000),
        user: { email: sha256(user.email), ttclid: ft.ttclid || null },
        properties: { value: checkout.price, currency: 'USD', content_type: 'subscription' },
      },
      created_at: new Date().toISOString(),
    });
    store.save();
  }
  res.json({ ok: true, event_id: event.event_id });
});

app.post('/api/billing/cancel', requireUser, (req, res) => {
  const sub = store.db.subscriptions.find((s) => s.user_id === req.user.id && !s.canceled_at);
  if (!sub) return res.status(400).json({ error: 'no_subscription' });
  sub.canceled_at = new Date().toISOString(); // stays Pro until the period ends (demo: immediate downgrade)
  req.user.plan = 'free';
  store.track('subscription_canceled', { user_id: req.user.id, days_active: Math.floor((Date.now() - Date.parse(sub.started_at)) / 864e5) });
  res.json({ user: publicUser(req.user) });
});

// ---------- internal dashboard ----------

app.get('/api/admin/metrics', (req, res) => res.json(metrics.compute()));
app.get('/api/admin/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ events: store.db.events.slice(-limit).reverse() });
});

// Demo helper so reviewers can reach the paywall without generating 10 times.
// It only moves the counter; the limit is still enforced by the same server code.
app.post('/api/demo/use-credits', requireUser, (req, res) => {
  if (process.env.DEMO_TOOLS === 'off') return res.status(404).end();
  const st = quota.status(req.user);
  const leave = Math.max(0, Math.min(Number(req.body?.leave ?? 1), st.limit));
  req.user.quota.used = st.limit - leave;
  store.save();
  res.json({ quota: quota.status(req.user) });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error', message: 'Unexpected server error.' });
});

const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Lumi v2 running at http://localhost:${port}`);
    console.log(llm.configured() ? `Model: ${process.env.LLM_MODEL} via ${process.env.LLM_BASE_URL}` : 'No model configured: chat and generation are off. Fill in app/.env and restart.');
  });
  const bye = () => { store.flush(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = app;
