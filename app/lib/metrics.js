// Metrics for the internal dashboard (admin.html). Definitions match Part A (A4) and the PRD.
const store = require('./store');

const DAY = 864e5;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const sourceOf = (touch) => (touch && touch.utm_source) || (touch && touch.ttclid ? 'tiktok' : null);

function compute(now = Date.now()) {
  const { db } = store;
  const ev = (name) => db.events.filter((e) => e.name === name);
  const users = db.users;
  const pro = users.filter((u) => u.plan === 'pro');

  // A4 month 1: share of Pro (seed) users whose tracked post got a real click within 7 days of upgrading.
  const m1Hits = pro.filter((u) => {
    const since = Date.parse(u.pro_since || u.created_at);
    const links = new Set(db.links.filter((l) => l.user_id === u.id && l.post_id).map((l) => l.code));
    return db.clicks.some((c) => {
      const clickedAt = Date.parse(c.ts);
      return links.has(c.link_code) && c.unique && !c.is_bot
        && clickedAt >= since && clickedAt <= since + 7 * DAY && clickedAt <= now;
    });
  }).length;

  // A4 month 2: new paid users on v2 in the current UTC calendar month.
  const subsStarted = ev('subscription_started').filter((e) => e.plan === 'pro');
  const clock = new Date(now);
  const monthStart = Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), 1);
  const nextMonthStart = Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth() + 1, 1);
  const month2Starts = subsStarted.filter((e) => {
    const startedAt = Date.parse(e.ts);
    return startedAt >= monthStart && startedAt < nextMonthStart && startedAt <= now;
  });

  // A4 month 3: 30-day paid retention of matured cohorts.
  const matured = db.subscriptions.filter((s) => now - Date.parse(s.started_at) >= 30 * DAY);
  const retained = matured.filter((s) => {
    const endedAt = Date.parse(s.ended_at);
    if (Number.isFinite(endedAt) && endedAt <= now) return false;
    const periodEnd = Date.parse(s.current_period_end);
    return !(s.cancel_at_period_end && Number.isFinite(periodEnd) && periodEnd <= now);
  });

  // Leading indicator and stop signal: weekly results-page open rate among Pro users (stop if < 30%).
  const weekAgo = now - 7 * DAY;
  const resultsReports = new Set(['dashboard', 'weekly_review']);
  const viewers = new Set(ev('report_viewed').filter((e) => {
    const viewedAt = Date.parse(e.ts);
    return viewedAt >= weekAgo && viewedAt <= now && e.plan === 'pro' && resultsReports.has(e.report_type);
  }).map((e) => e.user_id));

  // Pricing check (H4): paywall viewers who went on to pay.
  const paywallUsers = new Set(ev('paywall_view').map((e) => e.user_id).filter(Boolean));
  const paidUsers = new Set(subsStarted.map((e) => e.user_id));
  const paywallPaid = [...paywallUsers].filter((u) => paidUsers.has(u)).length;

  // Funnel by first-touch source.
  const channels = {};
  const row = (k) => (channels[k] ||= { source: k, landing_visitors: new Set(), sign_ups: 0, activated: 0, paid: 0 });
  for (const e of ev('landing_view')) row(e.utm_source || (e.ttclid ? 'tiktok' : 'direct')).landing_visitors.add(e.anonymous_id);
  const activatedUsers = new Set(ev('post_generated').filter((e) => e.success).map((e) => e.user_id));
  for (const u of users) {
    const r = row(sourceOf(u.first_touch) || 'direct');
    r.sign_ups += 1;
    if (activatedUsers.has(u.id)) r.activated += 1;
    if (paidUsers.has(u.id)) r.paid += 1;
  }
  const funnel = Object.values(channels).map((r) => ({
    source: r.source,
    landing_visitors: r.landing_visitors.size,
    sign_ups: r.sign_ups,
    activated: r.activated,
    paid: r.paid,
    signup_to_paid_pct: pct(r.paid, r.sign_ups),
  })).sort((a, b) => b.sign_ups - a.sign_ups);

  // Attribution reconciliation (A12): our backend count by source vs what an ad platform reports.
  const last30 = subsStarted.filter((e) => now - Date.parse(e.ts) <= 30 * DAY);
  const bySource = {};
  for (const e of last30) {
    const k = e.utm_source || (e.ttclid ? 'tiktok' : 'unknown');
    bySource[k] = (bySource[k] || 0) + 1;
  }

  const gens = ev('post_generated');
  const toolCounts = {};
  for (const e of ev('agent_tool_called')) {
    const t = (toolCounts[e.tool] ||= { tool: e.tool, calls: 0, errors: 0 });
    t.calls += 1;
    if (!e.ok) t.errors += 1;
  }

  return {
    generated_at: new Date(now).toISOString(),
    a4: {
      month1: { label: 'Seed Pro users who published a tracked post within 7 days', target_pct: 50, value_pct: pct(m1Hits, pro.length), numerator: m1Hits, denominator: pro.length, note: 'Published = the tracked link received a real (non-bot, unique) click.' },
      month2: { label: 'New paid users on v2 this month', target: 100, value: month2Starts.length, window: 'UTC calendar month', window_start: new Date(monthStart).toISOString(), window_end: new Date(nextMonthStart).toISOString() },
      month3: { label: '30-day paid retention (v2 cohort)', target_pct: 45, baseline_pct: 26, value_pct: pct(retained.length, matured.length), matured: matured.length, retained: retained.length, total_subscriptions: db.subscriptions.length },
    },
    leading: {
      weekly_results_open_rate: { label: 'Pro users who opened Results in the last 7 days', stop_below_pct: 30, value_pct: pct(viewers.size, pro.length), numerator: viewers.size, denominator: pro.length },
      paywall_conversion: { label: 'Paywall viewers who upgraded', value_pct: pct(paywallPaid, paywallUsers.size), numerator: paywallPaid, denominator: paywallUsers.size },
      proposal_acceptance: { label: 'Assistant proposals the merchant accepted', value_pct: pct(ev('proposal_accepted').length, ev('post_proposed').length), numerator: ev('proposal_accepted').length, denominator: ev('post_proposed').length },
      publish_rate: { label: 'Written posts marked as posted', value_pct: pct(ev('post_published').length, gens.filter((e) => e.success).length), numerator: ev('post_published').length, denominator: gens.filter((e) => e.success).length },
      generation_success: { label: 'Generations that succeeded', value_pct: pct(gens.filter((e) => e.success).length, gens.length), numerator: gens.filter((e) => e.success).length, denominator: gens.length },
    },
    totals: {
      users: users.length,
      pro_users: pro.length,
      posts: db.posts.length,
      tracked_links: db.links.length,
      unique_clicks: db.clicks.filter((c) => c.unique).length,
      bot_clicks: db.clicks.filter((c) => c.is_bot).length,
      attributed_orders: db.orders.filter((o) => o.post_id || o.link_code).length,
      attributed_revenue: Math.round(db.orders.filter((o) => o.link_code).reduce((s, o) => s + o.value, 0) * 100) / 100,
    },
    funnel,
    reconciliation: { window_days: 30, backend_by_source: bySource, backend_total: last30.length },
    tools: Object.values(toolCounts).sort((a, b) => b.calls - a.calls),
    outbox: db.outbox.slice(-20).reverse(),
  };
}

module.exports = { compute };
