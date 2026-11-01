// Single source of truth for pricing and limits. Numbers match Part A (A3).
const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    generationsPerMonth: 10,
    chatMessagesPerDay: 30,
    resultsVisiblePosts: 1, // Free sees results for the latest post only
    weeklyReview: false,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: 29,
    priceYearlyPerMonth: 24,
    generationsPerMonth: 300, // fair use
    chatMessagesPerDay: 300,
    resultsVisiblePosts: Infinity,
    weeklyReview: true,
  },
};

const ADDON = { id: 'addon', name: 'Top-up', price: 9, generations: 200 };

// Attribution rules (PRD section 7)
const ATTRIBUTION = {
  clickDedupeHours: 24,
  orderWindowDays: 30,
  botPattern: /bot|crawler|spider|preview|facebookexternalhit|slurp|curl|wget|headless/i,
};

const AGENT = {
  maxSteps: 6,
  historyMessages: 24,
  timeoutMs: 60_000,
};

module.exports = { PLANS, ADDON, ATTRIBUTION, AGENT };
