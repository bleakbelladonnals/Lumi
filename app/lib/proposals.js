// A proposal is the assistant's suggestion for one post. Writing it costs a credit, so the assistant
// is only spent when the merchant presses the button on the proposal card. The press accepts the proposal
// and the server writes it in the same request: proposed -> accepted -> writing -> used, or back to
// proposed if writing failed. The model has no tool that can spend a credit.
const merchant = require('../data/merchant.json');
const store = require('./store');

function create(user, { product_id, channel, angle, reason }) {
  const proposal = {
    id: store.id('prop'),
    user_id: user.id,
    product_id,
    channel,
    angle,
    reason: String(reason || '').slice(0, 300),
    status: 'proposed',
    created_at: new Date().toISOString(),
  };
  store.db.proposals.push(proposal);
  store.track('post_proposed', { user_id: user.id, plan: user.plan, proposal_id: proposal.id, product_id, channel, angle });
  return proposal;
}

const find = (user, id) => store.db.proposals.find((p) => p.id === id && p.user_id === user.id);

function accept(user, id) {
  const proposal = find(user, id);
  if (!proposal) return { error: 'not_found' };
  if (proposal.status === 'proposed') {
    proposal.status = 'accepted';
    proposal.accepted_at = new Date().toISOString();
    store.track('proposal_accepted', {
      user_id: user.id,
      plan: user.plan,
      proposal_id: id,
      product_id: proposal.product_id,
      seconds_to_accept: Math.round((Date.now() - Date.parse(proposal.created_at)) / 1000),
    });
  }
  return { proposal };
}

// After a button press: if the post did not get written (no credits, model error), the proposal goes back
// to waiting for the button. Nothing stays "accepted" between requests, so nothing can spend it later.
function release(user, id) {
  const proposal = find(user, id);
  if (proposal && proposal.status === 'accepted') {
    proposal.status = 'proposed';
    store.save();
  }
}

function describe(p) {
  const product = merchant.products.find((x) => x.id === p.product_id)?.name || p.product_id;
  return `${p.id}: ${product}, ${p.channel}, ${merchant.angles[p.angle] || p.angle}`;
}

module.exports = { create, find, accept, release, describe };
