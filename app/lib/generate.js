// One generation = 3 caption variants for one product, channel and angle. Costs 1 credit.
// Flow: reserve credit -> call model -> validate JSON -> create post + tracked link -> commit.
// Any failure refunds the credit.
const merchant = require('../data/merchant.json');
const llm = require('./llm');
const quota = require('./quota');
const store = require('./store');
const { createLink } = require('./links');
const performance = require('./performance');

const CHANNELS = ['instagram', 'tiktok', 'facebook', 'email'];

class QuotaError extends Error {
  constructor(status) {
    super('quota_exceeded');
    this.code = 'quota_exceeded';
    this.status = status;
  }
}

function bestAngles(user) {
  const posts = performance.allPosts(user);
  const by = {};
  for (const p of posts) (by[p.angle] ||= []).push(p.orders);
  return Object.entries(by)
    .map(([angle, o]) => ({ angle, avg_orders: Math.round((o.reduce((a, b) => a + b, 0) / o.length) * 10) / 10, posts: o.length }))
    .sort((a, b) => b.avg_orders - a.avg_orders)
    .slice(0, 3);
}

// Links in Instagram and TikTok captions are not clickable, so there the discount code carries attribution
// and the tracked link goes in the bio or a story link sticker. Facebook and email links work in the text.
const LINK_IN_TEXT = new Set(['facebook', 'email']);

function linkRules(channel) {
  return LINK_IN_TEXT.has(channel)
    ? ['- Every caption must contain the placeholders {LINK} and {CODE} exactly once each. {CODE} gives 10% off.']
    : ['- Every caption must contain the placeholder {CODE} exactly once. {CODE} gives 10% off.',
      `- Links are not clickable in ${channel === 'tiktok' ? 'TikTok' : 'Instagram'} captions: never write a URL or {LINK}. You may say "link in bio".`];
}

function buildPrompt(user, product, channel, angle, notes) {
  const reviews = merchant.reviews.filter((r) => r.product_id === product.id && r.rating >= 4).slice(0, 4);
  const angleLabel = merchant.angles[angle] || angle;
  return [
    {
      role: 'system',
      content: [
        `You write social media posts for ${merchant.merchant.name}, ${merchant.merchant.category} (${merchant.merchant.location}).`,
        `Brand voice: ${merchant.merchant.brand_voice}`,
        'Rules:',
        '- Use only the facts provided below. Never invent prices, discounts, stock numbers, awards or reviews.',
        ...linkRules(channel),
        '- Write in English. Keep captions under 60 words for TikTok and under 90 words for Instagram.',
        '- Return JSON only, no markdown, in this shape:',
        '{"variants":[{"label":"short name of the approach","hook":"first line","caption":"full caption","hashtags":["#tag"]}]}',
        '- Return exactly 3 variants that differ in approach.',
        '- "caption" is the complete post exactly as published: it starts with the hook line and stands on its own. If it refers to a customer review, quote the review word for word inside the caption.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: `Write 3 ${channel} post variants using the "${angleLabel}" angle.`,
        product: { name: product.name, price_usd: product.price, selling_points: product.selling_points, stock: product.stock },
        customer_reviews: reviews.map((r) => r.text),
        what_worked_for_this_shop: bestAngles(user),
        merchant_notes: notes || null,
      }),
    },
  ];
}

function parseVariants(text) {
  const data = llm.extractJson(text);
  if (!data || !Array.isArray(data.variants) || data.variants.length !== 3) return null;
  const variants = data.variants.filter((v) => v && typeof v.caption === 'string' && v.caption.trim());
  if (variants.length !== 3) return null;
  const captions = new Set(variants.map((v) => v.caption.trim().replace(/\s+/g, ' ').toLowerCase()));
  return captions.size === 3 ? variants : null;
}

function fill(text, link, channel) {
  let out = text.replaceAll('{CODE}', link.discount_code);
  if (LINK_IN_TEXT.has(channel)) {
    out = out.replaceAll('{LINK}', link.url);
    if (!out.includes(link.url)) out += `\n${link.url}`;
  } else {
    // A model that writes a URL anyway would publish a dead link; swap it for the bio pointer.
    out = out.replaceAll('{LINK}', 'link in bio').replace(/https?:\/\/\S+/g, 'link in bio');
  }
  if (!out.includes(link.discount_code)) out += `\nUse code ${link.discount_code} for 10% off.`;
  return out;
}

async function generatePost(user, { product_id, channel = 'instagram', angle = 'behind_the_scenes', notes }, meta = {}) {
  const product = merchant.products.find((p) => p.id === product_id);
  if (!product) throw Object.assign(new Error(`Unknown product_id "${product_id}".`), { code: 'bad_input' });
  if (!CHANNELS.includes(channel)) channel = 'instagram';
  if (!merchant.angles[angle]) angle = 'behind_the_scenes';

  const reservation = quota.reserve(user);
  if (!reservation.ok) {
    store.track('quota_exceeded', { user_id: user.id, plan: user.plan, limit: reservation.limit, used: reservation.used, trigger: meta.trigger || 'generate' });
    throw new QuotaError(reservation);
  }

  const started = Date.now();
  let attempts = 0;
  try {
    let variants = null;
    while (!variants && attempts < 2) {
      attempts += 1;
      const text = await llm.completeJson({ messages: buildPrompt(user, product, channel, angle, notes), plan: user.plan });
      variants = parseVariants(text);
    }
    if (!variants) throw Object.assign(new Error('The model did not return exactly 3 distinct, valid versions after two attempts. No credit was used.'), { code: 'bad_output' });

    const postId = store.id('post');
    const link = createLink(user, { product_id, channel, post_id: postId });
    const post = {
      id: postId,
      user_id: user.id,
      product_id,
      channel,
      angle,
      variants: variants.map((v) => ({
        label: String(v.label || '').slice(0, 40),
        hook: String(v.hook || ''),
        caption: fill(String(v.caption), link, channel),
        hashtags: Array.isArray(v.hashtags) ? v.hashtags.slice(0, 8).map(String) : [],
      })),
      link_code: link.code,
      link_url: link.url,
      discount_code: link.discount_code,
      created_at: new Date().toISOString(),
    };
    store.db.posts.push(post);
    const q = quota.commit(user);
    store.track('post_generated', {
      user_id: user.id, plan: user.plan, post_id: postId, product_id, channel, angle,
      success: true, attempts, latency_ms: Date.now() - started, model: llm.modelFor(user.plan),
      quota_used: q.used, quota_left: q.left, trigger: meta.trigger || 'generate',
    });
    return { post, quota: q };
  } catch (err) {
    const q = quota.refund(user);
    store.track('post_generated', {
      user_id: user.id, plan: user.plan, product_id, channel, angle,
      success: false, error: err.code || 'error', attempts, latency_ms: Date.now() - started,
      model: llm.modelFor(user.plan), quota_used: q.used, quota_left: q.left, trigger: meta.trigger || 'generate',
    });
    throw err;
  }
}

// Rewrites one version of a post the merchant already paid for. Free: changing a draft is not a new post.
async function revisePost(user, { post_id, variant = 0, instruction }) {
  const post = store.db.posts.find((p) => p.id === post_id && p.user_id === user.id);
  if (!post) throw Object.assign(new Error(`Unknown post_id "${post_id}".`), { code: 'bad_input' });
  const i = Math.min(Math.max(Number(variant) || 0, 0), post.variants.length - 1);
  const link = store.db.links.find((l) => l.code === post.link_code);
  const current = post.variants[i];
  const original = current.caption.replaceAll(link.discount_code, '{CODE}').replaceAll(link.url, '{LINK}');
  const messages = [
    {
      role: 'system',
      content: [
        `You edit social media captions for ${merchant.merchant.name}. Brand voice: ${merchant.merchant.brand_voice}`,
        '- Apply the instruction and keep everything else. Never invent prices, discounts, stock numbers or reviews.',
        ...linkRules(post.channel),
        '- Return JSON only: {"caption":"full caption","hashtags":["#tag"]}',
      ].join('\n'),
    },
    { role: 'user', content: JSON.stringify({ caption: original, hashtags: current.hashtags, instruction: String(instruction || '').slice(0, 500) }) },
  ];
  const text = await llm.completeJson({ messages, plan: user.plan });
  const data = llm.extractJson(text);
  if (!data || typeof data.caption !== 'string' || !data.caption.trim()) {
    throw Object.assign(new Error('The model returned an unreadable rewrite. Nothing changed.'), { code: 'bad_output' });
  }
  post.variants[i] = {
    ...current,
    caption: fill(data.caption, link, post.channel),
    hashtags: Array.isArray(data.hashtags) ? data.hashtags.slice(0, 8).map(String) : current.hashtags,
    revised: (current.revised || 0) + 1,
  };
  store.save();
  return { post, variant: i };
}

module.exports = { generatePost, revisePost, QuotaError, CHANNELS, LINK_IN_TEXT };
