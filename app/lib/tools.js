// Tools the agent can call. The model decides which to call (tool_choice: "auto");
// there is no keyword routing anywhere in the app.
// Tools follow what the merchant is trying to do (check results, plan a post, write it, fix it, get a link),
// not the tables underneath. The catalog is small and goes in the system prompt instead of a tool.
// Each tool returns { result, card }: result goes back to the model, card is drawn in the chat UI.
// Spending a credit is not a model tool: generate_post below runs only when the merchant presses the
// button on a proposal card (server.js -> agent.chat with context.pressed).
const merchant = require('../data/merchant.json');
const performance = require('./performance');
const proposals = require('./proposals');
const quota = require('./quota');
const store = require('./store');
const { PLANS } = require('./config');
const { generatePost, revisePost, CHANNELS, LINK_IN_TEXT } = require('./generate');
const { createLink } = require('./links');

const ANGLES = Object.keys(merchant.angles);
const PRODUCT_IDS = merchant.products.map((p) => p.id);
const PLACEMENTS = ['bio', 'story', 'email', 'ads'];

const fail = (code, message) => Object.assign(new Error(message), { code });
const productOrFail = (id) => {
  const p = merchant.products.find((x) => x.id === id);
  if (!p) throw fail('bad_input', `Unknown product_id "${id}". Use one of: ${PRODUCT_IDS.join(', ')}.`);
  return p;
};
const channelName = (c) => ({ instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', email: 'Email' }[c] || c);

const definitions = [
  {
    type: 'function',
    function: {
      name: 'get_results_summary',
      description: 'How the shop\'s posts are doing: orders, revenue and clicks against the previous period, which angles, channels and products sell best, the top posts, and plain findings. Use it for any "how am I doing / what works / what should I post" question.',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', enum: [7, 30, 90], description: 'Period length. Default 30.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_post',
      description: 'One post in detail: its caption, channel, angle, clicks, orders and revenue, and how it compares to the average. Omit post_id for the latest post.',
      parameters: {
        type: 'object',
        properties: { post_id: { type: 'string', description: 'A post id such as "h7" or "post_..."' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_reviews',
      description: 'Up to 5 real customer review quotes for a product, optionally about one topic (e.g. "gift", "warm", "size"). Use before quoting what customers say.',
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'string', enum: PRODUCT_IDS },
          topic: { type: 'string', description: 'Optional word or short phrase to look for' },
        },
        required: ['product_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_post',
      description: 'Suggest one post to write: product, channel and angle, with the reason. Costs nothing: the merchant sees a card with a "Write 3 versions · 1 credit" button, and Lumi writes the post when they press it. This is the only way to get a post written. After calling it, stop.',
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'string', enum: PRODUCT_IDS },
          channel: { type: 'string', enum: CHANNELS },
          angle: { type: 'string', enum: ANGLES },
          reason: { type: 'string', description: 'One sentence the merchant will read, citing numbers from get_results_summary when available' },
        },
        required: ['product_id', 'channel', 'angle', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'revise_post',
      description: 'Rewrite one version of a post that was already written, following the merchant\'s instruction (shorter, warmer, mention free shipping...). No credit.',
      parameters: {
        type: 'object',
        properties: {
          post_id: { type: 'string' },
          variant: { type: 'integer', minimum: 1, maximum: 3, description: 'Version number as the merchant sees it: 1, 2 or 3' },
          instruction: { type: 'string' },
        },
        required: ['post_id', 'variant', 'instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_tracked_link',
      description: 'A tracked short link with its own discount code for one product, for a place a caption cannot hold a link: Instagram or TikTok bio, a story link sticker, an email or an ad. No credit.',
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'string', enum: PRODUCT_IDS },
          channel: { type: 'string', enum: CHANNELS },
          placement: { type: 'string', enum: PLACEMENTS },
        },
        required: ['product_id', 'channel', 'placement'],
      },
    },
  },
];

const postCard = (user, post, extra = {}) => ({
  type: 'post',
  post: { ...post, product: performance.productName(post.product_id), channel_label: channelName(post.channel) },
  link_in_caption: LINK_IN_TEXT.has(post.channel),
  quota: quota.status(user),
  ...extra,
});

const handlers = {
  get_results_summary({ days = 30 } = {}, { user }) {
    const s = performance.summary(user, { days });
    if (!PLANS[user.plan].weeklyReview || s.locked) {
      const result = {
        plan: user.plan,
        locked: true,
        period_days: s.period_days,
        latest_post: s.latest_post,
        note: 'Free plan: only the latest post is visible. Upgrade to Pro for the full weekly review, totals and rankings.',
      };
      return { result, card: { type: 'summary', ...result, total_posts: s.total_posts } };
    }
    // The model gets the rankings trimmed to what it needs to answer; the card shows the headline.
    const pick = (list) => list.map(({ name, posts, orders, revenue, avg_orders_per_post, revenue_per_post, stock }) =>
      ({ name, posts, orders, revenue, avg_orders_per_post, revenue_per_post, ...(stock != null ? { stock } : {}) }));
    const result = {
      period_days: s.period_days,
      totals: s.totals,
      previous_period: { posts: s.previous_period.posts, orders: s.previous_period.orders, revenue: s.previous_period.revenue },
      change_pct: s.change_pct,
      by_angle: pick(s.by_angle),
      by_channel: pick(s.by_channel),
      by_product: pick(s.by_product),
      top_posts: s.top_posts.map((p) => ({ id: p.id, date: p.date, product: p.product, channel: p.channel, angle: p.angle_label, orders: p.orders, revenue: p.revenue })),
      findings: s.findings,
      waiting_for_first_click: s.waiting_for_first_click,
    };
    return { result, card: { type: 'summary', ...s } };
  },

  get_post({ post_id } = {}, { user }) {
    const visible = performance.allPosts(user).filter(performance.counts);
    const latest = visible[0];
    const s = performance.summary(user, { days: 90 });
    if (!latest) throw fail('not_found', 'No posts yet.');
    if (s.locked && post_id && post_id !== latest?.id) {
      const result = {
        id: latest.id,
        date: latest.date,
        product: performance.productName(latest.product_id),
        channel: latest.channel,
        angle: merchant.angles[latest.angle] || latest.angle,
        caption: latest.caption,
        published: !latest.live || latest.published,
        clicks: latest.clicks,
        orders: latest.orders,
        revenue: latest.revenue,
        locked: true,
        note: 'Free plan shows results for the latest post only. Upgrade to Pro to inspect older posts and the full weekly review.',
      };
      return { result, card: { type: 'post_result', post: result } };
    }
    const post = post_id ? performance.allPosts(user).find((p) => p.id === post_id) : latest;
    if (!post) throw fail('not_found', `No post with id "${post_id}".`);
    const base = {
      id: post.id,
      date: post.date,
      product: performance.productName(post.product_id),
      channel: post.channel,
      angle: merchant.angles[post.angle] || post.angle,
      caption: post.caption,
      published: !post.live || post.published,
    };
    const avg = s.locked ? null : s.totals.avg_orders_per_post;
    const waiting = post.live && !post.clicks && !post.orders;
    // For posts written in Lumi we know how each order was matched; the imported history only has totals.
    const matched = post.live ? store.db.orders.filter((o) => o.post_id === post.id) : null;
    const result = {
      ...base,
      orders_matched_by: matched ? {
        discount_code: matched.filter((o) => o.attribution_method === 'discount_code').length,
        tracked_click: matched.filter((o) => o.attribution_method !== 'discount_code').length,
      } : null,
      clicks: post.clicks,
      orders: post.orders,
      revenue: post.revenue,
      shop_avg_orders_per_post: avg,
      vs_average_pct: !waiting && avg ? Math.round(((post.orders - avg) / avg) * 100) : null,
      waiting_for_first_click: waiting,
    };
    return { result, card: { type: 'post_result', post: result } };
  },

  find_reviews({ product_id, topic } = {}) {
    const product = productOrFail(product_id);
    const all = merchant.reviews.filter((r) => r.product_id === product_id);
    const words = String(topic || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const matches = words.length ? all.filter((r) => words.some((w) => r.text.toLowerCase().includes(w))) : [];
    const list = (matches.length ? matches : all).sort((a, b) => b.rating - a.rating || b.date.localeCompare(a.date)).slice(0, 5);
    const result = {
      product: product.name,
      rating: product.rating,
      review_count: product.review_count,
      topic: topic || null,
      matched_topic: words.length ? matches.length > 0 : null,
      quotes: list.map((r) => ({ rating: r.rating, date: r.date, quote: r.text })),
    };
    return { result, card: { type: 'reviews', ...result } };
  },

  propose_post({ product_id, channel, angle, reason } = {}, { user }) {
    const product = productOrFail(product_id);
    if (!CHANNELS.includes(channel)) throw fail('bad_input', `channel must be one of ${CHANNELS.join(', ')}.`);
    if (!merchant.angles[angle]) throw fail('bad_input', `angle must be one of ${ANGLES.join(', ')}.`);
    const p = proposals.create(user, { product_id, channel, angle, reason });
    const q = quota.status(user);
    return {
      result: {
        proposal_id: p.id,
        status: 'waiting_for_merchant',
        credits_left: q.left,
        next: 'The merchant now sees this proposal as a card with a "Write 3 versions · 1 credit" button. End your turn with one or two short sentences in the language the merchant wrote in. Lumi writes the post when they press the button.',
      },
      card: {
        type: 'proposal',
        proposal: {
          id: p.id, status: p.status, product_id, product: product.name, price: product.price, stock: product.stock,
          channel, channel_label: channelName(channel), angle, angle_label: merchant.angles[angle], reason: p.reason,
        },
        quota: q,
      },
      stopAfter: true,
    };
  },

  // Not offered to the model. The server runs it when the merchant presses the proposal button.
  async generate_post({ proposal_id, notes } = {}, { user }) {
    const p = proposals.find(user, proposal_id);
    if (!p) throw fail('not_found', `No proposal "${proposal_id}". Call propose_post first.`);
    if (p.status === 'used') throw fail('already_written', `This proposal was already written as post ${p.post_id}. Use revise_post to change it.`);
    if (p.status === 'writing') throw fail('in_progress', 'This post is being written right now.');
    if (p.status !== 'accepted') {
      throw fail('needs_confirmation', 'The merchant has not pressed "Write 3 versions" on this proposal. Only the button writes a post.');
    }
    p.status = 'writing';
    try {
      const { post, quota: q } = await generatePost(user, { product_id: p.product_id, channel: p.channel, angle: p.angle, notes }, { trigger: 'agent' });
      p.status = 'used';
      p.post_id = post.id;
      store.save();
      return {
        result: {
          post_id: post.id,
          channel: post.channel,
          tracked_link: post.link_url,
          link_goes: LINK_IN_TEXT.has(post.channel) ? 'in the caption' : 'in the bio or a story link sticker (captions on this channel cannot hold links)',
          discount_code: post.discount_code,
          variants: post.variants.map((v, i) => ({ version: i + 1, label: v.label, caption: v.caption })),
          credits_left: q.left,
        },
        card: postCard(user, post, { proposal_id: p.id }),
      };
    } catch (err) {
      // Nothing was written, so the merchant can press the button again (after upgrading, if that was the reason).
      p.status = 'proposed';
      store.save();
      throw err;
    }
  },

  async revise_post({ post_id, variant = 1, instruction } = {}, { user }) {
    if (!String(instruction || '').trim()) throw fail('bad_input', 'Say what to change.');
    const { post, variant: i } = await revisePost(user, { post_id, variant: Number(variant) - 1, instruction });
    const v = post.variants[i];
    store.track('post_revised', { user_id: user.id, plan: user.plan, post_id, variant: i + 1 });
    return {
      result: { post_id, version: i + 1, caption: v.caption, hashtags: v.hashtags },
      card: postCard(user, post, { highlight: i }),
    };
  },

  create_tracked_link({ product_id, channel = 'instagram', placement = 'bio' } = {}, { user }) {
    const product = productOrFail(product_id);
    if (!CHANNELS.includes(channel)) channel = 'instagram';
    if (!PLACEMENTS.includes(placement)) placement = 'bio';
    const link = createLink(user, { product_id, channel, placement, withCode: true });
    const out = { url: link.url, discount_code: link.discount_code, product: product.name, channel, channel_label: channelName(channel), placement };
    return { result: out, card: { type: 'link', ...out } };
  },
};

const OFFERED = new Set(definitions.map((d) => d.function.name));

// ctx.byServer is set only for the proposal button. A model asking for a tool it was not offered
// (generate_post, say, remembered from an old chat) gets "unknown tool".
async function run(name, args, ctx) {
  const handler = handlers[name];
  if (!handler || (!OFFERED.has(name) && !ctx.byServer)) throw fail('unknown_tool', `Unknown tool "${name}"`);
  return handler(args, ctx);
}

module.exports = { definitions, run };
