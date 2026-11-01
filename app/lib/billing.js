// Billing state (simulated payment provider). The rules a real Stripe/Paddle integration would follow:
//  - The plan changes only when the provider confirms a payment (webhook), or when a canceled period runs out.
//  - One open checkout per item. Paying a Pro checkout while already on Pro is refunded, never a second
//    subscription. A top-up paid after the user left Pro is refunded too.
//  - A checkout is payable only while it is open: it closes when paid, replaced, or after 30 minutes.
//  - Canceling keeps Pro until the paid period ends, and can be undone until then. Only then does the
//    plan go back to Free and the subscription end. sync() applies this on every request.
const store = require('./store');
const quota = require('./quota');
const { PLANS, ADDON } = require('./config');

const CHECKOUT_TTL_MS = 30 * 60 * 1000;
const DAY = 864e5;

// Same day next month (or next year), clamped: Jan 31 -> Feb 28.
function addPeriod(iso, cycle) {
  const d = new Date(iso);
  const months = cycle === 'yearly' ? 12 : 1;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
}

const activeSub = (user) => store.db.subscriptions.find((s) => s.user_id === user.id && !s.ended_at) || null;

// Brings plan and subscription in line with the clock. Safe to call on every request.
function sync(user, now = Date.now()) {
  let changed = false;
  for (const s of store.db.subscriptions.filter((x) => x.user_id === user.id && !x.ended_at)) {
    // Data from before this fix: canceled meant "ended right away".
    if (s.canceled_at && s.cancel_at_period_end === undefined) { s.ended_at = s.canceled_at; changed = true; continue; }
    if (!s.current_period_end) { s.current_period_start = s.started_at; s.current_period_end = addPeriod(s.started_at, s.cycle); changed = true; }
    while (!s.ended_at && Date.parse(s.current_period_end) <= now) {
      if (s.cancel_at_period_end) {
        s.ended_at = s.current_period_end;
        store.track('subscription_ended', { user_id: user.id, subscription_id: s.id, reason: 'canceled', days_active: Math.floor((Date.parse(s.ended_at) - Date.parse(s.started_at)) / DAY) });
      } else {
        // The provider charges the card and sends invoice.paid here. Simulated: the period just rolls on.
        s.current_period_start = s.current_period_end;
        s.current_period_end = addPeriod(s.current_period_end, s.cycle);
        store.track('subscription_renewed', { user_id: user.id, subscription_id: s.id, cycle: s.cycle, price: s.price });
      }
      changed = true;
    }
  }
  const plan = activeSub(user) ? 'pro' : 'free';
  if (user.plan !== plan) {
    const from = user.plan;
    user.plan = plan;
    quota.onPlanChange(user, from);
    changed = true;
  }
  if (changed) store.save();
  return activeSub(user);
}

function describe(user) {
  const s = activeSub(user);
  if (!s) return null;
  return {
    id: s.id,
    cycle: s.cycle,
    price: s.price,
    started_at: s.started_at,
    status: s.cancel_at_period_end ? 'canceling' : 'active',
    current_period_end: s.current_period_end,
    renews_at: s.cancel_at_period_end ? null : s.current_period_end,
    ends_at: s.cancel_at_period_end ? s.current_period_end : null,
  };
}

function closeStale(user, now = Date.now()) {
  for (const c of store.db.checkouts) {
    if (c.user_id === user.id && c.status === 'open' && now - Date.parse(c.created_at) > CHECKOUT_TTL_MS) c.status = 'expired';
  }
}

const err = (status, error, message) => ({ status, body: { error, message } });

function createCheckout(user, { item, cycle }) {
  sync(user);
  const sub = activeSub(user);
  if (item === 'pro' && sub) {
    return sub.cancel_at_period_end
      ? err(409, 'pro_canceling', 'You are still on Pro until the end of this period. Press "Keep Pro" instead of paying again.')
      : err(409, 'already_pro', 'You are already on Pro.');
  }
  if (item === 'addon' && !sub) return err(409, 'pro_only', 'Top-ups are for Pro users.');
  closeStale(user);
  const price = item === 'addon' ? ADDON.price : cycle === 'yearly' ? PLANS.pro.priceYearlyPerMonth * 12 : PLANS.pro.price;
  // One open checkout per item: pressing "Upgrade" twice gives back the same one.
  const open = store.db.checkouts.filter((c) => c.user_id === user.id && c.item === item && c.status === 'open');
  const same = open.find((c) => c.cycle === cycle);
  for (const c of open) if (c !== same) c.status = 'replaced';
  if (same) { store.save(); return { status: 200, body: { checkout: same, reused: true } }; }
  const checkout = { id: store.id('chk'), user_id: user.id, item, cycle, price, status: 'open', created_at: new Date().toISOString() };
  store.db.checkouts.push(checkout);
  store.save();
  return { status: 200, body: { checkout } };
}

// What the hosted payment page checks before taking money.
function canPay(user, checkout) {
  closeStale(user);
  sync(user);
  if (checkout.status === 'paid') return err(409, 'already_paid', 'This checkout is already paid.');
  if (checkout.status !== 'open') return err(409, 'checkout_closed', `This checkout is ${checkout.status}. Start a new one.`);
  if (checkout.item === 'pro' && activeSub(user)) return err(409, 'already_pro', 'You are already on Pro, so this checkout was not charged.');
  if (checkout.item === 'addon' && !activeSub(user)) return err(409, 'pro_only', 'Top-ups are for Pro users, so this checkout was not charged.');
  return null;
}

// The provider's "payment succeeded" webhook. Webhooks can repeat and arrive late, so this is idempotent
// and checks the user's state at payment time, not at checkout time.
function onPaid(checkoutId, { sha256 } = {}) {
  const checkout = store.db.checkouts.find((c) => c.id === checkoutId);
  if (!checkout) return err(404, 'unknown_checkout', 'Unknown checkout.');
  if (checkout.status === 'paid' || checkout.status === 'refunded') return { status: 200, body: { ok: true, duplicate: true, checkout_status: checkout.status } };
  const user = store.db.users.find((u) => u.id === checkout.user_id);
  sync(user);
  const sub = activeSub(user);

  // Money arrived that we should not keep: refund it instead of changing the plan.
  const refund = (reason) => {
    checkout.status = 'refunded';
    checkout.refund_reason = reason;
    checkout.refunded_at = new Date().toISOString();
    store.track('payment_refunded', { user_id: user.id, checkout_id: checkout.id, item: checkout.item, price: checkout.price, reason });
    store.save();
    return { status: 200, body: { ok: true, refunded: true, reason } };
  };
  if (checkout.status !== 'open') return refund(`checkout_${checkout.status}`);
  if (checkout.item === 'pro' && sub) return refund('already_pro');
  if (checkout.item === 'addon' && !sub) return refund('not_pro');

  checkout.status = 'paid';
  checkout.paid_at = new Date().toISOString();

  if (checkout.item === 'addon') {
    quota.addTopUp(user);
    store.track('addon_purchased', { user_id: user.id, price: checkout.price, credits: ADDON.generations });
    store.save();
    return { status: 200, body: { ok: true } };
  }

  const now = new Date().toISOString();
  const s = {
    id: store.id('sub'), user_id: user.id, plan: 'pro', cycle: checkout.cycle, price: checkout.price, checkout_id: checkout.id,
    started_at: now, current_period_start: now, current_period_end: addPeriod(now, checkout.cycle),
    cancel_at_period_end: false, canceled_at: null, ended_at: null,
  };
  store.db.subscriptions.push(s);
  const from = user.plan;
  user.plan = 'pro';
  if (from !== 'pro') quota.onPlanChange(user, from);
  user.pro_since = now;
  // Any other open Pro checkout (another tab, an old unpaid one) can no longer be paid.
  for (const c of store.db.checkouts) if (c.user_id === user.id && c.item === 'pro' && c.status === 'open') c.status = 'replaced';

  const ft = user.first_touch || {};
  const event = store.track('subscription_started', {
    user_id: user.id, plan: 'pro', cycle: checkout.cycle, price: checkout.price, platform: user.platform || 'web',
    utm_source: ft.utm_source || null, utm_medium: ft.utm_medium || null, utm_campaign: ft.utm_campaign || null, ttclid: ft.ttclid || null,
    days_since_signup: Math.floor((Date.now() - Date.parse(user.created_at)) / DAY),
  });
  // Server-side conversion postback (A13). Same event_id as the browser pixel so the platform de-duplicates.
  if (ft.ttclid || ft.utm_source === 'tiktok') {
    store.db.outbox.push({
      destination: 'TikTok Events API (simulated, not sent)',
      payload: {
        event: 'Subscribe',
        event_id: event.event_id,
        event_time: Math.floor(Date.now() / 1000),
        user: { email: sha256 ? sha256(user.email) : null, ttclid: ft.ttclid || null },
        properties: { value: checkout.price, currency: 'USD', content_type: 'subscription' },
      },
      created_at: now,
    });
  }
  store.save();
  return { status: 200, body: { ok: true, event_id: event.event_id } };
}

function cancel(user) {
  const sub = sync(user);
  if (!sub) return err(409, 'no_subscription', 'There is no active subscription to cancel.');
  if (!sub.cancel_at_period_end) {
    sub.cancel_at_period_end = true;
    sub.canceled_at = new Date().toISOString();
    store.track('subscription_canceled', {
      user_id: user.id, subscription_id: sub.id, ends_at: sub.current_period_end,
      days_active: Math.floor((Date.now() - Date.parse(sub.started_at)) / DAY),
    });
    store.save();
  }
  return { status: 200, body: { ok: true } };
}

function resume(user) {
  const sub = sync(user);
  if (!sub) return err(409, 'no_subscription', 'Your Pro period has already ended. Upgrade again from the Plan page.');
  if (sub.cancel_at_period_end) {
    sub.cancel_at_period_end = false;
    sub.canceled_at = null;
    store.track('subscription_resumed', { user_id: user.id, subscription_id: sub.id });
    store.save();
  }
  return { status: 200, body: { ok: true } };
}

module.exports = { sync, describe, activeSub, createCheckout, canPay, onPaid, cancel, resume, addPeriod, CHECKOUT_TTL_MS };
