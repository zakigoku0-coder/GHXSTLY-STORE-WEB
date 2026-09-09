(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    currency: '$',
    accounts: [],
    selectedAccount: null,
    promo: { code: null, discount: 0 },
    lastOrderCode: '',
    online: true,
    activeTab: 'accounts',
    googleClientId: ''
  };

  const DEMO_ACCOUNTS = [
    {
      id: 1, name: 'Hook hoodie 115+ skins', skins: 115, price: 30, tier: 'Rare', tierVar: '--rare',
      warranty: '48h warranty', status: 'available', stock: 0,
      desc: 'Hook hoodie 115+ skins. Clean locker, full access, ready to play.',
      chips: [{ label: '115+ skins', gold: true }, { label: '4 rare builds', gold: true }, { label: 'Rare pickaxes', gold: true }],
      gallery: [
        { url: 'first-account-gallery/backpacks.jpg', label: 'Backpacks' },
        { url: 'first-account-gallery/pickaxes.jpg', label: 'Pickaxes' },
        { url: 'first-account-gallery/dances.jpg', label: 'Dances' },
        { url: 'first-account-gallery/competitives.jpg', label: 'Competitives' },
        { url: 'first-account-gallery/exclusives.jpg', label: 'Exclusives' }
      ]
    },
    {
      id: 2, name: 'fortnite account 205 skins leviathan axe candy axe', skins: 205, price: 40, tier: 'Epic', tierVar: '--epic',
      warranty: '48h warranty', status: 'available', stock: 0,
      desc: 'Fortnite account with 205 skins featuring Leviathan outfit with the Leviathan axe and the Candy axe. Stacked and ready.',
      chips: [
        { label: '205 skins', gold: true },
        { label: 'Leviathan Outfit', gold: true },
        { label: 'Leviathan Axe', gold: true },
        { label: 'Candy Axe', gold: true }
      ],
      gallery: [
        { url: 'leviathan-account/1.jpg', label: 'Locker overview' },
        { url: 'leviathan-account/2.jpg', label: 'Leviathan set' },
        { url: 'leviathan-account/3.jpg', label: 'Axe showcase' },
        { url: 'leviathan-account/4.jpg', label: 'Skins grid' },
        { url: 'leviathan-account/5.jpg', label: 'Extras' }
      ],
      deliveryNote: 'Message @tiktok_ghxstly and open a ticket so we can give you the account photos.'
    }
  ];

  /* ---------- Helpers ---------- */
  let toastTimer = null;
  function toast(msg, cls) {
    const el = $('#toast');
    el.textContent = msg;
    el.style.borderColor = cls === 'err' ? '#f29b9b' : 'var(--mist-dim)';
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }
  window.__toast = toast;

  async function api(url, options = {}) {
    const res = await fetch(url, options);
    let data = null;
    try { data = await res.json(); } catch (_) { }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  window.__api = api;

  function fmt(n) { return `${state.currency}${Number(n).toFixed(2)}`; }

  function accountIcon(tierVar) {
    return `<svg viewBox="0 0 24 24" fill="none"><path d="M12 2C7.58 2 4 5.58 4 10v9.2c0 .6.7.94 1.17.57L7 18l2 1.6L11.5 18l1.5 1.6 2-1.6 1.83 1.77c.47.37 1.17.03 1.17-.57V10c0-4.42-3.58-8-8-8Z" fill="currentColor"/><circle cx="9" cy="10" r="1.3" fill="#0a0d12"/><circle cx="15" cy="10" r="1.3" fill="#0a0d12"/></svg>`;
  }

  /* ---------- Particle field ---------- */
  function initParticles() {
    const canvas = $('#mist-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let w, h, particles;

    function resize() {
      const hero = canvas.parentElement;
      w = canvas.width = hero.offsetWidth;
      h = canvas.height = hero.offsetHeight;
    }
    function makeParticles() {
      const count = Math.min(38, Math.floor(w / 34));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: h + Math.random() * 120,
        r: 26 + Math.random() * 86,
        speed: 0.10 + Math.random() * 0.24,
        drift: (Math.random() - 0.5) * 0.16,
        alpha: 0.02 + Math.random() * 0.05
      }));
    }
    function tick() {
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        grad.addColorStop(0, `rgba(191,242,230,${p.alpha})`);
        grad.addColorStop(1, 'rgba(191,242,230,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        p.y -= p.speed;
        p.x += p.drift;
        if (p.y < -p.r) { p.y = h + p.r; p.x = Math.random() * w; }
      }
      if (!reduceMotion) requestAnimationFrame(tick);
    }
    window.addEventListener('resize', () => { resize(); makeParticles(); });
    resize();
    makeParticles();
    if (reduceMotion) tick(); else requestAnimationFrame(tick);
  }

  /* ---------- Scroll reveal ---------- */
  function initReveal() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); observer.unobserve(e.target); } });
    }, { threshold: 0.12 });
    $$('.reveal').forEach(el => observer.observe(el));
  }

  /* ---------- Card spotlight ---------- */
  function initSpotlight() {
    document.addEventListener('mousemove', (e) => {
      const card = e.target.closest('.acc-card');
      if (!card) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - rect.left}px`);
      card.style.setProperty('--my', `${e.clientY - rect.top}px`);
    });
  }

  /* ---------- Meta & wallet ---------- */
  async function loadMeta() {
    try {
      const meta = await api('/api/meta');
      state.currency = meta.currency || '$';
      state.googleClientId = meta.googleClientId || '';
      state.discordEnabled = !!meta.discordEnabled;
      const invite = meta.discordInvite;
      ['#discord-link', '#discord-link-2', '#discord-link-3', '#open-ticket-btn'].forEach(sel => {
        const el = $(sel);
        if (el && invite) el.setAttribute('href', invite);
      });
      $('#stock-line').textContent = `${meta.stock} accounts in stock · all under ${state.currency}${meta.maxPrice} · delivered via Discord ticket`;
      $('#t1').textContent = meta.stock;
      $('#t2').textContent = meta.stock;
    } catch (_) {
      state.online = false;
      $('#stock-line').textContent = 'Preview build — checkout is disabled. Deploy on Render for the live store.';
    }
    initGoogle();
  }

  async function refreshWallet() {
    try {
      const data = await api('/api/wallet');
      $('#wallet-balance-value').textContent = fmt(data.balance);
      $('#wallet-modal-balance').textContent = fmt(data.balance);
      renderWalletUser(data.user || null);
    } catch (_) {
      if (!state.online) {
        $('#wallet-balance-value').textContent = '—';
        $('#wallet-modal-balance').textContent = '—';
      }
    }
  }

  function renderWalletUser(user) {
    const box = $('#wallet-account');
    if (!user) { box.hidden = true; return; }
    box.hidden = false;
    $('#wallet-name').textContent = user.name || 'Buyer';
    $('#wallet-email').textContent = user.email || '';
    const pic = $('#wallet-picture');
    if (user.picture) pic.src = user.picture; else pic.hidden = true;
  }

  /* ---------- Account grid ---------- */
  function renderAccounts() {
    const grid = $('#market-grid');
    const priceChecks = $$('.f-price:checked').map(c => c.value);
    const skinChecks = $$('.f-skins:checked').map(c => c.value);
    const inRange = (val, ranges) => ranges.some(r => {
      const [lo, hi] = r.split('-').map(Number);
      return val >= lo && val <= hi;
    });

    const filtered = state.accounts.filter(
      a => inRange(a.price, priceChecks) && inRange(a.skins, skinChecks)
    );

    if (filtered.length === 0) {
      grid.innerHTML = '<p class="empty-state">No accounts match those filters right now.</p>';
      return;
    }

    grid.innerHTML = filtered.map((a, i) => {
      const out = !(a.stock > 0) || a.status === 'sold';
      return `
      <div class="acc-card" style="--tier-color: var(${a.tierVar}); animation-delay:${Math.min(i * 40, 400)}ms">
        <div class="acc-thumb" onclick="openModal(${a.id})">
          ${accountIcon(a.tierVar)}
          <span class="warranty-badge">${a.warranty}</span>
        </div>
        <div class="acc-body">
          <span class="acc-tag">${a.tier}</span>
          <span class="acc-name" onclick="openModal(${a.id})" role="button" tabindex="0">${a.name}</span>
          <span class="acc-stats">${a.skins}+ skins · <b class="stock-badge ${out ? 'sold' : ''}">${out ? 'OUT OF STOCK' : `in stock: ${a.stock}`}</b></span>
          <div class="acc-foot">
            <span class="price">${fmt(a.price)}</span>
            <button type="button" class="card-buy ${out ? 'sold' : ''}" onclick="openCheckout(${a.id})">${out ? 'Out of stock' : 'Buy'}</button>
          </div>
        </div>
      </div>
    `;
    }).join('');
  }

  async function loadAccounts() {
    try {
      const data = await api('/api/accounts');
      state.accounts = data.accounts;
      renderAccounts();
    } catch (err) {
      state.accounts = DEMO_ACCOUNTS;
      renderAccounts();
    }
  }

  /* ---------- Account modal ---------- */
  window.openModal = function (id) {
    const a = state.accounts.find(x => x.id === id);
    if (!a) return;
    state.selectedAccount = a;
    $('#modal-eyebrow').textContent = `${a.tier} · ${fmt(a.price)}`;
    $('#modal-title').textContent = a.name;
    $('#modal-desc').textContent = a.desc;
    $('#modal-chips').innerHTML = (a.chips || [])
      .map(c => `<span class="chip ${c.gold ? 'gold' : ''}">${c.label}</span>`).join('');
    const gallery = $('#account-gallery');
    if (a.gallery && a.gallery.length) {
      gallery.innerHTML = a.gallery.map(
        g => `<button type="button" class="gallery-item" onclick="openImageViewer('${g.url}','${g.label}')">
                <img src="${g.url}" alt="${g.label}" loading="lazy">
                <span>${g.label}</span>
              </button>`
      ).join('');
      gallery.hidden = false;
    } else {
      gallery.innerHTML = '';
      gallery.hidden = true;
    }
    $('#modal-overlay').classList.add('show');
  };
  window.closeModal = function () { $('#modal-overlay').classList.remove('show'); };
  window.openImageViewer = function (src, alt) {
    $('#image-viewer-image').src = src;
    $('#image-viewer-image').alt = alt || '';
    $('#image-viewer').classList.add('show');
  };
  window.closeImageViewer = function () { $('#image-viewer').classList.remove('show'); };
  window.buyFromModal = function () {
    closeModal();
    if (state.selectedAccount) openCheckout(state.selectedAccount.id);
  };

  /* ---------- Checkout ---------- */
  window.openCheckout = function (id) {
    const a = state.accounts.find(x => x.id === id);
    if (!a) return;
    if (!(a.stock > 0) || a.status === 'sold') { toast('This account is out of stock.', 'err'); return; }
    state.selectedAccount = a;
    state.promo = { code: null, discount: 0 };
    $('#promo-code').value = '';
    $('#checkout-discord').value = '';
    setPromoStatus('');
    $('#checkout-title').textContent = a.name;
    refreshCheckoutTotals();
    $('#checkout-modal-overlay').classList.add('show');
    setTimeout(() => $('#checkout-discord').focus(), 50);
  };
  window.closeCheckoutModal = function () { $('#checkout-modal-overlay').classList.remove('show'); };

  function discountedPrice() {
    return Math.max(0, state.selectedAccount.price * (1 - state.promo.discount / 100));
  }
  async function refreshCheckoutTotals() {
    try {
      const w = await api('/api/wallet');
      const price = discountedPrice();
      $('#checkout-balance').textContent = fmt(w.balance);
      $('#checkout-after').textContent = fmt(Math.max(0, w.balance - price));
      $('#checkout-buy').textContent = `Confirm purchase — ${fmt(price)}`;
    } catch (_) { }
  }

  function setPromoStatus(msg, cls) {
    const el = $('#promo-status');
    el.textContent = msg || '';
    el.className = 'form-hint' + (cls ? ' ' + cls : '');
  }

  window.checkPromo = async function () {
    if (!state.online) {
      toast('Preview build — promo codes need the live server.', 'err');
      return;
    }
    const code = $('#promo-code').value.trim().toUpperCase();
    if (!code) { setPromoStatus('Enter a promo code first.', 'err'); return; }
    try {
      const data = await api(`/api/promo/check?code=${encodeURIComponent(code)}`);
      if (!data.valid) {
        state.promo = { code: null, discount: 0 };
        setPromoStatus('Invalid or fully-used promo code.', 'err');
      } else {
        state.promo = { code, discount: data.discount };
        setPromoStatus(`Promo applied: ${data.discount}% off.`, 'ok');
      }
      refreshCheckoutTotals();
    } catch (_) {
      setPromoStatus('Could not check that code.', 'err');
    }
  };

  window.confirmPurchase = async function () {
    if (!state.selectedAccount) return;
    if (!state.online) {
      toast('Preview build — checkout works on the live Render deployment.', 'err');
      return;
    }
    const discordName = $('#checkout-discord').value.trim();
    if (discordName.length < 3) { toast('Enter your Discord username so the store can contact you.', 'err'); $('#checkout-discord').focus(); return; }
    const btn = $('#checkout-buy');
    btn.disabled = true;
    try {
      const data = await api('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: state.selectedAccount.id,
          promoCode: state.promo.code,
          discordName
        })
      });
      state.lastOrderCode = data.orderCode;
      closeCheckoutModal();
      const credsBox = $('#delivery-creds');
      if (data.credentials) {
        $('#creds-email').value = data.credentials.email;
        $('#creds-password').value = data.credentials.password;
        credsBox.hidden = false;
      } else {
        credsBox.hidden = true;
      }
      const customNote = $('#delivery-note-custom');
      if (data.deliveryNote) {
        customNote.textContent = data.deliveryNote;
        customNote.hidden = false;
      } else {
        customNote.hidden = true;
      }
      $('#delivery-order-code').textContent = data.orderCode;
      $('#delivery-note').textContent = 'The order was sent to the store. Open a Discord ticket and give them this order code to receive your order.';
      $('#delivery-modal-overlay').classList.add('show');
      toast(`Purchase recorded — ${data.accountName}`);
      await refreshWallet();
      await loadAccounts();
    } catch (err) {
      if (err.status === 400 && err.data && err.data.error === 'Insufficient wallet balance.') {
        closeCheckoutModal();
        openWalletModal();
        toast('Insufficient balance. Recharge your wallet first.', 'err');
      } else {
        toast(err.message, 'err');
      }
    } finally {
      btn.disabled = false;
    }
  };

  window.copyOrderCode = async function () {
    if (!state.lastOrderCode) return;
    try {
      await navigator.clipboard.writeText(state.lastOrderCode);
      toast('Order code copied. Send it in your Discord ticket.');
    } catch (_) {
      toast(state.lastOrderCode);
    }
  };
  window.copyCreds = async function () {
    const email = $('#creds-email').value;
    const pass = $('#creds-password').value;
    if (!email || !pass) return;
    try {
      await navigator.clipboard.writeText(`${email}\n${pass}`);
      toast('Credentials copied.');
    } catch (_) {
      toast(`${email}\n${pass}`);
    }
  };
  window.closeDeliveryModal = function () {
    $('#delivery-modal-overlay').classList.remove('show');
  };

  /* ---------- Wallet ---------- */
  window.openWalletModal = function () {
    refreshWallet();
    $('#wallet-code').value = '';
    $('#wallet-modal-overlay').classList.add('show');
    setTimeout(() => $('#wallet-code').focus(), 50);
  };
  window.closeWalletModal = function () { $('#wallet-modal-overlay').classList.remove('show'); };

  async function redeemWallet(e) {
    e.preventDefault();
    if (!state.online) {
      toast('Preview build — wallet codes need the live server.', 'err');
      return;
    }
    const input = $('#wallet-code');
    const code = input.value.trim();
    if (!code) return;
    try {
      const data = await api('/api/wallet/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      closeWalletModal();
      toast(`${fmt(data.added)} added to your wallet. New balance: ${fmt(data.balance)}`);
      await refreshWallet();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  /* ---------- Accounts, sign-in & purchase history ---------- */
  let authUser = null;
  let authMode = 'login';

  function applyAuthUi() {
    const logged = !!authUser;
    $('#user-chip').hidden = !logged;
    $('#signin-btn').hidden = logged;
    $('#signup-btn').hidden = logged;
    if (logged) {
      $('#user-name').textContent = authUser.name || 'Buyer';
      $('#user-role-badge').hidden = authUser.role !== 'owner';
      const pic = $('#user-picture');
      if (authUser.picture) { pic.src = authUser.picture; pic.hidden = false; }
      else pic.hidden = true;
      $('#user-avatar').textContent = (authUser.name || 'G').trim().charAt(0).toUpperCase();
      $('#user-avatar').style.background = avatarColor(authUser.uid || authUser.email);
    }
    renderWalletUser(authUser);
    refreshHistoryBadge();
  }

  function avatarColor(seed) {
    let h = 0;
    for (let i = 0; i < String(seed).length; i++) h = (h * 31 + String(seed).charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 55% 45%)`;
  }

  /* ---------- Auth modal ---------- */
  window.openAuthModal = function (mode) {
    authMode = mode === 'signup' ? 'signup' : 'login';
    renderAuthTabs();
    $('#auth-modal-overlay').classList.add('show');
    setTimeout(() => $('#auth-email').focus(), 50);
  };
  window.closeAuthModal = function () { $('#auth-modal-overlay').classList.remove('show'); };

  function renderAuthTabs() {
    $('#tab-login').classList.toggle('active', authMode === 'login');
    $('#tab-signup').classList.toggle('active', authMode === 'signup');
    $('#auth-name-group').hidden = authMode !== 'signup';
    $('#auth-title').textContent = authMode === 'signup' ? 'Create your account' : 'Sign in to your account';
    $('#auth-eyebrow').textContent = authMode === 'signup' ? 'NEW HERE' : 'WELCOME BACK';
    $('#auth-submit').textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
    $('#auth-password').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
  }

  async function submitAuth(e) {
    e.preventDefault();
    if (!state.online) {
      toast('Proof build — accounts need the live server.', 'err');
      return;
    }
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const name = $('#auth-name').value.trim();
    if (!email || !password) return;
    const btn = $('#auth-submit');
    btn.disabled = true;
    btn.textContent = 'Working…';
    try {
      const path = authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
      const body = authMode === 'signup' ? { name, email, password } : { email, password };
      const data = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      authUser = data.user;
      closeAuthModal();
      applyAuthUi();
      await refreshWallet();
      toast(`Welcome${authMode === 'signup' ? ' to the store' : ' back'}, ${authUser.name}!`);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
    }
  }

  function switchAuthTab(tab) {
    authMode = tab;
    renderAuthTabs();
  }

  /* ---------- Google ---------- */
  function initGoogle() {
    const btn = $('#google-btn');
    const discordBtn = $('#discord-btn');
    const setDisabled = (el, msg) => {
      el.classList.add('disabled');
      el.title = msg;
      el.querySelector('.google-btn-text').textContent = msg;
    };
    if (!state.googleClientId) {
      setDisabled(btn, 'Google login — coming soon');
    }
    if (typeof google !== 'undefined' && google.accounts && state.googleClientId) {
      google.accounts.id.initialize({
        client_id: state.googleClientId,
        callback: window.__handleGoogleCredential
      });
      btn.classList.remove('disabled');
      btn.querySelector('.google-btn-text').textContent = 'Continue with Google';
      if (btn.dataset.wired !== '1') {
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => {
          if (!state.online) { toast('Preview build — sign-in works on the live store.', 'err'); return; }
          google.accounts.id.prompt();
        });
      }
    }
    if (!state.discordEnabled) {
      setDisabled(discordBtn, 'Discord login — coming soon');
    } else {
      discordBtn.classList.remove('disabled');
      discordBtn.querySelector('.google-btn-text').textContent = 'Continue with Discord';
    }
    if (discordBtn.dataset.wired !== '1') {
      discordBtn.dataset.wired = '1';
      discordBtn.addEventListener('click', () => {
        if (!state.online) { toast('Preview build — sign-in works on the live store.', 'err'); return; }
        window.location.href = '/api/auth/discord';
      });
    }
  }

  window.__handleGoogleCredential = async function (response) {
    if (!response || !response.credential) { toast('Google sign-in did not return a credential.', 'err'); return; }
    try {
      const data = await api('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: response.credential })
      });
      authUser = data.user;
      closeAuthModal();
      applyAuthUi();
      await refreshWallet();
      toast(`Signed in as ${authUser.name}`);
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  async function loadAuth() {
    try {
      const data = await api('/api/auth/me');
      authUser = data.user;
    } catch (_) { authUser = null; }
    applyAuthUi();
  }

  async function loadOrders() {
    try {
      const data = await api('/api/orders');
      return data.orders || [];
    } catch (_) { return []; }
  }

  async function refreshHistoryBadge() {
    const badge = $('#history-badge');
    const logged = !!authUser;
    badge.hidden = true;
    if (!logged) return;
    try {
      const orders = await loadOrders();
      badge.hidden = orders.length === 0;
      badge.textContent = orders.length > 99 ? '99+' : orders.length;
    } catch (_) {}
  }

  async function signOut() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (_) {}
    authUser = null;
    applyAuthUi();
    await refreshWallet();
    toast('Signed out.');
  }

  function orderStatus(o) {
    return o.status === 'refunded' ? { label: 'Refunded', cls: 'refunded' }
      : o.notified ? { label: 'Delivered', cls: 'delivered' }
      : { label: 'Ordered', cls: 'ordered' };
  }

  window.openHistoryModal = async function () {
    if (!authUser) {
      toast('Sign in to see your order history.', 'err');
      window.openAuthModal('login');
      return;
    }
    $('#history-modal-overlay').classList.add('show');
    $('#history-list').innerHTML = '<div class="history-empty">Loading…</div>';
    const orders = await loadOrders();
    const spent = orders.reduce((s, o) => s + (o.amount || 0), 0);
    $('#hs-count').textContent = orders.length;
    $('#hs-spent').textContent = fmt(spent);
    $('#hs-last').textContent = orders.length ? new Date(orders[0].createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
    if (!orders.length) {
      $('#history-list').innerHTML = '<div class="history-empty">No purchases yet — your orders will appear here.</div>';
      return;
    }
    $('#history-list').innerHTML = orders.map(o => {
      const st = orderStatus(o);
      return `
      <div class="history-item">
        <div class="hi-meta">
          <span class="hi-name">${escapeHtml(o.accountName)}</span>
          <span class="hi-date">${new Date(o.createdAt).toLocaleString()}</span>
          <span class="hi-code-row">
            <code class="hi-code">${escapeHtml(o.orderCode)}</code>
            <button type="button" class="hi-copy" data-code="${escapeHtml(o.orderCode)}" aria-label="Copy order code">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
            </button>
          </span>
        </div>
        <div class="hi-right">
          <span class="hi-status ${st.cls}">${st.label}</span>
          <span class="hi-amount">${fmt(o.amount)}</span>
        </div>
      </div>`;
    }).join('');
    $$('#history-list .hi-copy').forEach(b => b.addEventListener('click', () => {
      const code = b.dataset.code;
      navigator.clipboard && navigator.clipboard.writeText(code).then(() => toast(`Copied ${code}`));
    }));
  };
  window.closeHistoryModal = function () { $('#history-modal-overlay').classList.remove('show'); };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  window.openCustomModal = function () {
    $('#custom-modal-overlay').classList.add('show');
    setTimeout(() => $('#custom-discord').focus(), 50);
  };
  window.closeCustomModal = function () { $('#custom-modal-overlay').classList.remove('show'); };

  async function submitCustomOrder(e) {
    e.preventDefault();
    if (!state.online) {
      toast('Preview build — custom orders need the live server.', 'err');
      return;
    }
    const discordName = $('#custom-discord').value.trim();
    if (discordName.length < 3) { toast('Enter your Discord username so the store can contact you.', 'err'); return; }
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const skins = $$('input[name="custom-skin"]:checked').map(cb => cb.value);
    try {
      await api('/api/custom-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          discordName,
          skinCount: Number($('#custom-skins').value) || 110,
          skins,
          notes: $('#custom-notes').value.trim()
        })
      });
      closeCustomModal();
      toast(`Order sent! The store will contact ${discordName} on Discord.`);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  const DEMO_DIGITALS = [
    { id: 'tweaks-normal', type: 'Tweaks', name: 'Tweaks — Normal', price: 0, limited: false, stock: null },
    { id: 'tweaks-premium', type: 'Tweaks', name: 'Tweaks — Premium', price: 10, limited: false, stock: null },
    { id: 'macro-normal', type: 'Macro', name: 'Macro — Normal', price: 5, limited: false, stock: null },
    { id: 'macro-premium', type: 'Macro', name: 'Macro — Premium', price: 10, limited: false, stock: null },
    { id: 'macro-unlimited', type: 'Macro', name: 'Macro — Unlimited', price: 30, limited: false, stock: null }
  ];

  let digitals = DEMO_DIGITALS;

  async function loadDigitals() {
    try {
      const data = await api('/api/digital');
      digitals = data.items;
    } catch (_) { }
  }

  /* ---------- Digital goods ---------- */
  function dgIcon(type) {
    if (type === 'Tweaks') return `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><path d="M12 2.6v2.8M12 18.6v2.8M2.6 12h2.8M18.6 12h2.8M5.4 5.4l2 2M16.6 16.6l2 2M18.6 5.4l-2 2M7.4 16.6l-2 2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
    if (type === 'Macro') return `<svg viewBox="0 0 24 24" fill="none"><rect x="3.5" y="5" width="17" height="12" rx="2.4" stroke="currentColor" stroke-width="1.7"/><path d="M8 21.5h8M12 17v4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="14.6" cy="9" r="1.5" fill="currentColor"/><path d="M14.6 12.4h.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
    return `<svg viewBox="0 0 24 24" fill="none"><path d="M12 2.4 2.8 11.4 12 21.6l9.2-10.2L12 2.4Z" stroke="currentColor" stroke-width="1.7"/><path d="m7.2 11 1.9 1.9 1.9-1.9M13.2 11l1.9 1.9 1.9-1.9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
  }
  function dgAccent(type) {
    if (type === 'Tweaks') return '--rare';
    if (type === 'Macro') return '--epic';
    return '--legendary';
  }
  function renderDigitals(type) {
    const grid = $('#market-grid');
    const items = digitals.filter(i => i.type === type);
    if (items.length === 0) {
      grid.innerHTML = '<p class="empty-state">Nothing here yet — check back soon.</p>';
      return;
    }
    grid.innerHTML = items.map((i, idx) => `
      <div class="acc-card" style="--tier-color: var(${dgAccent(type)}); animation-delay:${Math.min(idx * 40, 400)}ms">
        <div class="acc-thumb">
          ${dgIcon(type)}
          <span class="warranty-badge">${i.limited ? 'LIMITED EDITION' : 'DIGITAL'}</span>
        </div>
        <div class="acc-body">
          <span class="acc-tag">${type}</span>
          <span class="acc-name">${i.name}</span>
          <span class="acc-stats">${i.limited
            ? `<b class="stock-badge">${i.stock > 0 ? i.stock + ' left' : 'SOLD OUT'}</b>`
            : '<b class="stock-badge unlimited">infinite stock</b>'}</span>
          <div class="acc-foot">
            <span class="price ${i.price === 0 ? 'free' : ''}">${i.price === 0 ? 'Free' : fmt(i.price)}</span>
            <button type="button" class="card-buy" onclick="buyDigitalItem('${i.id}')" ${i.limited && i.stock <= 0 ? 'disabled' : ''}>Buy</button>
          </div>
        </div>
      </div>
    `).join('');
  }
  function renderMarket() {
    if (state.activeTab === 'accounts') {
      renderAccounts();
    } else {
      renderDigitals(state.activeTab);
    }
  }

  window.switchTab = function (tab) {
    state.activeTab = tab;
    $$('.shop-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const aside = document.querySelector('.filters');
    if (aside) aside.hidden = tab !== 'accounts';
    renderMarket();
  };

  let pendingDigital = null;
  window.buyDigitalItem = function (id) {
    const item = digitals.find(i => i.id === id);
    if (!item) return;
    if (!state.online) {
      toast('Preview build — purchases work on the live Render deployment.', 'err');
      return;
    }
    if (item.limited && item.stock <= 0) { toast('This limited item is sold out.', 'err'); return; }
    pendingDigital = item;
    $('#dg-confirm-name').textContent = item.name;
    $('#dg-confirm-price').textContent = item.price === 0 ? 'Free' : fmt(item.price);
    $('#dg-discord').value = '';
    $('#dg-confirm-overlay').classList.add('show');
    setTimeout(() => $('#dg-discord').focus(), 50);
  };
  window.closeDgConfirm = function () { $('#dg-confirm-overlay').classList.remove('show'); };

  window.confirmDigitalPurchase = async function () {
    if (!pendingDigital) return;
    const discordName = $('#dg-discord').value.trim();
    if (discordName.length < 3) { toast('Enter your Discord username so the store can contact you.', 'err'); $('#dg-discord').focus(); return; }
    const btn = $('#dg-confirm-buy');
    btn.disabled = true;
    try {
      const data = await api('/api/digital/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: pendingDigital.id, discordName })
      });
      closeDgConfirm();
      state.lastOrderCode = data.orderCode;
      $('#delivery-creds').hidden = true;
      $('#delivery-note').textContent = 'Your digital order was recorded. Open a Discord ticket with this order code — delivery happens there.';
      $('#delivery-order-code').textContent = data.orderCode;
      $('#delivery-modal-overlay').classList.add('show');
      toast(`Purchase recorded — ${data.itemName}`);
      await refreshWallet();
      loadDigitals();
    } catch (err) {
      if (err.status === 400 && err.data && err.data.error === 'Insufficient wallet balance.') {
        closeDgConfirm();
        openWalletModal();
        toast('Insufficient balance. Recharge your wallet first.', 'err');
      } else {
        toast(err.message, 'err');
      }
    } finally {
      btn.disabled = false;
    }
  };

  /* ---------- Wire up ---------- */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal(); closeCheckoutModal(); closeWalletModal(); closeDeliveryModal(); closeCustomModal(); closeImageViewer(); closeDgConfirm(); closeHistoryModal(); closeAuthModal();
    }
  });

  $$('.f-price, .f-skins').forEach(el => el.addEventListener('change', renderMarket));
  $('#wallet-button').addEventListener('click', openWalletModal);
  $('#wallet-form').addEventListener('submit', redeemWallet);
  $('#promo-check').addEventListener('click', checkPromo);
  $('#checkout-buy').addEventListener('click', confirmPurchase);
  $('#copy-code').addEventListener('click', copyOrderCode);
  $('#modal-buy').addEventListener('click', buyFromModal);
  $('#custom-acc-btn').addEventListener('click', openCustomModal);
  $('#custom-form').addEventListener('submit', submitCustomOrder);
  $('#open-ticket-btn').addEventListener('click', () => closeDeliveryModal());
  $('#signin-btn').addEventListener('click', () => openAuthModal('login'));
  $('#signup-btn').addEventListener('click', () => openAuthModal('signup'));
  $('#tab-login').addEventListener('click', () => switchAuthTab('login'));
  $('#tab-signup').addEventListener('click', () => switchAuthTab('signup'));
  $('#auth-form').addEventListener('submit', submitAuth);
  $('#history-btn').addEventListener('click', openHistoryModal);
  $('#logout-btn').addEventListener('click', signOut);

  /* ---------- Init ---------- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
  initParticles();
  initReveal();
  initSpotlight();
  loadMeta();
  refreshWallet();
  loadAuth();
  loadDigitals();
  loadAccounts();
})();