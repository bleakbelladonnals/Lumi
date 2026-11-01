// Server-side quota. The browser only displays what this module returns.
// reserve() -> commit() on success, refund() on failure, so failed generations are free.
// Node runs this synchronously, so check-and-reserve is atomic within one process.
// Production: a row lock or Redis INCR does the same job across instances.
const { PLANS, ADDON } = require('./config');
const store = require('./store');

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7); // UTC month
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

// Plan credits reset on the 1st. Top-up credits were paid for, so whatever is left of them carries over
// (plan credits are used first). They also stay if the user goes back to Free.
function ensurePeriod(user) {
  const period = monthKey();
  if (!user.quota) {
    user.quota = { period, used: 0, reserved: 0, bonus: 0 };
  } else if (user.quota.period !== period) {
    const old = user.quota;
    const bonus = old.bonus || 0;
    const planLimit = PLANS[user.plan].generationsPerMonth;
    const leftover = Math.max(0, Math.min(bonus, planLimit + bonus - (old.used || 0)));
    // A write in flight across midnight keeps its reservation so commit/refund still balance.
    user.quota = { period, used: 0, reserved: old.reserved || 0, bonus: leftover };
  }
  return user.quota;
}

function limitFor(user) {
  const q = ensurePeriod(user);
  return PLANS[user.plan].generationsPerMonth + (q.bonus || 0);
}

function status(user) {
  const q = ensurePeriod(user);
  const limit = limitFor(user);
  return {
    plan: user.plan,
    period: q.period,
    limit,
    used: q.used,
    left: Math.max(0, limit - q.used - q.reserved),
  };
}

function reserve(user) {
  const q = ensurePeriod(user);
  if (q.used + q.reserved >= limitFor(user)) {
    return { ok: false, ...status(user) };
  }
  q.reserved += 1;
  store.save();
  return { ok: true, ...status(user) };
}

function commit(user) {
  const q = ensurePeriod(user);
  q.reserved = Math.max(0, q.reserved - 1);
  q.used += 1;
  store.save();
  return status(user);
}

function refund(user) {
  const q = ensurePeriod(user);
  q.reserved = Math.max(0, q.reserved - 1);
  store.save();
  return status(user);
}

function addTopUp(user) {
  const q = ensurePeriod(user);
  q.bonus = (q.bonus || 0) + ADDON.generations;
  store.save();
}

// Mid-month plan change. Plan credits already used stay used (capped at the new plan's allowance), and
// unused top-up credits move across: leaving Pro after 300 posts with a full top-up keeps all 200 top-up credits.
function onPlanChange(user, fromPlan) {
  const q = ensurePeriod(user);
  const fromLimit = PLANS[fromPlan].generationsPerMonth;
  const bonus = q.bonus || 0;
  const bonusLeft = Math.max(0, Math.min(bonus, fromLimit + bonus - q.used));
  const planUsed = Math.min(q.used, fromLimit);
  q.used = Math.min(planUsed, PLANS[user.plan].generationsPerMonth);
  q.bonus = bonusLeft;
  store.save();
}

// Chat messages have their own daily cap so a free user cannot run up model cost by chatting.
function takeChatMessage(user) {
  const day = dayKey();
  if (!user.chat || user.chat.day !== day) user.chat = { day, count: 0 };
  const cap = PLANS[user.plan].chatMessagesPerDay;
  if (user.chat.count >= cap) return { ok: false, cap };
  user.chat.count += 1;
  store.save();
  return { ok: true, cap, count: user.chat.count };
}

module.exports = { status, reserve, commit, refund, addTopUp, onPlanChange, takeChatMessage };
