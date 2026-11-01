// Builds the results view (dashboard and the get_post_performance tool share it).
// Free users are trimmed here, on the server, not hidden in the browser.
const merchant = require('../data/merchant.json');
const { PLANS } = require('./config');
const store = require('./store');

const productName = (pid) => merchant.products.find((p) => p.id === pid)?.name || pid;
const DAY = 864e5;

// Windows are measured back from the mock history's "today", so the demo reads the same whenever it runs.
// Posts written in the demo are dated with the real clock and always fall inside the window.
const asOf = () => Date.parse(process.env.DEMO_AS_OF || merchant.as_of || new Date().toISOString().slice(0, 10)) + DAY - 1;
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const channelLabel = (c) => ({ tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook', email: 'Email' }[c] || c);
const orders = (n) => `${n} order${n === 1 ? '' : 's'}`;

function livePosts(user) {
  const { db } = store;
  return db.posts
    .filter((p) => p.user_id === user.id)
    .map((p) => {
      const clicks = db.clicks.filter((c) => c.post_id === p.id && c.unique && !c.is_bot).length;
      const orders = db.orders.filter((o) => o.post_id === p.id);
      return {
        id: p.id,
        date: p.created_at.slice(0, 10),
        channel: p.channel,
        product_id: p.product_id,
        angle: p.angle,
        caption: p.chosen_caption || p.variants?.[0]?.caption || '',
        impressions: null, // needs the IG / TikTok API (P2)
        clicks,
        orders: orders.length,
        revenue: Math.round(orders.reduce((s, o) => s + o.value, 0) * 100) / 100,
        link: p.link_code,
        discount_code: p.discount_code,
        published: Boolean(p.published_at),
        live: true,
      };
    });
}

// A post counts once the merchant says it is posted, or once it gets a click (they may forget to press the button).
const counts = (p) => !p.live || p.published || p.clicks > 0 || p.orders > 0;

function allPosts(user) {
  const history = merchant.posts.map((p) => ({ ...p, live: false }));
  return [...history, ...livePosts(user)].sort((a, b) => b.date.localeCompare(a.date) || (b.live - a.live));
}

function summarize(posts) {
  const n = posts.length;
  const sum = (k) => posts.reduce((s, p) => s + (p[k] || 0), 0);
  return {
    posts: n,
    clicks: sum('clicks'),
    orders: sum('orders'),
    revenue: sum('revenue'),
    avg_orders_per_post: n ? Math.round((sum('orders') / n) * 10) / 10 : 0,
    // Precomputed so the model quotes these instead of doing its own division
    avg_order_value: sum('orders') ? Math.round(sum('revenue') / sum('orders')) : 0,
    revenue_per_post: n ? Math.round(sum('revenue') / n) : 0,
  };
}

function groupBy(posts, key) {
  const groups = {};
  for (const p of posts) (groups[p[key]] ||= []).push(p);
  return Object.entries(groups)
    .map(([k, list]) => ({ [key]: k, ...summarize(list) }))
    .sort((a, b) => b.avg_orders_per_post - a.avg_orders_per_post);
}

function decorate(p, avgOrders) {
  // A brand-new post with no clicks yet has no comparison, rather than showing -100%.
  const waiting = p.live && !p.clicks && !p.orders;
  const vs = !waiting && avgOrders && p.orders != null ? Math.round(((p.orders - avgOrders) / avgOrders) * 100) : null;
  return {
    ...p,
    product: productName(p.product_id),
    angle_label: merchant.angles[p.angle] || p.angle,
    vs_average_pct: vs,
  };
}

// opts: { sort_by, group_by, days, limit }
function build(user, opts = {}) {
  const plan = PLANS[user.plan];
  let posts = allPosts(user).filter(counts);
  if (opts.days) {
    const cutoff = dayStr(asOf() - opts.days * DAY);
    posts = posts.filter((p) => p.date > cutoff);
  }
  const overall = summarize(posts);
  const avg = overall.avg_orders_per_post;
  const totalPosts = posts.length;

  if (Number.isFinite(plan.resultsVisiblePosts)) {
    const visible = posts.slice(0, plan.resultsVisiblePosts).map((p) => decorate(p, null));
    return {
      plan: user.plan,
      locked: true,
      locked_reason: `Free plan shows results for your latest post only. Upgrade to Pro to see all ${totalPosts} posts, rankings and what works best.`,
      total_posts: totalPosts,
      posts: visible,
    };
  }

  const sortKey = ['orders', 'revenue', 'clicks', 'date'].includes(opts.sort_by) ? opts.sort_by : 'date';
  const sorted = [...posts].sort((a, b) =>
    sortKey === 'date' ? b.date.localeCompare(a.date) : (b[sortKey] || 0) - (a[sortKey] || 0));
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 50);
  const out = {
    plan: user.plan,
    locked: false,
    total_posts: totalPosts,
    overall,
    posts: sorted.slice(0, limit).map((p) => decorate(p, avg)),
  };
  if (['angle', 'channel', 'product_id'].includes(opts.group_by)) {
    out.groups = groupBy(posts, opts.group_by).map((g) =>
      opts.group_by === 'angle' ? { ...g, angle_label: merchant.angles[g.angle] }
        : opts.group_by === 'product_id' ? { ...g, product: productName(g.product_id) } : g);
  }
  return out;
}

// One call that answers most "how am I doing" questions: totals against the previous period,
// rankings by angle, channel and product, the top posts, and plain-language findings.
// The assistant and the home page both read this, so they always tell the same story.
function summary(user, { days = 30 } = {}) {
  const span = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const end = asOf();
  const cutoff = dayStr(end - span * DAY);
  const prevCutoff = dayStr(end - 2 * span * DAY);
  const all = allPosts(user);
  // Drafts that were never published have no audience yet, so they stay out of the numbers.
  const counted = all.filter(counts);
  const current = counted.filter((p) => p.date > cutoff);
  const previous = counted.filter((p) => p.date > prevCutoff && p.date <= cutoff);
  const now = summarize(current);
  const before = summarize(previous);
  const change = (k) => (before[k] ? Math.round(((now[k] - before[k]) / before[k]) * 100) : null);
  const waiting = all.filter((p) => p.live && p.published && !p.clicks && !p.orders)
    .map((p) => ({ id: p.id, product: productName(p.product_id), channel: p.channel, date: p.date }));

  if (Number.isFinite(PLANS[user.plan].resultsVisiblePosts)) {
    // No comparison to the average on Free: the average is built from the posts Free cannot see.
    const latest = counted.slice(0, 1).map((p) => ({ ...decorate(p, null), vs_average_pct: null }));
    return {
      plan: user.plan,
      locked: true,
      period_days: span,
      latest_post: latest[0] || null,
      total_posts: counted.length,
      hidden_posts: Math.max(0, counted.length - 1),
      waiting_for_first_click: waiting,
      locked_reason: `Free shows results for your latest post only. Results for the other ${Math.max(0, counted.length - 1)} posts (all time), totals and rankings are on Pro.`,
    };
  }

  const label = (key, v) => (key === 'angle' ? merchant.angles[v] || v : key === 'product_id' ? productName(v) : channelLabel(v));
  const ranked = (key) => groupBy(current, key).map((g) => ({ name: label(key, g[key]), key: g[key], ...g }))
    .map(({ angle, channel, product_id, ...g }) => g);
  const byAngle = ranked('angle');
  const byChannel = ranked('channel');
  const byProduct = groupBy(current, 'product_id')
    .map((g) => ({ name: productName(g.product_id), key: g.product_id, stock: merchant.products.find((p) => p.id === g.product_id)?.stock ?? null, ...g }))
    .map(({ product_id, ...g }) => g)
    .sort((a, b) => b.revenue_per_post - a.revenue_per_post);
  const top = [...current].sort((a, b) => b.orders - a.orders || b.revenue - a.revenue).slice(0, 3).map((p) => decorate(p, now.avg_orders_per_post));

  const findings = [];
  const times = (g) => (now.avg_orders_per_post ? Math.round((g.avg_orders_per_post / now.avg_orders_per_post) * 10) / 10 : null);
  if (byAngle.length > 1) findings.push(`${byAngle[0].name} posts bring ${orders(byAngle[0].avg_orders_per_post)} each, ${times(byAngle[0])}x the average of ${now.avg_orders_per_post}.`);
  if (byChannel.length > 1) findings.push(`${byChannel[0].name} brings ${orders(byChannel[0].avg_orders_per_post)} per post; ${byChannel.at(-1).name} brings ${byChannel.at(-1).avg_orders_per_post}.`);
  if (byProduct[0]) findings.push(`${byProduct[0].name} earns the most per post: $${byProduct[0].revenue_per_post}.`);
  const weakest = byAngle.at(-1);
  if (weakest && byAngle.length > 2) findings.push(`${weakest.name} posts bring the least: ${orders(weakest.avg_orders_per_post)} each.`);

  return {
    plan: user.plan,
    locked: false,
    period_days: span,
    totals: now,
    previous_period: before,
    change_pct: { orders: change('orders'), revenue: change('revenue'), clicks: change('clicks') },
    by_angle: byAngle,
    by_channel: byChannel,
    by_product: byProduct,
    top_posts: top,
    findings,
    waiting_for_first_click: waiting,
  };
}

// Next post to write: the best-earning product that is in stock, with the angle that sells best overall.
function recommend(user) {
  const s = summary(user, { days: 90 });
  if (s.locked) return null;
  const product = s.by_product.find((p) => (p.stock ?? 1) > 10) || s.by_product[0];
  const angle = s.by_angle[0];
  const channelOf = (pid) => {
    const posts = allPosts(user).filter((p) => p.product_id === pid && p.angle === angle?.key);
    return posts.sort((a, b) => b.orders - a.orders)[0]?.channel || s.by_channel[0]?.key || 'instagram';
  };
  if (!product || !angle) return null;
  return {
    product_id: product.key,
    product: product.name,
    angle: angle.key,
    angle_label: angle.name,
    channel: channelOf(product.key),
    reason: `${product.name} earns $${product.revenue_per_post} per post and has ${product.stock} in stock. ${angle.name} posts bring ${angle.avg_orders_per_post} orders each.`,
  };
}

module.exports = { build, allPosts, counts, productName, summary, recommend, asOf };
