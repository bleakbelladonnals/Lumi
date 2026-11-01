/* global Lumi */
const { api, track, money, num, esc, titleCase, toast } = Lumi;
const channelName = (c) => ({ tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook', email: 'Email' }[c] || titleCase(c));
const LINK_IN_CAPTION = new Set(['facebook', 'email']);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
const TABS = ['home', 'write', 'results', 'plan'];

let me = null;
let catalog = null;
let currentTab = 'home';
let homePeriod = 30;
let homeData = null;

// ---------- boot ----------

async function boot() {
  Lumi.captureTouch();
  const data = await api('/api/me');
  if (!data.user) { location.href = '/'; return; }
  me = data;
  catalog = await api('/api/catalog');
  $('#llm-banner').style.display = data.llm.configured ? 'none' : 'block';
  renderHeader();
  setupDemoBar();
  const tab = location.hash.slice(1);
  showTab(TABS.includes(tab) ? tab : 'home');
}

async function refreshMe() {
  me = await api('/api/me');
  renderHeader();
}

function renderHeader() {
  const u = me.user;
  const q = u.quota;
  $('#plan-pill').textContent = u.plan_info.name;
  $('#plan-pill').className = 'pill ' + (u.plan === 'pro' ? 'accent' : '');
  $('#credits').textContent = `${q.left}/${q.limit} credits`;
  $('#meter span').style.width = (q.limit ? (q.left / q.limit) * 100 : 0) + '%';
  $('#meter').classList.toggle('low', q.left <= Math.max(1, q.limit * 0.1));
  const ft = u.first_touch;
  $('#source').innerHTML = ft
    ? Object.entries(ft).filter(([k]) => k.startsWith('utm_') || k === 'ttclid').map(([k, v]) => `${k}=${esc(v)}`).join(' ')
    : 'direct (open the landing page with ?utm_source=…)';
}

function showTab(name) {
  currentTab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => { p.hidden = p.id !== name; });
  history.replaceState(null, '', '#' + name);
  renderSuggestions();
  if (name === 'home') renderHome();
  if (name === 'write') renderWizard();
  if (name === 'results') renderResults();
  if (name === 'plan') renderPlan();
  window.scrollTo(0, 0);
}

$('#tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/'; });

// ---------- demo controls (reviewers only) ----------

function setupDemoBar() {
  if (!me.demo_tools) return;
  let hidden = false;
  try { hidden = localStorage.getItem('lumi_demo_bar') === 'hidden'; } catch { /* private mode */ }
  const apply = () => { $('#demobar').hidden = hidden; $('#demo-show').hidden = !hidden; };
  apply();
  $('#demo-hide').onclick = () => { hidden = true; try { localStorage.setItem('lumi_demo_bar', 'hidden'); } catch { /* ignore */ } apply(); };
  $('#demo-show').onclick = () => { hidden = false; try { localStorage.removeItem('lumi_demo_bar'); } catch { /* ignore */ } apply(); };
  const leave = async (n) => {
    const r = await api('/api/demo/use-credits', { method: 'POST', body: { leave: n } });
    me.user.quota = r.quota;
    renderHeader();
    toast(`${r.quota.left} credit${r.quota.left === 1 ? '' : 's'} left`);
    if (currentTab === 'plan') renderPlan();
  };
  $('#leave1').onclick = () => leave(1);
  $('#leave0').onclick = () => leave(0);
}

// ---------- small markdown for assistant replies ----------

function md(text) {
  const lines = esc(text).split('\n');
  let html = '';
  let list = null;
  let para = [];
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  const flush = () => { if (para.length) { html += `<p>${inline(para.join('<br>'))}</p>`; para = []; } };
  for (const line of lines) {
    const ul = line.match(/^\s*[-*•]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      flush();
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { close(); html += `<${kind}>`; list = kind; }
      html += `<li>${inline((ul || ol)[1])}</li>`;
    } else if (!line.trim()) { flush(); close(); } else {
      close();
      const h = line.match(/^#{1,4}\s+(.*)/);
      if (h) { flush(); html += `<p><b>${inline(h[1])}</b></p>`; } else para.push(line);
    }
  }
  flush(); close();
  return html;
}

// ---------- shared bits ----------

function changePill(v) {
  if (v == null) return '';
  const cls = v > 5 ? 'good' : v < -5 ? 'bad' : '';
  return `<span class="pill ${cls}">${v > 0 ? '+' : ''}${v}%</span>`;
}

function deltaPill(v, p) {
  if (p && p.live && !p.clicks && !p.orders) return '<span class="pill" title="Waiting for the first click">waiting</span>';
  if (v == null) return '<span class="faint">–</span>';
  return changePill(v);
}

const HOW_COUNTED = '<details class="how small"><summary>How orders are counted</summary><p>An order counts for a post when the customer uses that post\'s discount code. Without a code, it counts for the last tracked link they clicked in the 30 days before buying. Bots and repeat clicks are ignored.</p></details>';

const caption = (v) => v.caption + (v.hashtags?.length ? '\n\n' + v.hashtags.join(' ') : '');

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch { toast('Copy failed: select the text and copy it'); }
}

function lockCard(title, body, cta, trigger = 'feature') {
  return `<div class="card lock-teaser"><div class="lock-icon">🔒</div><div><b>${esc(title)}</b><p class="small muted" style="margin:4px 0 10px">${esc(body)}</p><button class="btn sm primary" data-paywall="${trigger}">${esc(cta)}</button></div></div>`;
}

// ---------- home ----------

async function renderHome() {
  const el = $('#home');
  if (!homeData) el.innerHTML = '<div class="card muted"><span class="spinner"></span> Loading…</div>';
  homeData = await api(`/api/home?days=${homePeriod}`);
  if (currentTab !== 'home') return;
  const { summary: s, recommendation: rec, getting_started: steps, drafts } = homeData;
  const pro = !s.locked;
  track('report_viewed', { report_type: 'home', locked: s.locked, period_days: s.period_days });

  const periodSelect = pro
    ? `<select id="period" style="width:auto">${[7, 30, 90].map((d) => `<option value="${d}" ${d === homePeriod ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select>`
    : '';

  let headline;
  let body = '';
  if (pro && !s.totals.posts) {
    headline = `<p class="headline">No posts in the last ${s.period_days} days. After your next post, its clicks and orders show up here.</p>`;
  } else if (pro) {
    const t = s.totals;
    const ch = s.change_pct.orders;
    headline = `<p class="headline">Your posts brought <b>${plural(t.orders, 'order')}</b> and <b>${money(t.revenue)}</b> in the last ${s.period_days} days${ch == null ? '' : `, ${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch)}% on the ${s.period_days} days before`}.</p>`;
    const best = s.top_posts[0];
    body = `
      <div class="grid g4">
        <div class="card tile"><div class="label">Orders</div><div class="value">${num(t.orders)}</div>${changePill(s.change_pct.orders)}</div>
        <div class="card tile"><div class="label">Revenue</div><div class="value">${money(t.revenue)}</div>${changePill(s.change_pct.revenue)}</div>
        <div class="card tile"><div class="label">Link clicks</div><div class="value">${num(t.clicks)}</div>${changePill(s.change_pct.clicks)}</div>
        <div class="card tile"><div class="label">Posts</div><div class="value">${num(t.posts)}</div><span class="small faint">${money(t.revenue_per_post)} per post</span></div>
      </div>
      <div class="card">
        <h3>What sells for you</h3>
        <ul class="findings">${s.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <div class="row"><button class="btn sm" data-goto="results">See every post</button><button class="btn sm ghost" data-ask="Why did my best post this month work so well?">Ask why</button></div>
      </div>
      ${best ? `<div class="card">
        <div class="row spread"><h3 style="margin:0">Best post</h3><span class="small faint">${best.date} · ${esc(channelName(best.channel))} · ${esc(best.angle_label)}</span></div>
        <p class="quote">${esc(best.caption)}</p>
        <div class="row small"><b>${plural(best.orders, 'order')} · ${money(best.revenue)}</b><span class="muted">${esc(best.product)}</span>${best.vs_average_pct != null ? `<span class="pill good">${best.vs_average_pct > 0 ? '+' : ''}${best.vs_average_pct}% vs your average</span>` : ''}</div>
      </div>` : ''}`;
  } else if (!s.latest_post) {
    headline = '<p class="headline">After your first post, its clicks and orders show up here.</p>';
  } else {
    const p = s.latest_post;
    const waiting = p.live && !p.clicks && !p.orders;
    headline = waiting
      ? `<p class="headline">Your latest post (${esc(p.product)} on ${esc(channelName(p.channel))}) is live. Clicks and orders show up here as they come in.</p>`
      : `<p class="headline">Your latest post (${esc(p.product)}, ${p.date}) brought <b>${plural(p.orders, 'order')}</b> worth <b>${money(p.revenue)}</b> from ${plural(p.clicks, 'click')}.</p>`;
    body = lockCard(`See which of your ${s.total_posts} posts sell`, 'Free shows your latest post. Pro shows totals, which styles and channels bring orders, and your best posts.', 'Unlock all results');
  }

  const next = rec ? `<div class="card next-card">
      <div class="label">Next post</div>
      <h3 style="margin:4px 0">${esc(rec.product)}</h3>
      <div class="small muted">${esc(channelName(rec.channel))} · ${esc(rec.angle_label)}</div>
      <p class="small" style="margin:8px 0 12px">${esc(rec.reason)}</p>
      <button class="btn primary" id="write-rec">Write this post</button>
    </div>` : '';

  const checklist = steps ? `<div class="card">
      <h3>Getting started</h3>
      <ol class="checklist">${steps.map((st) => `<li class="${st.done ? 'done' : ''}">${esc(st.label)}</li>`).join('')}</ol>
    </div>` : '';

  const waitingList = s.waiting_for_first_click?.length ? `<div class="card">
      <h3>Waiting for the first click</h3>
      ${s.waiting_for_first_click.map((p) => `<div class="small row spread" style="margin:6px 0"><span>${esc(p.product)} · ${esc(channelName(p.channel))}</span><span class="faint">${p.date}</span></div>`).join('')}
      <p class="small faint" style="margin:6px 0 0">Check the link is in your bio. Clicks usually start within a day.</p>
    </div>` : '';

  const draftList = drafts?.length ? `<div class="card">
      <h3>Written, not posted yet</h3>
      ${drafts.map((d) => `<div class="small row spread" style="margin:6px 0"><span>${esc(d.product)} · ${esc(channelName(d.channel))}</span><button class="btn xs" data-finish="${esc(d.id)}">Finish posting</button></div>`).join('')}
    </div>` : '';

  el.innerHTML = `
    <div class="row spread" style="margin-bottom:12px">
      <div><h2 style="margin:0">Hi ${esc(catalog.merchant.owner)}</h2><p class="small muted" style="margin:0">${esc(catalog.merchant.name)}</p></div>
      ${periodSelect}
    </div>
    <div class="grid side-r-wide" style="align-items:start">
      <div class="stack">
        <div class="card headline-card">${headline}${HOW_COUNTED}</div>
        ${body}
      </div>
      <div class="stack">${next}${checklist}${waitingList}${draftList}</div>
    </div>`;

  $('#period')?.addEventListener('change', (e) => { homePeriod = Number(e.target.value); renderHome(); });
  $('#write-rec')?.addEventListener('click', () => {
    Object.assign(wiz, { step: 2, product: rec.product_id, channel: rec.channel, angle: rec.angle, post: null, variant: null, published: false });
    showTab('write');
  });
}

// ---------- write: 4-step flow ----------

const wiz = { step: 1, product: null, channel: null, angle: null, notes: '', post: null, variant: null, published: false, busy: false };
let wizInfo = null; // recommendation and style ranking

async function loadWizInfo() {
  const [home, summary] = await Promise.all([api('/api/home'), api('/api/summary?days=90')]);
  const ranked = summary.locked ? null : summary.by_angle;
  wizInfo = { rec: home.recommendation, ranked, byProduct: summary.locked ? null : summary.by_product };
}

async function renderWizard() {
  if (!wizInfo) {
    $('#wizard').innerHTML = '<div class="card muted"><span class="spinner"></span> Loading…</div>';
    await loadWizInfo();
  }
  const { rec } = wizInfo;
  wiz.product ||= rec?.product_id || catalog.products[0].id;
  wiz.channel ||= rec?.channel || 'instagram';
  wiz.angle ||= rec?.angle || Object.keys(catalog.angles)[0];
  $$('#stepper li').forEach((li) => {
    const n = Number(li.dataset.s);
    li.className = n < wiz.step ? 'done' : n === wiz.step ? 'current' : '';
  });
  const box = $('#wizard');
  if (wiz.step === 1) box.innerHTML = stepProduct();
  if (wiz.step === 2) box.innerHTML = stepHow();
  if (wiz.step === 3) box.innerHTML = stepVersions();
  if (wiz.step === 4) box.innerHTML = stepPost();
}

const product = (id) => catalog.products.find((p) => p.id === id);

function stepProduct() {
  const { rec, byProduct } = wizInfo;
  const perPost = (id) => byProduct?.find((p) => p.key === id)?.revenue_per_post;
  const ordered = [...catalog.products].sort((a, b) => (b.id === rec?.product_id) - (a.id === rec?.product_id));
  return `<div class="card wiz-card">
    <h2>What do you want to sell?</h2>
    <div class="stack" style="--gap:8px">${ordered.map((p) => `
      <button class="choice ${p.id === wiz.product ? 'on' : ''}" data-pick-product="${p.id}">
        <div class="row spread"><b>${esc(p.name)}</b><span>${money(p.price)}</span></div>
        <div class="small faint">${p.stock} in stock · ${p.rating} ★ from ${p.review_count} reviews${perPost(p.id) ? ` · ${money(perPost(p.id))} per post` : ''}</div>
        ${p.id === rec?.product_id ? `<div class="small suggest"><span class="pill good">Suggested</span> ${esc(rec.reason)}</div>` : ''}
      </button>`).join('')}</div>
    <div class="wiz-actions"><span></span><button class="btn primary" data-wiz="2">Continue</button></div>
  </div>`;
}

function stepHow() {
  const { ranked } = wizInfo;
  const angles = Object.entries(catalog.angles).map(([id, label]) => {
    const r = ranked?.find((g) => g.key === id);
    return { id, label, avg: r?.avg_orders_per_post, posts: r?.posts || 0 };
  });
  if (ranked) angles.sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));
  const bestId = ranked?.[0]?.key;
  const channels = [['instagram', 'Instagram', 'connected'], ['tiktok', 'TikTok', 'connected'], ['facebook', 'Facebook', '']];
  const p = product(wiz.product);
  const q = me.user.quota;
  return `<div class="card wiz-card">
    <div class="small muted">${esc(p.name)} · <a href="#" data-wiz="1">change</a></div>
    <h2>Where will you post it?</h2>
    <div class="row">${channels.map(([id, label, note]) => `<button class="choice inline ${id === wiz.channel ? 'on' : ''}" data-pick-channel="${id}">${label}${note ? ` <span class="small faint">${note}</span>` : ''}</button>`).join('')}</div>
    <p class="small muted" style="margin-top:8px">${LINK_IN_CAPTION.has(wiz.channel) ? 'The tracked link goes right in the post.' : `Links in ${channelName(wiz.channel)} captions can't be tapped, so each version carries its own discount code to track sales, and the tracked link goes in your bio.`}</p>
    <h2 style="margin-top:18px">How should it sound?</h2>
    <div class="stack" style="--gap:8px">${angles.map((a) => `
      <button class="choice ${a.id === wiz.angle ? 'on' : ''}" data-pick-angle="${a.id}">
        <div class="row spread"><span>${esc(a.label)}</span>
        ${ranked ? (a.posts ? `<span class="small ${a.id === bestId ? 'pill good' : 'faint'}">${a.id === bestId ? 'Sells best · ' : ''}${a.avg} order${a.avg === 1 ? '' : 's'} per post</span>` : '<span class="small faint">not tried yet</span>') : ''}</div>
      </button>`).join('')}</div>
    ${ranked ? '<p class="small faint" style="margin-top:6px">Ranked by orders per post in your shop, last 90 days.</p>'
    : '<p class="small muted" style="margin-top:6px">🔒 Pro ranks these styles by what actually sold in your shop. <a href="#" data-paywall="feature">See how</a></p>'}
    <label style="margin-top:14px">Anything to mention? (optional)</label>
    <textarea id="wiz-notes" rows="2" placeholder="e.g. free gift wrap until Dec 15, keep it short">${esc(wiz.notes)}</textarea>
    <div class="wiz-actions"><button class="btn ghost" data-wiz="1">Back</button>
      <div class="row" style="gap:8px"><span class="small faint">${q.left} of ${q.limit} credits left</span><button class="btn primary" id="wiz-generate" ${wiz.busy ? 'disabled' : ''}>Write 3 versions · 1 credit</button></div></div>
  </div>`;
}

function versionCards(post, { chosen = null, inChat = false, highlight = null } = {}) {
  return `<div class="${inChat ? 'stack' : 'grid g3'}" data-post="${esc(post.id)}">${post.variants.map((v, i) => `
    <div class="variant ${i === chosen || i === highlight ? 'chosen' : ''}">
      <div class="row spread"><span class="pill">Version ${i + 1}${v.label ? ` · ${esc(v.label)}` : ''}</span>${v.revised ? '<span class="small faint">edited</span>' : ''}</div>
      <div class="caption">${esc(v.caption)}</div>
      <div class="small faint">${esc((v.hashtags || []).join(' '))}</div>
      <div class="row" style="margin-top:auto; gap:6px">
        <button class="btn sm primary" data-use="${i}">Use this version</button>
        ${inChat ? '' : `<button class="btn sm ghost" data-change="${i}">Change it</button>`}
      </div>
    </div>`).join('')}</div>`;
}

function stepVersions() {
  if (wiz.busy) {
    return `<div class="card wiz-card"><p><span class="spinner"></span> Writing 3 versions from your reviews and what has sold before. This takes about 15 seconds.</p></div>`;
  }
  const post = wiz.post;
  if (!post) { wiz.step = 2; return stepHow(); }
  return `<div class="card">
    <div class="row spread"><div><h2 style="margin:0">Pick the version you like</h2><p class="small muted" style="margin:0">${esc(post.product)} · ${esc(channelName(post.channel))} · ${esc(catalog.angles[post.angle])} · discount code <b class="mono">${esc(post.discount_code)}</b> (10% off) is already in each one</p></div></div>
    <div style="margin-top:12px">${versionCards(post)}</div>
    <p class="small faint" style="margin:10px 0 0">Want a different wording? "Change it" asks Lumi to rewrite that version for free.</p>
  </div>`;
}

function stepPost() {
  const post = wiz.post;
  const v = post.variants[wiz.variant];
  const inCaption = LINK_IN_CAPTION.has(post.channel);
  if (wiz.published) {
    return `<div class="card wiz-card done-card">
      <h2>Posted. Nice.</h2>
      <p>Lumi is now watching the code <b class="mono">${esc(post.discount_code)}</b> and your tracked link. Clicks and orders show up on Home, usually within a day.</p>
      <div class="row"><button class="btn primary" data-goto="home">Go to Home</button><button class="btn" id="wiz-again">Write another post</button></div>
      ${me.demo_tools ? `<p class="small demo-hint">Demo: <a href="${esc(post.link_url)}" target="_blank">open the tracked link</a> to play a customer and place an order. Then refresh Home.</p>` : ''}
    </div>`;
  }
  return `<div class="card wiz-card">
    <h2>Post it on ${esc(channelName(post.channel))}</h2>
    <ol class="post-steps">
      <li><b>Copy the caption</b>
        <div class="caption-box">${esc(caption(v))}</div>
        <button class="btn sm" id="copy-caption">Copy caption</button></li>
      ${inCaption
    ? `<li><b>The tracked link is already in the caption</b><div class="small muted">${esc(post.link_url)}</div></li>`
    : `<li><b>Put the tracked link in your bio</b> or on a story link sticker. Captions on ${esc(channelName(post.channel))} can't hold a tappable link; the code in the caption still tracks the sale.
        <div class="row" style="margin-top:6px"><code class="link-box">${esc(post.link_url)}</code><button class="btn sm" id="copy-link">Copy link</button></div></li>`}
      <li><b>Post it</b> on ${esc(channelName(post.channel))}, then come back and press the button.</li>
    </ol>
    <div class="wiz-actions"><button class="btn ghost" data-wiz="3">Back to versions</button><button class="btn primary" id="wiz-publish">I've posted it</button></div>
  </div>`;
}

async function generateFromWizard() {
  if (me.user.quota.left <= 0) { openPaywall('quota'); return; }
  wiz.notes = $('#wiz-notes')?.value.trim() || '';
  wiz.busy = true;
  wiz.step = 3;
  renderWizard();
  try {
    const r = await api('/api/generate', { method: 'POST', body: { product_id: wiz.product, channel: wiz.channel, angle: wiz.angle, notes: wiz.notes || undefined } });
    me.user.quota = r.quota;
    renderHeader();
    wiz.post = r.post;
  } catch (err) {
    wiz.step = 2;
    if (err.status === 402) openPaywall('quota'); else toast(err.message);
  } finally {
    wiz.busy = false;
    if (currentTab === 'write') renderWizard();
  }
}

async function openPostInWizard(postOrId, variant = null) {
  const post = typeof postOrId === 'string' ? (await api(`/api/posts/${postOrId}`)).post : postOrId;
  Object.assign(wiz, { post, product: post.product_id, channel: post.channel, angle: post.angle, variant, published: Boolean(post.published_at), step: variant == null ? 3 : 4 });
  if (window.innerWidth < 860) closeDrawer();
  showTab('write');
}

$('#wizard').addEventListener('click', async (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  if (t.dataset.wiz) { e.preventDefault(); wiz.notes = $('#wiz-notes')?.value.trim() ?? wiz.notes; wiz.step = Number(t.dataset.wiz); renderWizard(); }
  if (t.dataset.pickProduct) { wiz.product = t.dataset.pickProduct; renderWizard(); }
  if (t.dataset.pickChannel) { wiz.notes = $('#wiz-notes')?.value.trim() ?? wiz.notes; wiz.channel = t.dataset.pickChannel; renderWizard(); }
  if (t.dataset.pickAngle) { wiz.notes = $('#wiz-notes')?.value.trim() ?? wiz.notes; wiz.angle = t.dataset.pickAngle; renderWizard(); }
  if (t.id === 'wiz-generate') generateFromWizard();
  if (t.dataset.use != null && t.closest('#wizard')) { wiz.variant = Number(t.dataset.use); wiz.step = 4; renderWizard(); }
  if (t.dataset.change != null) {
    openDrawer();
    const input = $('#input');
    input.value = `Rewrite version ${Number(t.dataset.change) + 1} of post ${wiz.post.id}: `;
    input.focus();
  }
  if (t.id === 'copy-caption') copy(caption(wiz.post.variants[wiz.variant]), 'Caption');
  if (t.id === 'copy-link') copy(wiz.post.link_url, 'Link');
  if (t.id === 'wiz-publish') {
    t.disabled = true;
    try {
      await api(`/api/posts/${wiz.post.id}/publish`, { method: 'POST', body: { variant: wiz.variant } });
      wiz.published = true;
      homeData = null;
      renderWizard();
    } catch (err) { toast(err.message); t.disabled = false; }
  }
  if (t.id === 'wiz-again') { Object.assign(wiz, { step: 1, post: null, variant: null, published: false, notes: '', product: null, channel: null, angle: null }); wizInfo = null; renderWizard(); }
});

// ---------- results ----------

function perfTable(posts) {
  return `<div class="table-wrap"><table class="posts"><thead><tr><th>Date</th><th>Post</th><th>Style</th><th class="num">Clicks</th><th class="num">Orders</th><th class="num">Revenue</th><th class="num">vs your average</th></tr></thead><tbody>${posts.map((p) =>
    `<tr><td class="small date" data-label="Date">${p.date}</td><td class="small post-cell">${esc((p.caption || '').slice(0, 90))}${(p.caption || '').length > 90 ? '…' : ''}<div class="faint">${esc(p.product)} · ${esc(channelName(p.channel))}${p.live ? ' · <span class="pill accent">via Lumi</span>' : ''}</div></td><td class="small" data-label="Style">${esc(p.angle_label)}</td><td class="num" data-label="Clicks">${num(p.clicks)}</td><td class="num" data-label="Orders">${num(p.orders)}</td><td class="num" data-label="Revenue">${money(p.revenue)}</td><td class="num" data-label="vs average">${deltaPill(p.vs_average_pct, p)}</td></tr>`).join('')}</tbody></table></div>`;
}

function bars(groups, labelOf) {
  const max = Math.max(...groups.map((g) => g.avg_orders_per_post), 1);
  return groups.map((g) => `<div class="small" style="margin:8px 0"><div class="row spread"><span>${esc(labelOf(g))}</span><span class="muted">${g.avg_orders_per_post} order${g.avg_orders_per_post === 1 ? '' : 's'} per post · ${plural(g.posts, 'post')}</span></div><div class="bar-track" style="margin-top:3px"><div class="bar" style="width:${(g.avg_orders_per_post / max) * 100}%"></div></div></div>`).join('');
}

async function renderResults() {
  const body = $('#results-body');
  body.innerHTML = '<div class="card muted"><span class="spinner"></span> Loading…</div>';
  const pro = me.user.plan === 'pro';
  const r = await api(`/api/results${pro ? '?group_by=angle' : ''}`);
  track('report_viewed', { report_type: 'dashboard', posts_with_data: r.posts.filter((p) => p.clicks || p.orders).length, locked: r.locked, total_posts: r.total_posts });

  if (r.locked) {
    const fake = Array.from({ length: 5 }, () => '<tr class="locked-row"><td>2026-10-00</td><td>Hidden post caption goes here for preview</td><td>Style</td><td class="num">000</td><td class="num">0</td><td class="num">$000</td><td class="num">+00%</td></tr>').join('');
    body.innerHTML = `
      <div class="card">${perfTable(r.posts)}
        <div class="lock-overlay"><table>${fake}</table>
          <div class="lock-cta"><div class="card" style="text-align:center; max-width:380px"><b>${r.total_posts - r.posts.length} more posts have results</b><p class="small muted" style="margin:6px 0 10px">Free shows your latest post only. Pro shows every post ranked by orders, plus a weekly review of what to post next.</p><button class="btn primary" data-paywall="feature">Unlock all results</button></div></div>
        </div>
        ${HOW_COUNTED}
      </div>`;
    return;
  }

  const o = r.overall;
  const best = r.groups?.[0];
  const times = best && o.avg_orders_per_post ? Math.round((best.avg_orders_per_post / o.avg_orders_per_post) * 10) / 10 : null;
  body.innerHTML = `
    <div class="card headline-card" style="margin-bottom:16px">
      <p class="headline">${plural(o.posts, 'post')} brought <b>${plural(o.orders, 'order')}</b> and <b>${money(o.revenue)}</b>.${best ? ` ${esc(best.angle_label)} posts sell best: ${best.avg_orders_per_post} orders each, ${times}× your average.` : ''}</p>
      <div class="row"><button class="btn sm primary" data-write-angle="${esc(best?.angle || '')}">Write a ${esc((best?.angle_label || '').toLowerCase())} post</button><button class="btn sm" data-ask="Review my posts from the last 14 days: what sold, what did not, and what should I post next?">Ask Lumi for a review</button></div>
      ${HOW_COUNTED}
    </div>
    <div class="grid side-r-wide" style="align-items:start">
      <div class="card">
        <div class="row spread"><h3 style="margin:0">Every post</h3>
          <select id="sort" style="width:auto"><option value="date">Newest</option><option value="orders">Most orders</option><option value="revenue">Most revenue</option><option value="clicks">Most clicks</option></select></div>
        <div id="post-table" style="margin-top:8px">${perfTable(r.posts)}</div>
      </div>
      <div class="card">
        <h3>Orders per post, by style</h3>
        ${bars(r.groups || [], (g) => g.angle_label)}
        <div class="small faint" style="margin-top:6px">Your average: ${o.avg_orders_per_post} orders per post.</div>
      </div>
    </div>`;
  $('#sort').addEventListener('change', async (e) => {
    const s = await api(`/api/results?sort_by=${e.target.value}`);
    $('#post-table').innerHTML = perfTable(s.posts);
  });
}
$('#refresh-results').addEventListener('click', renderResults);

// ---------- plan ----------

function renderPlan() {
  const u = me.user;
  const P = me.plans;
  const pro = u.plan === 'pro';
  $('#plan-body').innerHTML = `
    <div class="grid g2" style="align-items:start">
      <div class="card">
        <h2>Your plan: ${esc(u.plan_info.name)}</h2>
        <p class="muted">${u.quota.used} of ${u.quota.limit} credits used in ${u.quota.period}. Writing a post uses 1; changing one is free. Credits reset on the 1st.</p>
        <div class="table-wrap"><table>
          <tr><th></th><th>Free</th><th>Pro</th></tr>
          <tr><td>Price</td><td>$0</td><td><b>$${P.pro.price}</b>/month or $${P.pro.priceYearlyPerMonth}/month yearly</td></tr>
          <tr><td>Posts per month</td><td>${P.free.generationsPerMonth}</td><td>${P.pro.generationsPerMonth} + $${me.addon.price} for ${me.addon.generations} more</td></tr>
          <tr><td>Tracked links and codes</td><td>Yes</td><td>Yes</td></tr>
          <tr><td>Results</td><td>Latest post only</td><td>Every post, ranked</td></tr>
          <tr><td>Weekly review</td><td>–</td><td>Yes</td></tr>
          <tr><td>Assistant messages per day</td><td>${P.free.chatMessagesPerDay}</td><td>${P.pro.chatMessagesPerDay}</td></tr>
        </table></div>
        <div class="row" style="margin-top:14px">
          ${pro ? `<button class="btn" id="topup">Buy ${me.addon.generations} credits · $${me.addon.price}</button><button class="btn ghost" id="cancel">Cancel Pro</button>` : '<button class="btn primary" data-paywall="manual">Upgrade to Pro</button>'}
        </div>
      </div>
      <div class="card">
        <h3>Connected accounts</h3>
        <div class="account"><b>Shopify</b><span class="muted">${esc(catalog.merchant.name)} · ${catalog.products.length} products</span><span class="pill good">demo shop</span></div>
        <div class="account"><b>Instagram</b><span class="muted">@juniperandclay</span><span class="pill good">connected</span></div>
        <div class="account"><b>TikTok</b><span class="muted">@juniperandclay</span><span class="pill good">connected</span></div>
        <p class="small faint" style="margin-top:10px">Orders are matched from Shopify. Lumi never posts for you; you post, then tell Lumi.</p>
      </div>
    </div>`;
  $('#topup')?.addEventListener('click', () => startCheckout('addon', 'monthly'));
  $('#cancel')?.addEventListener('click', async () => { if (!confirm('Cancel Pro? You keep your tracked links.')) return; await api('/api/billing/cancel', { method: 'POST' }); await refreshMe(); renderPlan(); toast('Pro canceled'); });
}

// ---------- assistant drawer ----------

const msgs = $('#msgs');
let busy = false;

function openDrawer() { document.body.classList.add('drawer-open'); setTimeout(() => $('#input').focus(), 50); }
function closeDrawer() { document.body.classList.remove('drawer-open'); }
$('#fab').addEventListener('click', openDrawer);
$('#drawer-close').addEventListener('click', closeDrawer);

const SUGGESTIONS = {
  home: ['How did my posts do this month?', 'What should I post next?', 'Why did my best post work?'],
  write: ['Which style sells best for the Holiday Gift Box?', 'What do customers say about the mug?'],
  results: ['Which post brought the most orders, and why?', 'Is TikTok or Instagram better for me?'],
  plan: ['How did my posts do this month?', 'What should I post next?'],
};
function renderSuggestions() {
  $('#suggestions').innerHTML = (SUGGESTIONS[currentTab] || SUGGESTIONS.home).map((s) => `<button class="chip">${esc(s)}</button>`).join('');
}

// [while running, when done] in words a shop owner reads; the tool name stays visible next to it.
const STEP_LABELS = {
  get_results_summary: ['Checking your results', 'Checked your results'],
  get_post: ['Looking at that post', 'Looked at the post'],
  find_reviews: ['Reading customer reviews', 'Read customer reviews'],
  propose_post: ['Putting together a suggestion', 'Suggested a post'],
  generate_post: ['Writing 3 versions', 'Wrote 3 versions'],
  revise_post: ['Rewriting that version', 'Rewrote the version'],
  create_tracked_link: ['Making a tracked link', 'Made a tracked link'],
};

const cards = {
  summary(c) {
    if (c.locked) {
      const p = c.latest_post;
      return `<div class="card tight small">${p ? `Latest post: <b>${esc(p.product)}</b>, ${p.date}: ${plural(p.clicks, 'click')}, ${plural(p.orders, 'order')}.` : 'No posts yet.'}
        <div class="row spread" style="margin-top:8px"><span class="muted">Totals and rankings for all ${c.total_posts} posts are on Pro.</span><button class="btn sm primary" data-paywall="feature">See all results</button></div></div>`;
    }
    const t = c.totals;
    return `<div class="card tight small"><b>Last ${c.period_days} days: ${plural(t.orders, 'order')} · ${money(t.revenue)} · ${plural(t.posts, 'post')}</b> ${changePill(c.change_pct.orders)}
      <ul class="findings">${c.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>`;
  },
  post_result(c) {
    const p = c.post;
    return `<div class="card tight small"><div class="faint">${p.date} · ${esc(p.product)} · ${esc(channelName(p.channel))} · ${esc(p.angle)}</div><p class="quote">${esc(p.caption)}</p>
      ${p.locked ? '<span class="muted">Results for older posts are on Pro.</span>' : `<b>${plural(p.clicks, 'click')} · ${plural(p.orders, 'order')} · ${money(p.revenue)}</b>`}</div>`;
  },
  reviews(c) {
    return `<div class="card tight small"><div class="muted">${esc(c.product)} · ${c.rating} ★ from ${c.review_count} reviews</div>${c.quotes.map((r) =>
      `<p style="margin:8px 0 0">“${esc(r.quote)}” <span class="faint">${'★'.repeat(r.rating)}</span></p>`).join('')}</div>`;
  },
  proposal(c) {
    const p = c.proposal;
    return `<div class="card proposal" data-proposal="${esc(p.id)}">
      <div class="label">Suggested post</div>
      <h3 style="margin:4px 0">${esc(p.product)}</h3>
      <div class="small muted">${esc(p.channel_label)} · ${esc(p.angle_label)} · ${money(p.price)}, ${p.stock} in stock</div>
      <p class="small" style="margin:8px 0 12px">${esc(p.reason)}</p>
      <div class="row"><button class="btn primary sm" data-accept="${esc(p.id)}">Write 3 versions · 1 credit</button><span class="small faint">or tell me what to change</span></div>
    </div>`;
  },
  post(c) {
    const post = c.post;
    return `<div class="card tight">
      <div class="small"><b>${esc(post.product)}</b> · ${esc(post.channel_label || channelName(post.channel))} · code <b class="mono">${esc(post.discount_code)}</b>${c.link_in_caption ? '' : ' · link goes in your bio'}</div>
      <div style="margin-top:8px">${versionCards(post, { inChat: true, highlight: c.highlight ?? null })}</div>
    </div>`;
  },
  link(c) {
    const where = { bio: 'your bio', story: 'a story link sticker', email: 'your email', ads: 'your ad' }[c.placement] || c.placement;
    return `<div class="card tight trackbox"><b>${esc(c.product)}</b> · ${esc(c.channel_label)} · for ${esc(where)}<br><span class="mono">${esc(c.url)}</span> <button class="btn xs" data-copy-text="${esc(c.url)}">Copy</button><br>Code <b class="mono">${esc(c.discount_code)}</b> gives 10% off and tracks orders without a click.</div>`;
  },
};
const chatPosts = {}; // post id -> latest post object from a chat card

function addUser(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
  msgs.appendChild(el);
}

function botBubble() {
  const el = document.createElement('div');
  el.className = 'msg bot';
  msgs.appendChild(el);
  let textEl = null;
  let raw = '';
  const steps = {};
  const scroll = () => { msgs.scrollTop = msgs.scrollHeight; };
  return {
    text(delta) {
      if (!textEl) { textEl = document.createElement('div'); textEl.className = 'text'; el.appendChild(textEl); raw = ''; }
      raw += delta;
      textEl.innerHTML = md(raw);
      scroll();
    },
    toolStart(ev) {
      textEl = null;
      const d = document.createElement('details');
      d.className = 'step';
      const label = STEP_LABELS[ev.name] || [ev.name, ev.name];
      d.innerHTML = `<summary><span class="spinner"></span><span>${esc(label[0])}…</span><code class="faint small">${esc(ev.name)}</code></summary><div class="step-body"><pre>arguments: ${esc(JSON.stringify(ev.args, null, 2))}</pre></div>`;
      el.appendChild(d);
      steps[ev.id] = d;
      scroll();
    },
    toolEnd(ev) {
      const d = steps[ev.id];
      const label = STEP_LABELS[ev.name] || [ev.name, ev.name];
      if (d) {
        d.querySelector('.spinner').outerHTML = ev.ok ? '<span class="pill good">done</span>' : `<span class="pill bad">${esc(ev.error || 'error')}</span>`;
        d.querySelector('summary span:nth-child(2)').textContent = ev.ok ? label[1] : `Could not finish: ${label[1].toLowerCase()}`;
        d.querySelector('.step-body').insertAdjacentHTML('beforeend', `<pre>result: ${esc(JSON.stringify(ev.result, null, 2))}</pre>`);
      }
      if (ev.card && cards[ev.card.type]) {
        if (ev.card.post?.id) chatPosts[ev.card.post.id] = ev.card.post;
        const c = document.createElement('div');
        c.innerHTML = cards[ev.card.type](ev.card);
        // Lookups the model did for itself fold into their step; what the merchant acts on stays in view.
        const forUser = ['proposal', 'post', 'link'].includes(ev.card.type) || ev.card.locked;
        if (forUser || !d) el.appendChild(c);
        else d.querySelector('.step-body').prepend(c);
      }
      textEl = null;
      scroll();
    },
    error(message) {
      const e2 = document.createElement('div');
      e2.className = 'banner';
      e2.style.background = 'var(--bad-soft)';
      e2.style.color = 'var(--bad)';
      e2.textContent = message;
      el.appendChild(e2);
      scroll();
    },
    thinking(on) {
      let t = el.querySelector('.thinking');
      if (on && !t) { t = document.createElement('div'); t.className = 'thinking small muted'; t.innerHTML = '<span class="spinner"></span> Thinking…'; el.appendChild(t); }
      if (!on && t) t.remove();
    },
  };
}

async function send(text) {
  if (busy || !text.trim()) return;
  openDrawer();
  busy = true;
  $('#send').disabled = true;
  addUser(text);
  const bubble = botBubble();
  bubble.thinking(true);
  let wrote = false;
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, page: currentTab }) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      bubble.thinking(false);
      bubble.error(data.message || `Request failed (${res.status})`);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!chunk.startsWith('data: ')) continue;
        const ev = JSON.parse(chunk.slice(6));
        bubble.thinking(false);
        if (ev.type === 'text') bubble.text(ev.delta);
        else if (ev.type === 'tool_start') { bubble.toolStart(ev); bubble.thinking(true); }
        else if (ev.type === 'tool_end') {
          bubble.toolEnd(ev);
          if (ev.name === 'generate_post' && ev.ok) wrote = true;
          // A failed write leaves the proposal open, so its button works again.
          if (ev.name === 'generate_post' && !ev.ok) $$('[data-accept]').forEach((b) => { if (b.dataset.accepted) { b.disabled = false; b.textContent = 'Write 3 versions · 1 credit'; delete b.dataset.accepted; } });
        }
        else if (ev.type === 'paywall') setTimeout(() => openPaywall('quota'), 600);
        else if (ev.type === 'quota' || ev.type === 'done') { me.user.quota = ev.quota; renderHeader(); }
        else if (ev.type === 'error') bubble.error(ev.message);
      }
    }
  } catch (err) {
    bubble.error('Connection lost. Try again.');
  } finally {
    bubble.thinking(false);
    busy = false;
    $('#send').disabled = false;
    if (wrote) { homeData = null; wizInfo = null; }
  }
}

$('#composer').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#input').value; $('#input').value = ''; send(v); });
$('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } });
$('#suggestions').addEventListener('click', (e) => { if (e.target.matches('.chip')) send(e.target.textContent); });
$('#new-chat').addEventListener('click', async () => {
  await api('/api/chat/reset', { method: 'POST' });
  msgs.innerHTML = '<div class="msg bot"><div class="text"><p>New chat started. What would you like to know?</p></div></div>';
});

// ---------- clicks shared across pages ----------

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a') || e.target;
  if (t.matches('[data-paywall]')) { e.preventDefault(); openPaywall(t.dataset.paywall); }
  if (t.matches('[data-close]')) t.closest('.modal-bg').classList.remove('open');
  if (t.matches('[data-buy]')) startCheckout('pro', t.dataset.buy);
  if (t.matches('[data-ask]')) send(t.dataset.ask);
  if (t.matches('[data-goto]')) showTab(t.dataset.goto);
  if (t.matches('[data-copy-text]')) copy(t.dataset.copyText, 'Link');
  if (t.matches('[data-finish]')) openPostInWizard(t.dataset.finish);
  if (t.matches('[data-write-angle]')) { Object.assign(wiz, { step: 1, angle: t.dataset.writeAngle || null, post: null, variant: null, published: false }); showTab('write'); }
  if (t.matches('[data-use]') && t.closest('#msgs')) {
    const id = t.closest('[data-post]').dataset.post;
    openPostInWizard(chatPosts[id] || id, Number(t.dataset.use));
  }
  // The button on a proposal card is the merchant's go-ahead to spend a credit; the server checks it.
  if (t.matches('[data-accept]')) {
    if (busy || t.dataset.accepted) return;
    if (me.user.quota.left <= 0) { openPaywall('quota'); return; }
    t.disabled = true;
    t.dataset.accepted = '1';
    t.textContent = 'Writing…';
    try {
      await api(`/api/proposals/${t.dataset.accept}/accept`, { method: 'POST' });
      await send('Yes, write it.');
      if (t.dataset.accepted) t.textContent = 'Written below';
    } catch (err) { toast(err.message); t.disabled = false; delete t.dataset.accepted; t.textContent = 'Write 3 versions · 1 credit'; }
  }
});

// ---------- paywall + checkout ----------

async function openPaywall(trigger) {
  const q = me.user.quota;
  const titles = {
    quota: `You've used all ${q.limit} free posts this month`,
    feature: 'See which posts actually sell',
    manual: 'Upgrade to Lumi Pro',
  };
  $('#pw-title').textContent = titles[trigger] || titles.manual;
  $('#pw-sub').textContent = trigger === 'quota'
    ? 'Your credits reset on the 1st. Or keep going now with Pro.'
    : 'Free shows results for your latest post. Pro shows all of them, ranked by orders.';
  $('#pw-proof').innerHTML = '<span class="spinner"></span>';
  $('#paywall').classList.add('open');
  track('paywall_view', { trigger, quota_left: q.left, plan: me.user.plan });
  try {
    const r = await api('/api/results');
    const p = r.posts[0];
    const more = r.total_posts - 1;
    // A post published minutes ago has no clicks yet; "0 clicks, 0 orders" would read as failure.
    const waiting = p && p.live && !p.clicks && !p.orders;
    $('#pw-proof').innerHTML = !p
      ? '<div class="small">Your results will appear here after your first tracked post.</div>'
      : waiting
        ? `<div class="small"><b>Your latest post</b> (${esc(p.product)}) is live. Its clicks and orders show up as they come in. ${more} more post${more === 1 ? ' has' : 's have'} results waiting.</div>`
        : `<div class="small"><b>Your latest post</b> (${esc(p.product)}, ${p.date}) got <b>${plural(p.clicks, 'click')}</b> and <b>${plural(p.orders, 'order')}</b> worth ${money(p.revenue)}. ${more} more post${more === 1 ? ' has' : 's have'} results waiting.</div>`;
  } catch { $('#pw-proof').innerHTML = ''; }
}

let pendingCheckout = null;
async function startCheckout(item, cycle) {
  $('#paywall').classList.remove('open');
  try {
    const r = await api('/api/billing/checkout', { method: 'POST', body: { item, cycle } });
    pendingCheckout = r.checkout;
    $('#co-what').innerHTML = item === 'addon'
      ? `<b>${me.addon.generations} extra credits</b> · ${money(r.checkout.price)}`
      : `<b>Lumi Pro</b> · ${cycle === 'yearly' ? `${money(r.checkout.price)} per year ($24/month)` : `${money(r.checkout.price)} per month`}`;
    $('#checkout').classList.add('open');
  } catch (err) { toast(err.message); }
}

$('#co-pay').addEventListener('click', async () => {
  const btn = $('#co-pay');
  btn.disabled = true;
  try {
    await api(`/api/billing/simulate-pay/${pendingCheckout.id}`, { method: 'POST' });
    $('#checkout').classList.remove('open');
    await refreshMe();
    toast(pendingCheckout.item === 'addon' ? 'Credits added' : 'Welcome to Pro');
    homeData = null;
    wizInfo = null;
    showTab(currentTab);
  } catch (err) { toast(err.message); } finally { btn.disabled = false; }
});

boot().catch((err) => { document.body.innerHTML = `<div class="wrap"><div class="banner">Could not load Lumi: ${esc(err.message)}</div></div>`; });
