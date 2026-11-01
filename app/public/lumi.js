// Shared browser helpers: source capture (UTM / ttclid), API calls, events, formatting.
(function () {
  const KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ttclid'];
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const setCookie = (k, v, days) => { document.cookie = `${k}=${encodeURIComponent(v)}; Max-Age=${days * 86400}; Path=/; SameSite=Lax`; };
  const getCookie = (k) => decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith(k + '=')) || '').split('=')[1] || '');

  function anonymousId() {
    let id = ls.get('lumi_anon') || getCookie('lumi_anon');
    if (!id) id = 'anon_' + Math.random().toString(36).slice(2, 12);
    ls.set('lumi_anon', id);
    setCookie('lumi_anon', id, 365);
    return id;
  }

  // First touch is kept forever, last touch is overwritten by each new tagged visit.
  // Stored in localStorage and a first-party cookie, then bound to the account at sign-up.
  function captureTouch() {
    const q = new URLSearchParams(location.search);
    const touch = {};
    KEYS.forEach((k) => { if (q.get(k)) touch[k] = q.get(k); });
    if (Object.keys(touch).length) {
      if (touch.ttclid && !touch.utm_source) touch.utm_source = 'tiktok';
      touch.referrer = document.referrer || null;
      touch.landing_path = location.pathname;
      touch.ts = new Date().toISOString();
      if (!ls.get('lumi_first_touch')) {
        ls.set('lumi_first_touch', touch);
        setCookie('lumi_ft', JSON.stringify(touch), 90);
      }
      ls.set('lumi_last_touch', touch);
    }
    let first = ls.get('lumi_first_touch');
    if (!first && getCookie('lumi_ft')) { try { first = JSON.parse(getCookie('lumi_ft')); } catch { /* ignore */ } }
    return { current: Object.keys(touch).length ? touch : null, first, last: ls.get('lumi_last_touch') };
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error((data && data.message) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function track(name, props = {}) {
    return api('/api/track', { method: 'POST', body: { name, props } }).catch(() => {});
  }

  const money = (n) => {
    if (n == null) return '–';
    const whole = Number.isInteger(Number(n));
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  };
  const num = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  function toast(text) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  window.Lumi = { anonymousId, captureTouch, api, track, money, num, esc, titleCase, toast };
})();
