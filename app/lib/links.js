// Tracked short links and per-post discount codes, plus click and order attribution.
const crypto = require('crypto');
const { ATTRIBUTION } = require('./config');
const store = require('./store');

const baseUrl = () => (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const rand = (n) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n).toUpperCase();

function createLink(user, { product_id, channel, post_id = null, placement = null, withCode = true }) {
  const { db } = store;
  let code;
  do code = rand(6).toLowerCase(); while (db.links.some((l) => l.code === code));
  let discount = null;
  if (withCode) {
    do discount = `JC-${rand(4)}`; while (db.links.some((l) => l.discount_code === discount));
  }
  const link = {
    code,
    url: `${baseUrl()}/r/${code}`,
    user_id: user.id,
    post_id,
    product_id,
    channel,
    placement: placement || (post_id ? 'caption' : null),
    discount_code: discount,
    utm: { utm_source: channel, utm_medium: placement === 'email' ? 'email' : placement === 'ads' ? 'paid' : 'social', utm_campaign: 'lumi', utm_content: post_id || code },
    created_at: new Date().toISOString(),
  };
  db.links.push(link);
  store.track('tracked_link_created', {
    user_id: user.id,
    plan: user.plan,
    link_id: code,
    post_id,
    product_id,
    channel,
    placement: placement || (post_id ? 'caption' : null),
    discount_code: discount,
  });
  return link;
}

const visitorHash = (ip, ua) => crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 16);

// Called by the /r/:code redirect. Unique = first click from this visitor in 24h; bots never count.
function recordClick(link, { ip, ua, referrer }) {
  const { db } = store;
  const visitor = visitorHash(ip, ua);
  const is_bot = ATTRIBUTION.botPattern.test(ua || '');
  const since = Date.now() - ATTRIBUTION.clickDedupeHours * 3600e3;
  const unique = !is_bot && !db.clicks.some((c) =>
    c.link_code === link.code && c.visitor === visitor && Date.parse(c.ts) > since);
  const click = {
    link_code: link.code,
    post_id: link.post_id,
    visitor,
    is_bot,
    unique,
    referrer: referrer || null,
    ts: new Date().toISOString(),
  };
  db.clicks.push(click);
  store.track('tracked_link_click', {
    user_id: link.user_id,
    link_id: link.code,
    post_id: link.post_id,
    channel: link.channel,
    unique,
    is_bot,
    referrer: click.referrer,
  });
  return click;
}

// Discount code wins. Otherwise last click on a tracked link within 30 days.
// One order is attributed to one post at most. Attribution is only valid when
// the tracked link promoted the product that was actually purchased.
function attributeOrder({ order_id, discount_code, ref, value, product_id }) {
  const { db } = store;
  if (order_id) {
    const existing = db.orders.find((o) => o.order_id === order_id);
    if (existing) return { order: existing, replayed: true };
  }
  let link = null;
  let method = null;
  if (discount_code) {
    link = db.links.find((l) => l.product_id === product_id
      && l.discount_code
      && l.discount_code.toUpperCase() === String(discount_code).trim().toUpperCase());
    if (link) method = 'discount_code';
  }
  if (!link && ref) {
    const candidate = db.links.find((l) => l.code === ref && l.product_id === product_id);
    const lastClick = [...db.clicks].reverse().find((c) => c.link_code === ref && !c.is_bot);
    if (candidate && lastClick && Date.now() - Date.parse(lastClick.ts) < ATTRIBUTION.orderWindowDays * 864e5) {
      link = candidate;
      method = 'last_click';
    }
  }
  const order = {
    order_id: order_id || store.id('ord'),
    value,
    product_id,
    discount_code: discount_code || null,
    link_code: link?.code || null,
    post_id: link?.post_id || null,
    user_id: link?.user_id || null,
    attribution_method: method,
    ts: new Date().toISOString(),
  };
  db.orders.push(order);
  if (link) {
    store.track('order_attributed', {
      user_id: link.user_id,
      order_id: order.order_id,
      link_id: link.code,
      post_id: link.post_id,
      order_value: value,
      attribution_method: method,
    });
  } else {
    store.save();
  }
  return { order, replayed: false };
}

module.exports = { createLink, recordClick, attributeOrder, baseUrl };
