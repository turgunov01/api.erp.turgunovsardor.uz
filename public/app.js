// TTR ONE — foundation SPA (vanilla JS). Talks to /api/v1.
const API = '/api/v1';
const store = {
  get access() { return localStorage.getItem('ttr_access'); },
  set access(v) { v ? localStorage.setItem('ttr_access', v) : localStorage.removeItem('ttr_access'); },
  get refresh() { return localStorage.getItem('ttr_refresh'); },
  set refresh(v) { v ? localStorage.setItem('ttr_refresh', v) : localStorage.removeItem('ttr_refresh'); },
};
let ME = null;

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstChild; };
const money = (minor, cur = 'UZS') => (minor / 100).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ' + cur;
const num = (v) => Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  setTimeout(() => (t.className = 'toast'), 2600);
}
const can = (p) => ME?.permissions?.includes(p);

// Per-view current page + page size.
const PAGE = { products: 1, movements: 1, audit: 1 };
const PAGE_SIZE = 25;
function pagerHtml(meta, view) {
  if (!meta) return '';
  const { page, totalPages, total } = meta;
  return `<div class="pager">
    <span class="pager-info">Всего: ${total} · стр. ${page}/${totalPages}</span>
    <button class="btn ghost sm" data-page="${view}" data-to="${page - 1}" ${page <= 1 ? 'disabled' : ''}>← Назад</button>
    <button class="btn ghost sm" data-page="${view}" data-to="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>Вперёд →</button>
  </div>`;
}
function wirePager() {
  document.querySelectorAll('[data-page]').forEach((b) => {
    b.addEventListener('click', () => {
      const v = b.getAttribute('data-page'); const to = Number(b.getAttribute('data-to'));
      if (to >= 1) { PAGE[v] = to; RENDER[v](); }
    });
  });
}

async function api(path, { method = 'GET', body, retry = true } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(store.access ? { Authorization: 'Bearer ' + store.access } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry && store.refresh) {
    const ok = await refreshTokens();
    if (ok) return api(path, { method, body, retry: false });
    logout(); throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.error;
    let msg = e?.message || 'Request failed';
    // Surface the first field-level validation message when present.
    const fe = e?.details?.fieldErrors;
    if (fe) { const first = Object.values(fe).flat()[0]; if (first) msg = String(first); }
    const err = new Error(msg); err.code = e?.code; err.status = res.status; throw err;
  }
  return data;
}
async function refreshTokens() {
  try {
    const r = await fetch(API + '/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: store.refresh }) });
    if (!r.ok) return false;
    const d = await r.json(); store.access = d.accessToken; store.refresh = d.refreshToken; return true;
  } catch { return false; }
}

// ---------- auth ----------
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  await doLogin($('#email').value.trim(), $('#password').value);
});
async function doLogin(email, password, mfaCode) {
  try {
    const d = await api('/auth/login', { method: 'POST', body: { email, password, mfaCode }, retry: false });
    store.access = d.accessToken; store.refresh = d.refreshToken; ME = d.user;
    await boot();
  } catch (err) {
    if (err.code === 'MFA_REQUIRED' || err.code === 'MFA_INVALID') {
      modal('Двухфакторная аутентификация', `
        <label>Код из приложения-аутентификатора</label><input id="mfa_code" inputmode="numeric" placeholder="6 цифр" />
        ${err.code === 'MFA_INVALID' ? '<div class="error">Неверный код, попробуйте ещё раз</div>' : ''}
      `, async () => { await doLogin(email, password, $('#mfa_code').value.trim()); }, 'Войти');
      return;
    }
    $('#loginError').textContent = err.message;
  }
}
$('#logoutBtn').addEventListener('click', logout);
async function logout() {
  try { await api('/auth/logout', { method: 'POST', retry: false }); } catch {}
  store.access = null; store.refresh = null; ME = null; ENABLED = new Set(); TENANT = null;
  LOCKED = false; PIN_SET = false; clearTimeout(idleTimer); $('#lock').classList.add('hidden');
  location.hash = 'login';
  showAuth();
}

// ---------- registration ----------
$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#registerError').textContent = '';
  try {
    const d = await api('/auth/register', { method: 'POST', retry: false, body: {
      companyName: $('#r_company').value.trim(),
      industry: $('#r_industry').value || undefined,
      fullName: $('#r_name').value.trim(),
      email: $('#r_email').value.trim(),
      password: $('#r_password').value,
    }});
    store.access = d.accessToken; store.refresh = d.refreshToken; ME = d.user;
    toast('Компания создана — добро пожаловать!');
    await boot();
  } catch (err) { $('#registerError').textContent = err.message; }
});

// ---------- change password (authenticated) ----------
$('#changePwBtn').addEventListener('click', () => {
  modal('Смена пароля', `
    <label>Текущий пароль</label><input id="cp_cur" type="password" autocomplete="current-password" />
    <label>Новый пароль</label><input id="cp_new" type="password" placeholder="минимум 8 символов" autocomplete="new-password" />
    <label>Повторите новый пароль</label><input id="cp_new2" type="password" autocomplete="new-password" />
  `, async () => {
    const n = $('#cp_new').value, n2 = $('#cp_new2').value;
    if (n !== n2) throw new Error('Пароли не совпадают');
    await api('/auth/change-password', { method: 'POST', body: { currentPassword: $('#cp_cur').value, newPassword: n } });
    toast('Пароль изменён — войдите заново');
    setTimeout(logout, 900);
  }, 'Сохранить');
});

// ---------- security: MFA + PIN + sessions ----------
$('#securityBtn').addEventListener('click', openSecurity);
async function openSecurity() {
  const [sec, sess] = await Promise.all([api('/auth/security'), api('/auth/sessions')]);
  const mfaBlock = sec.mfaEnabled
    ? `<div>2FA: <span class="tag in">включена</span> <button class="btn ghost sm" id="mfaOff">Отключить</button></div>`
    : `<div>2FA: <span class="tag muted">выключена</span> <button class="btn sm" id="mfaOn">Включить</button></div>`;
  const pinBlock = sec.pinSet
    ? `<div style="margin-top:8px">PIN: <span class="tag in">задан</span> <button class="btn ghost sm" id="pinOff">Сбросить</button></div>`
    : `<div style="margin-top:8px">PIN: <span class="tag muted">нет</span> <button class="btn sm" id="pinOn">Задать PIN</button></div>`;
  const sessRows = sess.sessions.map((s) => `<tr><td>${esc(s.userAgent || 'устройство')}</td><td>${esc(s.ip || '')}</td>
    <td>${new Date(s.createdAt).toLocaleString('ru-RU')}</td><td><button class="btn ghost sm" data-sess="${s.id}">Отозвать</button></td></tr>`).join('');
  const close = modal('Безопасность аккаунта', `
    <h4 style="margin:0 0 6px">Двухфакторная аутентификация</h4>${mfaBlock}${pinBlock}
    <h4 style="margin:16px 0 6px">Активные сессии (${sess.sessions.length})</h4>
    <table style="font-size:13px"><tbody>${sessRows || '<tr><td>Нет активных сессий</td></tr>'}</tbody></table>
    <button class="btn red sm" id="revokeAll" style="margin-top:10px">Выйти на всех устройствах</button>
  `, async () => {}, 'Закрыть');
  // Wire actions
  const q = (id) => document.getElementById(id);
  q('mfaOn') && (q('mfaOn').onclick = () => { close(); setupMfa(); });
  q('mfaOff') && (q('mfaOff').onclick = () => { close(); disableMfa(); });
  q('pinOn') && (q('pinOn').onclick = () => modal('Задать PIN', `<label>PIN (4–8 цифр)</label><input id="pin_v" inputmode="numeric" />`, async () => { await api('/auth/pin/set', { method: 'POST', body: { pin: q('pin_v').value.trim() } }); toast('PIN задан'); }, 'Сохранить'));
  q('pinOff') && (q('pinOff').onclick = async () => { await api('/auth/pin/clear', { method: 'POST' }); toast('PIN сброшен'); close(); });
  q('revokeAll') && (q('revokeAll').onclick = async () => { await api('/auth/sessions/revoke-all', { method: 'POST' }); toast('Сессии сброшены — войдите заново'); setTimeout(logout, 800); });
  document.querySelectorAll('[data-sess]').forEach((b) => b.onclick = async () => { await api(`/auth/sessions/${b.getAttribute('data-sess')}/revoke`, { method: 'POST' }); toast('Сессия отозвана'); close(); openSecurity(); });
}
async function setupMfa() {
  const s = await api('/auth/mfa/setup', { method: 'POST' });
  modal('Включение 2FA', `
    <div class="hint" style="text-align:left;margin:0 0 8px">Добавьте в Google Authenticator / любой TOTP-аутентификатор:</div>
    <div>Ключ (ручной ввод): <code>${esc(s.secret)}</code></div>
    <div style="margin-top:6px;word-break:break-all;font-size:12px;color:#64748b">${esc(s.otpauth)}</div>
    <label style="margin-top:12px">Введите код из приложения</label><input id="mfa_setup_code" inputmode="numeric" placeholder="6 цифр" />
  `, async () => { await api('/auth/mfa/enable', { method: 'POST', body: { code: $('#mfa_setup_code').value.trim() } }); toast('2FA включена'); }, 'Подтвердить');
}
async function disableMfa() {
  modal('Отключить 2FA', `<label>Код из приложения (если требуется)</label><input id="mfa_off_code" inputmode="numeric" placeholder="6 цифр" />`,
    async () => { await api('/auth/mfa/disable', { method: 'POST', body: { code: $('#mfa_off_code').value.trim() } }); toast('2FA отключена'); }, 'Отключить');
}

// ---------- PIN app-lock ----------
let PIN_SET = false, LOCKED = false, pinBuf = '', pinMode = 'enter', pinFirst = '', pinAttempts = 0, idleTimer = null;
const IDLE_MS = 5 * 60 * 1000;

async function enforceLock() {
  try { const s = await api('/auth/security'); PIN_SET = s.pinSet; } catch { PIN_SET = false; }
  // No PIN yet → force creation; PIN exists → require it on entry.
  openLock(PIN_SET ? 'enter' : 'create');
}
function openLock(mode) {
  LOCKED = true; pinMode = mode; pinBuf = ''; pinFirst = '';
  $('#modalRoot').innerHTML = '';
  renderLock();
  $('#lock').classList.remove('hidden');
}
function closeLock() { LOCKED = false; $('#lock').classList.add('hidden'); pinBuf = ''; pinFirst = ''; resetIdle(); }
function lockNow() { if (PIN_SET && !LOCKED && ME) openLock('enter'); }
function lockTitle() {
  if (pinMode === 'create') return ['Создайте PIN-код', 'Придумайте 4–8 цифр для быстрого входа'];
  if (pinMode === 'confirm') return ['Повторите PIN-код', 'Введите те же цифры ещё раз'];
  return ['Введите PIN-код', ME ? ME.fullName : ''];
}
function renderLock(err) {
  const [title, sub] = lockTitle();
  const dots = Array.from({ length: Math.max(4, pinBuf.length) }).map((_, i) => `<div class="pin-dot ${i < pinBuf.length ? 'on' : ''}"></div>`).join('');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => `<div class="pin-key" data-k="${k}">${k}</div>`).join('');
  $('#lock').innerHTML = `<div class="lock-card">
    <div class="logo">${esc((TENANT?.brandName || 'T').charAt(0).toUpperCase())}</div>
    <h2>${esc(title)}</h2><div class="lk-sub">${esc(sub || '')}</div>
    <div class="pin-dots">${dots}</div>
    <div class="pin-pad">${keys}
      <div class="pin-key wide" data-act="del">⌫</div>
      <div class="pin-key" data-k="0">0</div>
      <div class="pin-key wide" data-act="ok">✓</div>
    </div>
    <div class="error">${err ? esc(err) : ''}</div>
    <div class="lk-foot"><a href="#" class="link" id="lockLogout">Выйти</a><span style="color:#94a3b8">TTR ONE</span></div>
  </div>`;
  $('#lock').querySelectorAll('[data-k]').forEach((b) => b.onclick = () => pinPress(b.getAttribute('data-k')));
  $('#lock').querySelector('[data-act="del"]').onclick = () => { pinBuf = pinBuf.slice(0, -1); renderLock(); };
  $('#lock').querySelector('[data-act="ok"]').onclick = pinSubmit;
  $('#lockLogout').onclick = (e) => { e.preventDefault(); LOCKED = false; $('#lock').classList.add('hidden'); logout(); };
}
function pinPress(d) { if (pinBuf.length < 8) { pinBuf += d; renderLock(); } }
async function pinSubmit() {
  if (pinBuf.length < 4) { renderLock('Минимум 4 цифры'); return; }
  if (pinMode === 'create') { pinFirst = pinBuf; pinMode = 'confirm'; pinBuf = ''; renderLock(); return; }
  if (pinMode === 'confirm') {
    if (pinBuf !== pinFirst) { pinMode = 'create'; pinBuf = ''; pinFirst = ''; renderLock('PIN-коды не совпали — начните заново'); return; }
    try { await api('/auth/pin/set', { method: 'POST', body: { pin: pinBuf } }); PIN_SET = true; closeLock(); toast('PIN-код создан'); }
    catch (e) { renderLock(e.message); }
    return;
  }
  // enter
  try {
    const r = await api('/auth/pin/verify', { method: 'POST', body: { pin: pinBuf } });
    if (r.noPin) { PIN_SET = false; pinMode = 'create'; pinBuf = ''; renderLock('PIN не задан — создайте новый'); return; }
    if (r.ok) { pinAttempts = 0; closeLock(); }
    else {
      pinAttempts++; pinBuf = '';
      if (pinAttempts >= 5) { LOCKED = false; $('#lock').classList.add('hidden'); toast('Слишком много попыток — войдите заново', true); logout(); }
      else renderLock(`Неверный PIN (попытка ${pinAttempts}/5)`);
    }
  } catch (e) { renderLock(e.message); }
}
function resetIdle() { clearTimeout(idleTimer); if (PIN_SET && !LOCKED) idleTimer = setTimeout(lockNow, IDLE_MS); }
['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'].forEach((ev) => document.addEventListener(ev, () => { if (!LOCKED) resetIdle(); }, { passive: true }));
document.addEventListener('keydown', (e) => {
  // Ctrl+L (or Cmd+L) locks the screen.
  if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); lockNow(); return; }
  if (!LOCKED) return;
  if (/^[0-9]$/.test(e.key)) pinPress(e.key);
  else if (e.key === 'Backspace') { pinBuf = pinBuf.slice(0, -1); renderLock(); }
  else if (e.key === 'Enter') pinSubmit();
});

// ---------- forgot / reset password (pre-login) ----------
$('#forgotLink').addEventListener('click', (e) => {
  e.preventDefault();
  modal('Восстановление пароля', `
    <label>Email</label><input id="fp_email" type="email" value="${esc($('#email').value || '')}" />
    <label>Тенант <span style="color:#94a3b8">(необязательно)</span></label><input id="fp_tenant" placeholder="demo-factory" />
  `, async () => {
    const r = await api('/auth/forgot-password', { method: 'POST', retry: false, body: { email: $('#fp_email').value.trim(), tenant: $('#fp_tenant').value.trim() || undefined } });
    if (r.devResetToken) setTimeout(() => openResetModal(r.devResetToken), 0);
    else toast('Если аккаунт существует, ссылка отправлена на email');
  }, 'Получить ссылку');
});
function openResetModal(token) {
  modal('Новый пароль', `
    <div class="hint" style="text-align:left;margin:0 0 10px">Dev-режим: токен сброса подставлен автоматически (в проде придёт на email).</div>
    <label>Новый пароль</label><input id="rp_new" type="password" placeholder="минимум 8 символов" />
    <label>Повторите пароль</label><input id="rp_new2" type="password" />
  `, async () => {
    const n = $('#rp_new').value, n2 = $('#rp_new2').value;
    if (n !== n2) throw new Error('Пароли не совпадают');
    await api('/auth/reset-password', { method: 'POST', retry: false, body: { token, newPassword: n } });
    toast('Пароль сброшен — войдите с новым паролем');
  }, 'Сбросить пароль');
}

// ---------- navigation ----------
// module: null = core (always available); otherwise gated by tenant's enabled modules.
const VIEWS = [
  { id: 'dashboard', label: 'Дашборд', ico: '▦', perm: null, module: null },
  { id: 'inventory', label: 'Склад', ico: '▤', perm: 'warehouse.read', module: 'warehouse' },
  { id: 'movements', label: 'Движения', ico: '⇄', perm: 'warehouse.read', module: 'warehouse' },
  { id: 'products', label: 'Товары', ico: '▣', perm: 'catalog.read', module: 'catalog' },
  { id: 'warehouses', label: 'Склады', ico: '⌂', perm: 'warehouse.read', module: 'warehouse' },
  { id: 'companies', label: 'Компании', ico: '☰', perm: 'org.read', module: null },
  { id: 'users', label: 'Пользователи', ico: '☺', perm: 'admin.users', module: null },
  { id: 'roles', label: 'Роли и права', ico: '⚿', perm: 'admin.roles', module: null },
  { id: 'audit', label: 'Аудит', ico: '≡', perm: 'audit.read', module: null },
  { id: 'billing', label: 'Подписка', ico: '₴', perm: 'tenant.manage', module: null },
  { id: 'settings', label: 'Настройки', ico: '⚙', perm: 'tenant.manage', module: null },
  { id: 'platform', label: 'Супер-админ', ico: '★', perm: null, module: null, admin: true },
];
let ENABLED = new Set();
let TENANT = null;
let SUB = null;
const visibleView = (v) =>
  (!v.perm || can(v.perm)) && (!v.module || ENABLED.has(v.module)) && (!v.admin || ME?.platformAdmin);
function renderNav(active) {
  const nav = $('#nav'); nav.innerHTML = '';
  for (const v of VIEWS) {
    if (!visibleView(v)) continue;
    const a = el(`<a href="#${v.id}" class="${v.id === active ? 'active' : ''}"><span class="ico">${v.ico}</span>${v.label}</a>`);
    nav.appendChild(a);
  }
}
window.addEventListener('hashchange', () => { ME ? route() : showAuth(); });
function route() {
  if (!ME) return;
  const id = (location.hash.replace('#', '') || 'dashboard');
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0];
  if (!visibleView(view)) return (location.hash = 'dashboard');
  renderNav(view.id);
  $('#pageTitle').textContent = view.label;
  RENDER[view.id]();
}

// ---------- boot ----------
async function boot() {
  if (!ME) { const d = await api('/auth/me'); ME = d.user; }
  try {
    const s = await api('/tenant/settings');
    ENABLED = new Set(s.modules.filter((m) => m.enabled).map((m) => m.key));
    TENANT = s.tenant;
  } catch { ENABLED = new Set(['catalog', 'warehouse']); }
  try { SUB = await api('/billing/subscription'); } catch { SUB = null; }
  applyBranding();
  $('#login').classList.add('hidden'); $('#register').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#userName').textContent = ME.fullName;
  $('#avatar').textContent = (ME.fullName || '?').charAt(0).toUpperCase();
  $('#tenantName').textContent = TENANT?.name || '';
  updateBanner();
  const id = location.hash.replace('#', '');
  if (!id || ['login', 'register', 'accept-invite'].includes(id)) location.hash = 'dashboard';
  route();
  await enforceLock();
}
function applyBranding() {
  const color = TENANT?.brandColor;
  const name = TENANT?.brandName || 'TTR ONE';
  if (color) { document.documentElement.style.setProperty('--brand', color); document.documentElement.style.setProperty('--brand-dark', color); }
  else { document.documentElement.style.removeProperty('--brand'); document.documentElement.style.removeProperty('--brand-dark'); }
  const sb = $('#sideBrand'); if (sb) sb.textContent = name;
  const sl = $('#sideLogo'); if (sl) sl.textContent = (name.charAt(0) || 'T').toUpperCase();
}
function updateBanner() {
  const b = $('#banner'); if (!b) return;
  if (!SUB) { b.innerHTML = ''; return; }
  if (SUB.status === 'trialing') {
    b.className = 'banner trial';
    b.innerHTML = `🎁 Пробный период: осталось <b>${SUB.trialDaysLeft ?? 0}</b> дн. ${can('tenant.manage') ? '<a href="#billing" class="banner-link">Оформить подписку</a>' : ''}`;
  } else if (SUB.status === 'past_due' || SUB.status === 'cancelled') {
    b.className = 'banner past';
    b.innerHTML = `⚠ Подписка неактивна — изменение данных заблокировано. ${can('tenant.manage') ? '<a href="#billing" class="banner-link">Оплатить</a>' : 'Обратитесь к администратору.'}`;
  } else { b.className = 'banner'; b.innerHTML = ''; }
}

// ---------- pre-auth screen switching ----------
function getQueryParam(name) { return new URLSearchParams(location.search).get(name); }
function showAuth() {
  const h = location.hash.replace('#', '');
  const inviteToken = getQueryParam('invite');
  const wantInvite = h === 'accept-invite' || !!inviteToken;
  const wantReg = h === 'register';
  $('#app').classList.add('hidden');
  $('#accept-invite').classList.toggle('hidden', !wantInvite);
  $('#register').classList.toggle('hidden', wantReg || wantInvite ? !wantReg : true);
  $('#login').classList.toggle('hidden', wantReg || wantInvite);
  if (wantReg) populateIndustries();
  if (wantInvite && inviteToken) loadInvite(inviteToken);
}
let INVITE_TOKEN = null;
async function loadInvite(token) {
  INVITE_TOKEN = token;
  try {
    const r = await api(`/auth/invite?token=${encodeURIComponent(token)}`, { retry: false });
    if (!r.valid) { $('#inviteSub').textContent = 'Приглашение недействительно или истекло'; return; }
    $('#inviteSub').innerHTML = `Приглашение в <b>${esc(r.tenant)}</b> для <b>${esc(r.email)}</b>`;
  } catch { $('#inviteSub').textContent = 'Не удалось загрузить приглашение'; }
}
$('#acceptForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#acceptError').textContent = '';
  try {
    const d = await api('/auth/accept-invite', { method: 'POST', retry: false, body: { token: INVITE_TOKEN, fullName: $('#a_name').value.trim(), password: $('#a_password').value } });
    store.access = d.accessToken; store.refresh = d.refreshToken; ME = d.user;
    history.replaceState(null, '', '/app.html');
    toast('Добро пожаловать в команду!');
    await boot();
  } catch (err) { $('#acceptError').textContent = err.message; }
});
const INDUSTRIES = [
  ['manufacturing', 'Производство'], ['retail', 'Ритейл / Магазин'], ['ecommerce', 'Интернет-магазин'],
  ['wholesale', 'Оптовая торговля'], ['construction', 'Строительство'], ['services', 'Услуги'],
  ['logistics', 'Логистика'], ['other', 'Другое'],
];
function populateIndustries() {
  const s = $('#r_industry');
  if (s && !s.options.length) s.innerHTML = INDUSTRIES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
}

// ---------- modal ----------
function modal(title, bodyHtml, onSubmit, submitLabel = 'Save') {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-bg"><div class="modal">
    <h3>${esc(title)}</h3><div class="body">${bodyHtml}</div>
    <div class="foot"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">${esc(submitLabel)}</button></div>
  </div></div>`;
  const close = () => (root.innerHTML = '');
  $('#mCancel').onclick = close;
  root.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
  $('#mOk').onclick = async () => {
    try { await onSubmit(); close(); } catch (err) { toast(err.message, true); }
  };
  return close;
}

// ---------- views ----------
const RENDER = {};

RENDER.dashboard = async () => {
  const c = $('#content'); c.innerHTML = '<div class="empty">Loading…</div>';
  const [stockR, prodR, whR, movR] = await Promise.all([
    can('warehouse.read') ? api('/warehouse/stock') : { stock: [] },
    can('catalog.read') ? api('/catalog/products') : { products: [] },
    can('warehouse.read') ? api('/warehouse/warehouses') : { warehouses: [] },
    can('warehouse.read') ? api('/warehouse/movements?pageSize=8') : { movements: [] },
  ]);
  const priceBySku = Object.fromEntries(prodR.products.map((p) => [p.sku, p.priceMinor]));
  let value = 0; for (const s of stockR.stock) value += (priceBySku[s.sku] || 0) * Number(s.quantity);
  const low = stockR.stock.filter((s) => Number(s.available) <= 0).length;
  // Onboarding checklist (first-run) — hidden once the basics are done.
  const steps = [
    { done: whR.warehouses.length > 0, label: 'Создать склад', to: 'warehouses' },
    { done: prodR.products.length > 0, label: 'Добавить товары', to: 'products' },
    { done: (movR.movements || []).length > 0, label: 'Оприходовать остатки', to: 'inventory' },
    { done: SUB && SUB.status !== 'trialing', label: 'Оформить подписку', to: 'billing' },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const onboarding = doneCount < steps.length && can('tenant.manage') ? `
    <div class="panel"><div class="panel-head"><h2>Первые шаги (${doneCount}/${steps.length})</h2></div>
      <div class="panel-body" style="padding:14px 18px"><div class="checklist">
      ${steps.map((s) => `<a class="checkitem ${s.done ? 'done' : ''}" href="#${s.to}"><span class="ck">${s.done ? '✓' : '○'}</span>${s.label}</a>`).join('')}
      </div></div></div>` : '';
  c.innerHTML = `
    ${onboarding}
    <div class="kpis">
      <div class="kpi"><div class="k-label">Товары</div><div class="k-value">${prodR.products.length}</div></div>
      <div class="kpi"><div class="k-label">Склады</div><div class="k-value">${whR.warehouses.length}</div></div>
      <div class="kpi"><div class="k-label">Стоимость запасов</div><div class="k-value">${money(value)}</div></div>
      <div class="kpi"><div class="k-label">Нет в наличии</div><div class="k-value ${low ? 'low' : ''}">${low}</div></div>
    </div>
    <div class="panel"><div class="panel-head"><h2>Последние движения</h2></div>
      <div class="panel-body">${movTable(movR.movements)}</div></div>`;
};

function movTable(rows) {
  if (!rows.length) return '<div class="empty">No movements yet.</div>';
  return `<table><thead><tr><th>Type</th><th>Product</th><th>Warehouse</th><th class="num">Qty</th><th class="num">Balance</th><th>Reason</th><th>When</th></tr></thead><tbody>${
    rows.map((m) => `<tr>
      <td><span class="tag ${m.type.toLowerCase()}">${m.type}</span></td>
      <td>${esc(m.product)}<br><small style="color:#94a3b8">${esc(m.sku)}</small></td>
      <td>${esc(m.warehouse)}</td>
      <td class="num">${num(m.quantity)}</td>
      <td class="num">${num(m.balanceAfter)}</td>
      <td>${esc(m.reason || '')}</td>
      <td>${new Date(m.createdAt).toLocaleString('ru-RU')}</td></tr>`).join('')
  }</tbody></table>`;
}

RENDER.inventory = async () => {
  const c = $('#content'); c.innerHTML = '<div class="empty">Loading…</div>';
  const [stockR, whR, prodR] = await Promise.all([
    api('/warehouse/stock'), api('/warehouse/warehouses'), api('/catalog/products'),
  ]);
  const moveBtns = can('warehouse.move')
    ? `<button class="btn green sm" id="rcv">Receive</button><button class="btn red sm" id="iss">Issue</button>
       <button class="btn amber sm" id="adj">Adjust</button><button class="btn ghost sm" id="trf">Transfer</button>`
    : '';
  c.innerHTML = `<div class="panel"><div class="panel-head"><h2>Stock on hand</h2><div class="toolbar">${moveBtns}</div></div>
    <div class="panel-body">${stockTable(stockR.stock)}</div></div>`;
  const openMove = (type) => stockModal(type, whR.warehouses, prodR.products);
  if (can('warehouse.move')) {
    $('#rcv').onclick = () => openMove('IN'); $('#iss').onclick = () => openMove('OUT');
    $('#adj').onclick = () => openMove('ADJUST'); $('#trf').onclick = () => transferModal(whR.warehouses, prodR.products);
  }
};
function stockTable(rows) {
  if (!rows.length) return '<div class="empty">No stock records yet. Use “Receive” to add opening stock.</div>';
  return `<table><thead><tr><th>Product</th><th>SKU</th><th>Warehouse</th><th class="num">On hand</th><th class="num">Reserved</th><th class="num">Available</th><th>Unit</th></tr></thead><tbody>${
    rows.map((s) => `<tr><td>${esc(s.product)}</td><td><small>${esc(s.sku)}</small></td><td>${esc(s.warehouse)}</td>
      <td class="num">${num(s.quantity)}</td><td class="num">${num(s.reserved)}</td>
      <td class="num ${Number(s.available) <= 0 ? 'low' : ''}">${num(s.available)}</td><td>${esc(s.unit)}</td></tr>`).join('')
  }</tbody></table>`;
}
function opts(list, val, label) { return list.map((x) => `<option value="${x[val]}">${esc(x[label])}</option>`).join(''); }
function stockModal(type, warehouses, products) {
  const titles = { IN: 'Receive stock', OUT: 'Issue stock', ADJUST: 'Adjust / stock count' };
  const qtyLabel = type === 'ADJUST' ? 'New counted quantity' : 'Quantity';
  modal(titles[type], `
    <label>Warehouse</label><select id="f_wh">${opts(warehouses, 'id', 'name')}</select>
    <label>Product</label><select id="f_prod">${opts(products.filter(p=>p.type==='stockable'), 'id', 'name')}</select>
    <label>${qtyLabel}</label><input id="f_qty" type="number" step="0.001" min="0" value="1" />
    <label>Reason</label><input id="f_reason" placeholder="e.g. GRN #123 / production issue" />
  `, async () => {
    await api('/warehouse/movements', { method: 'POST', body: {
      warehouseId: $('#f_wh').value, productId: $('#f_prod').value, type,
      quantity: Number($('#f_qty').value), reason: $('#f_reason').value || undefined,
    }});
    toast('Stock movement recorded'); route();
  }, titles[type]);
}
function transferModal(warehouses, products) {
  modal('Transfer between warehouses', `
    <div class="row2"><div><label>From</label><select id="t_from">${opts(warehouses,'id','name')}</select></div>
    <div><label>To</label><select id="t_to">${opts(warehouses,'id','name')}</select></div></div>
    <label>Product</label><select id="t_prod">${opts(products.filter(p=>p.type==='stockable'),'id','name')}</select>
    <label>Quantity</label><input id="t_qty" type="number" step="0.001" min="0.001" value="1" />
    <label>Reason</label><input id="t_reason" placeholder="e.g. move to production line" />
  `, async () => {
    await api('/warehouse/transfer', { method: 'POST', body: {
      fromWarehouseId: $('#t_from').value, toWarehouseId: $('#t_to').value,
      productId: $('#t_prod').value, quantity: Number($('#t_qty').value), reason: $('#t_reason').value || undefined,
    }});
    toast('Transfer completed'); route();
  }, 'Transfer');
}

RENDER.movements = async () => {
  const c = $('#content'); c.innerHTML = '<div class="empty">Loading…</div>';
  const m = await api(`/warehouse/movements?page=${PAGE.movements}&pageSize=${PAGE_SIZE}`);
  c.innerHTML = `<div class="panel"><div class="panel-head"><h2>Movement ledger</h2></div>
    <div class="panel-body">${movTable(m.movements)}</div>${pagerHtml(m.meta, 'movements')}</div>`;
  wirePager();
};

let productSearch = '';
RENDER.products = async () => {
  const c = $('#content'); c.innerHTML = '<div class="empty">Loading…</div>';
  const query = `page=${PAGE.products}&pageSize=${PAGE_SIZE}${productSearch ? '&search=' + encodeURIComponent(productSearch) : ''}`;
  const [p, units, cats] = await Promise.all([api('/catalog/products?' + query), can('catalog.write') ? api('/catalog/units') : {units:[]}, can('catalog.write') ? api('/catalog/categories') : {categories:[]}]);
  const addBtn = can('catalog.write') ? '<button class="btn sm" id="addProd">+ Product</button>' : '';
  c.innerHTML = `<div class="panel"><div class="panel-head"><h2>Products</h2>
    <div class="toolbar"><input id="pSearch" placeholder="Search SKU / name…" value="${esc(productSearch)}" />${addBtn}</div></div>
    <div class="panel-body"><table><thead><tr><th>SKU</th><th>Name</th><th>Category</th><th>Unit</th><th>Type</th><th class="num">Price</th></tr></thead>
    <tbody>${p.products.map((x)=>`<tr><td><small>${esc(x.sku)}</small></td><td>${esc(x.name)}</td>
      <td>${esc(x.category?.name||'—')}</td><td>${esc(x.unit?.code||'—')}</td>
      <td><span class="tag muted">${x.type}</span></td><td class="num">${x.priceMinor == null ? '—' : money(x.priceMinor, x.currency)}</td></tr>`).join('') || '<tr><td colspan=6 class=empty>No products</td></tr>'}
    </tbody></table></div>${pagerHtml(p.meta, 'products')}</div>`;
  wirePager();
  const si = $('#pSearch');
  if (si) si.addEventListener('keydown', (e) => { if (e.key === 'Enter') { productSearch = si.value.trim(); PAGE.products = 1; RENDER.products(); } });
  if (can('catalog.write')) $('#addProd').onclick = () => modal('New product', `
    <label>SKU</label><input id="p_sku" />
    <label>Name</label><input id="p_name" />
    <div class="row2"><div><label>Unit</label><select id="p_unit"><option value="">—</option>${opts(units.units,'id','name')}</select></div>
    <div><label>Category</label><select id="p_cat"><option value="">—</option>${opts(cats.categories,'id','name')}</select></div></div>
    <label>Цена (в сумах)</label><input id="p_price" type="number" min="0" step="0.01" value="0" />
  `, async () => {
    await api('/catalog/products', { method: 'POST', body: {
      sku: $('#p_sku').value.trim(), name: $('#p_name').value.trim(),
      unitId: $('#p_unit').value || undefined, categoryId: $('#p_cat').value || undefined,
      priceMinor: Math.round((Number($('#p_price').value) || 0) * 100),
    }});
    toast('Product created'); route();
  }, 'Create');
};

RENDER.warehouses = async () => {
  const c = $('#content'); c.innerHTML = '<div class="empty">Loading…</div>';
  const w = await api('/warehouse/warehouses');
  const addBtn = can('warehouse.manage') ? '<button class="btn sm" id="addWh">+ Warehouse</button>' : '';
  c.innerHTML = `<div class="panel"><div class="panel-head"><h2>Warehouses</h2><div class="toolbar">${addBtn}</div></div>
    <div class="panel-body"><table><thead><tr><th>Code</th><th>Name</th><th>Address</th></tr></thead>
    <tbody>${w.warehouses.map((x)=>`<tr><td><small>${esc(x.code)}</small></td><td>${esc(x.name)}</td><td>${esc(x.address||'—')}</td></tr>`).join('')||'<tr><td colspan=3 class=empty>None</td></tr>'}</tbody></table></div></div>`;
  if (can('warehouse.manage')) $('#addWh').onclick = () => modal('New warehouse', `
    <label>Code</label><input id="w_code" placeholder="WH-02" />
    <label>Name</label><input id="w_name" />
    <label>Address</label><input id="w_addr" />
  `, async () => {
    await api('/warehouse/warehouses', { method: 'POST', body: { code: $('#w_code').value.trim(), name: $('#w_name').value.trim(), address: $('#w_addr').value || undefined }});
    toast('Warehouse created'); route();
  }, 'Create');
};

RENDER.companies = async () => {
  const c = $('#content'); c.innerHTML = '<div class="empty">Loading…</div>';
  const r = await api('/org/companies');
  const addBtn = can('org.manage') ? '<button class="btn sm" id="addCo">+ Company</button>' : '';
  c.innerHTML = `<div class="panel"><div class="panel-head"><h2>Companies</h2><div class="toolbar">${addBtn}</div></div>
    <div class="panel-body"><table><thead><tr><th>Code</th><th>Name</th><th>Currency</th><th class="num">Branches</th><th class="num">Warehouses</th></tr></thead>
    <tbody>${r.companies.map((x)=>`<tr><td><small>${esc(x.code)}</small></td><td>${esc(x.name)}</td><td>${esc(x.currency)}</td>
      <td class="num">${x._count?.branches??0}</td><td class="num">${x._count?.warehouses??0}</td></tr>`).join('')}</tbody></table></div></div>`;
  if (can('org.manage')) $('#addCo').onclick = () => modal('New company', `
    <label>Code</label><input id="c_code" placeholder="MAIN2" />
    <label>Name</label><input id="c_name" />
    <label>Currency</label><input id="c_cur" value="UZS" />
  `, async () => {
    await api('/org/companies', { method: 'POST', body: { code: $('#c_code').value.trim(), name: $('#c_name').value.trim(), currency: $('#c_cur').value.trim() || 'UZS' }});
    toast('Company created'); route();
  }, 'Create');
};

let ROLE_LIST = [];
RENDER.users = async () => {
  const c = $('#content'); c.innerHTML = '<div class="empty">Loading…</div>';
  const [u, roles, invs, whs] = await Promise.all([
    api('/admin/users'), api('/admin/roles').catch(() => ({ roles: [] })),
    api('/admin/invitations').catch(() => ({ invitations: [] })), api('/warehouse/warehouses').catch(() => ({ warehouses: [] })),
  ]);
  ROLE_LIST = roles.roles.length ? roles.roles : [{ code: 'owner' }, { code: 'warehouse_manager' }, { code: 'operator' }, { code: 'viewer' }];
  const WH = whs.warehouses;
  c.innerHTML = `
    <div class="panel"><div class="panel-head"><h2>Пользователи</h2><div class="toolbar">
      <button class="btn sm" id="inviteUser">Пригласить</button><button class="btn ghost sm" id="addUser">+ Вручную</button></div></div>
      <div class="panel-body"><table><thead><tr><th>Имя</th><th>Email</th><th>Роли</th><th>Статус</th><th>Вход</th><th></th></tr></thead>
      <tbody>${u.users.map((x) => `<tr><td>${esc(x.fullName)}</td><td>${esc(x.email)}</td>
        <td>${x.roles.map((r) => `<span class="tag muted">${esc(r)}</span>`).join(' ')}</td>
        <td>${x.status}</td><td>${x.lastLoginAt ? new Date(x.lastLoginAt).toLocaleString('ru-RU') : '—'}</td>
        <td><button class="btn ghost sm" data-scope="${x.id}" data-name="${esc(x.fullName)}">Склады</button></td></tr>`).join('')}</tbody></table></div></div>
    <div class="panel"><div class="panel-head"><h2>Приглашения</h2></div><div class="panel-body">
      <table><thead><tr><th>Email</th><th>Роли</th><th>Истекает</th><th></th></tr></thead>
      <tbody>${invs.invitations.map((i) => `<tr><td>${esc(i.email)}</td><td>${esc(i.roleCodes)}</td>
        <td>${new Date(i.expiresAt).toLocaleDateString('ru-RU')}</td>
        <td><button class="btn ghost sm" data-revinv="${i.id}">Отозвать</button></td></tr>`).join('') || '<tr><td colspan=4 class=empty>Нет активных приглашений</td></tr>'}</tbody></table>
    </div></div>`;
  $('#addUser').onclick = () => modal('Новый пользователь', `
    <label>Имя</label><input id="u_name" />
    <label>Email</label><input id="u_email" type="email" />
    <label>Пароль</label><input id="u_pass" type="text" value="Welcome123!" />
    <label>Роль</label><select id="u_role">${ROLE_LIST.map((r) => `<option value="${r.code}">${esc(r.name || r.code)}</option>`).join('')}</select>
  `, async () => {
    await api('/admin/users', { method: 'POST', body: { fullName: $('#u_name').value.trim(), email: $('#u_email').value.trim(), password: $('#u_pass').value, roleCodes: [$('#u_role').value] } });
    toast('Пользователь создан'); route();
  }, 'Создать');
  $('#inviteUser').onclick = () => modal('Пригласить сотрудника', `
    <label>Email</label><input id="i_email" type="email" />
    <label>Роль</label><select id="i_role">${ROLE_LIST.map((r) => `<option value="${r.code}">${esc(r.name || r.code)}</option>`).join('')}</select>
  `, async () => {
    const r = await api('/admin/invitations', { method: 'POST', body: { email: $('#i_email').value.trim(), roleCodes: [$('#i_role').value] } });
    if (r.devInviteLink) { await navigator.clipboard?.writeText(r.devInviteLink).catch(() => {}); toast('Ссылка-приглашение скопирована (dev)'); promptInviteLink(r.devInviteLink); }
    else toast('Приглашение отправлено на email');
    RENDER.users();
  }, 'Пригласить');
  document.querySelectorAll('[data-revinv]').forEach((b) => b.onclick = async () => { await api(`/admin/invitations/${b.getAttribute('data-revinv')}/revoke`, { method: 'POST' }); toast('Отозвано'); RENDER.users(); });
  document.querySelectorAll('[data-scope]').forEach((b) => b.onclick = () => editUserScope(b.getAttribute('data-scope'), b.getAttribute('data-name'), WH));
};
function promptInviteLink(link) {
  modal('Ссылка-приглашение', `<div class="hint" style="text-align:left;margin:0 0 8px">Отправьте эту ссылку сотруднику (в проде уйдёт на email):</div>
    <input value="${esc(link)}" readonly onclick="this.select()" />`, async () => {}, 'Готово');
}
async function editUserScope(userId, name, WH) {
  const cur = await api(`/admin/users/${userId}/warehouses`);
  const set = new Set(cur.warehouseIds);
  modal(`Доступ к складам: ${name}`, `
    <div class="hint" style="text-align:left;margin:0 0 8px">Отметьте склады. Если ничего не выбрано — доступ ко всем складам.</div>
    ${WH.map((w) => `<label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" value="${w.id}" ${set.has(w.id) ? 'checked' : ''} style="width:auto"/> ${esc(w.name)} <small style="color:#94a3b8">${esc(w.code)}</small></label>`).join('')}
  `, async () => {
    const ids = [...document.querySelectorAll('.modal input[type=checkbox]:checked')].map((c) => c.value);
    await api(`/admin/users/${userId}/warehouses`, { method: 'PUT', body: { warehouseIds: ids } });
    toast('Доступ обновлён');
  }, 'Сохранить');
}

RENDER.roles = async () => {
  const c = $('#content'); c.innerHTML = '<div class="empty">Loading…</div>';
  const [rolesR, permsR] = await Promise.all([api('/admin/roles'), api('/admin/permissions')]);
  const perms = permsR.permissions;
  c.innerHTML = `<div class="panel"><div class="panel-head"><h2>Роли и права</h2><div class="toolbar"><button class="btn sm" id="addRole">+ Роль</button></div></div>
    <div class="panel-body"><table><thead><tr><th>Роль</th><th>Код</th><th class="num">Прав</th><th class="num">Польз.</th><th></th></tr></thead>
    <tbody>${rolesR.roles.map((r) => `<tr><td>${esc(r.name)}</td><td><small>${esc(r.code)}</small></td>
      <td class="num">${r.permissions.length}</td><td class="num">${r.users}</td>
      <td><button class="btn ghost sm" data-editrole="${r.id}">Права</button></td></tr>`).join('')}</tbody></table></div></div>`;
  const permsHtml = (checked) => {
    const byMod = {};
    for (const p of perms) (byMod[p.module] ||= []).push(p);
    return Object.entries(byMod).map(([mod, ps]) => `<div style="margin-top:8px"><b style="font-size:13px">${esc(mod)}</b>${
      ps.map((p) => `<label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" value="${p.code}" ${checked.has(p.code) ? 'checked' : ''} style="width:auto"/> ${esc(p.code)} <small style="color:#94a3b8">${esc(p.description)}</small></label>`).join('')
    }</div>`).join('');
  };
  $('#addRole').onclick = () => modal('Новая роль', `
    <div class="row2"><div><label>Название</label><input id="r_name" /></div><div><label>Код</label><input id="r_code" placeholder="sales_manager" /></div></div>
    <label>Права</label><div style="max-height:280px;overflow:auto">${permsHtml(new Set())}</div>
  `, async () => {
    const permissions = [...document.querySelectorAll('.modal input[type=checkbox]:checked')].map((c) => c.value);
    await api('/admin/roles', { method: 'POST', body: { name: $('#r_name').value.trim(), code: $('#r_code').value.trim(), permissions } });
    toast('Роль создана'); RENDER.roles();
  }, 'Создать');
  document.querySelectorAll('[data-editrole]').forEach((b) => b.onclick = async () => {
    const role = rolesR.roles.find((x) => x.id === b.getAttribute('data-editrole'));
    modal(`Права роли: ${role.name}`, `<div style="max-height:320px;overflow:auto">${permsHtml(new Set(role.permissions))}</div>`, async () => {
      const permissions = [...document.querySelectorAll('.modal input[type=checkbox]:checked')].map((c) => c.value);
      await api(`/admin/roles/${role.id}`, { method: 'PATCH', body: { permissions } });
      toast('Права обновлены'); RENDER.roles();
    }, 'Сохранить');
  });
};

RENDER.audit = async () => {
  const c = $('#content'); c.innerHTML = '<div class="empty">Loading…</div>';
  const r = await api(`/admin/audit?page=${PAGE.audit}&pageSize=${PAGE_SIZE}`);
  c.innerHTML = `<div class="panel"><div class="panel-head"><h2>Audit log</h2></div><div class="panel-body">
    <table><thead><tr><th>When</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
    <tbody>${r.logs.map((l)=>`<tr><td>${new Date(l.createdAt).toLocaleString('ru-RU')}</td>
      <td><span class="tag muted">${esc(l.action)}</span></td><td>${esc(l.entity)}</td>
      <td><small style="color:#64748b">${esc(l.meta||'')}</small></td></tr>`).join('')||'<tr><td colspan=4 class=empty>No events</td></tr>'}</tbody></table></div>${pagerHtml(r.meta, 'audit')}</div>`;
  wirePager();
};

RENDER.settings = async () => {
  const c = $('#content'); c.innerHTML = '<div class="empty">Loading…</div>';
  const s = await api('/tenant/settings');
  const canManage = can('tenant.manage');
  const industryLabel = (INDUSTRIES.find(([v]) => v === s.tenant.industry) || [null, s.tenant.industry || '—'])[1];
  c.innerHTML = `
    <div class="panel"><div class="panel-head"><h2>Компания</h2></div>
      <div class="panel-body" style="padding:18px 18px 20px">
        <div style="font-size:16px"><b>${esc(s.tenant.name)}</b></div>
        <div style="color:#64748b;margin-top:6px">
          Тариф: <b>${esc(s.tenant.plan)}</b> · статус: ${esc(s.tenant.status)} ·
          сфера: ${esc(industryLabel)} · адрес: <code>${esc(s.tenant.slug)}.app</code>
        </div>
      </div></div>
    <div class="panel"><div class="panel-head"><h2>Модули</h2>
      <span style="color:#64748b;font-size:13px">Включайте только нужное — как плагины</span></div>
      <div class="panel-body" style="padding:18px">
        <div class="modgrid">${s.modules.map((m) => moduleCard(m, canManage)).join('')}</div>
      </div></div>
    ${canManage ? `<div class="panel"><div class="panel-head"><h2>Оформление (White-label)</h2></div>
      <div class="panel-body" style="padding:18px">
        <div class="row2" style="max-width:520px">
          <div><label>Название бренда</label><input id="b_name" value="${esc(s.tenant.brandName || '')}" placeholder="TTR ONE" /></div>
          <div><label>Акцентный цвет</label><input id="b_color" type="color" value="${esc(s.tenant.brandColor || '#2563eb')}" style="height:42px;padding:4px" /></div>
        </div>
        <button class="btn sm" id="saveBrand" style="margin-top:14px">Сохранить оформление</button>
        <button class="btn ghost sm" id="resetBrand" style="margin-top:14px">Сбросить</button>
      </div></div>` : ''}`;
  wireModuleToggles();
  if (canManage) {
    $('#saveBrand').onclick = async () => {
      try {
        await api('/tenant/branding', { method: 'PATCH', body: { brandName: $('#b_name').value.trim() || null, brandColor: $('#b_color').value } });
        TENANT = { ...TENANT, brandName: $('#b_name').value.trim() || null, brandColor: $('#b_color').value };
        applyBranding(); toast('Оформление сохранено');
      } catch (e) { toast(e.message, true); }
    };
    $('#resetBrand').onclick = async () => {
      try { await api('/tenant/branding', { method: 'PATCH', body: { brandName: null, brandColor: null } });
        TENANT = { ...TENANT, brandName: null, brandColor: null }; applyBranding(); RENDER.settings(); toast('Оформление сброшено');
      } catch (e) { toast(e.message, true); }
    };
  }
};
function moduleCard(m, canManage) {
  const soon = m.status !== 'available';
  const badge = soon ? '<span class="tag muted">Скоро</span>'
    : (m.enabled ? '<span class="tag in">Включён</span>' : '<span class="tag muted">Выключен</span>');
  let action = '';
  if (soon) action = '<button class="btn ghost sm" disabled>Скоро</button>';
  else if (canManage) action = `<button class="btn ${m.enabled ? 'ghost' : ''} sm" data-mod="${m.key}" data-en="${m.enabled ? '0' : '1'}">${m.enabled ? 'Выключить' : 'Включить'}</button>`;
  return `<div class="modcard ${m.enabled ? 'on' : ''} ${soon ? 'soon' : ''}">
    <div class="modtop"><span class="modic">${m.icon}</span>${badge}</div>
    <h3>${esc(m.name)}</h3><p>${esc(m.description)}</p>${action}</div>`;
}
function wireModuleToggles() {
  document.querySelectorAll('[data-mod]').forEach((b) => b.addEventListener('click', async () => {
    const key = b.getAttribute('data-mod'); const en = b.getAttribute('data-en') === '1';
    try {
      await api(`/tenant/modules/${key}`, { method: 'PATCH', body: { enabled: en } });
      if (en) ENABLED.add(key); else ENABLED.delete(key);
      toast('Модуль обновлён'); renderNav('settings'); RENDER.settings();
    } catch (e) { toast(e.message, true); }
  }));
}

// ---------- billing / subscription ----------
let REQ = null, DETAILS = null;
RENDER.billing = async () => {
  const c = $('#content'); c.innerHTML = '<div class="empty">Loading…</div>';
  const [sub, plansR, invR, reqR, detR] = await Promise.all([
    api('/billing/subscription'), api('/billing/plans'), api('/billing/invoices'),
    api('/billing/requisites'), can('tenant.manage') ? api('/billing/details') : { details: {} },
  ]);
  SUB = sub; REQ = reqR.requisites; DETAILS = detR.details; updateBanner();
  const usage = sub.usage, lim = sub.limits;
  const usageRow = (label, u, m) => `<tr><td>${label}</td><td class="num">${u}</td><td class="num">${m === null ? '∞' : m}</td></tr>`;
  const statusTag = { trialing: '<span class="tag adjust">Пробный</span>', active: '<span class="tag in">Активна</span>', past_due: '<span class="tag out">Не оплачена</span>', cancelled: '<span class="tag out">Отменена</span>' }[sub.status] || sub.status;
  const rq = REQ || {};
  const detailsMissing = !DETAILS?.legalName || !DETAILS?.inn;
  c.innerHTML = `
    <div class="panel"><div class="panel-head"><h2>Текущая подписка</h2>${statusTag}</div>
      <div class="panel-body" style="padding:18px">
        <div>Тариф: <b>${esc(sub.planName)}</b>${sub.trialDaysLeft != null ? ` · пробный период: <b>${sub.trialDaysLeft}</b> дн.` : ''}${sub.currentPeriodEnd ? ` · оплачено до ${new Date(sub.currentPeriodEnd).toLocaleDateString('ru-RU')}` : ''}</div>
        <table style="margin-top:14px;max-width:420px"><thead><tr><th>Ресурс</th><th class="num">Исп.</th><th class="num">Лимит</th></tr></thead>
        <tbody>${usageRow('Пользователи', usage.users, lim.maxUsers)}${usageRow('Склады', usage.warehouses, lim.maxWarehouses)}${usageRow('Товары', usage.products, lim.maxProducts)}</tbody></table>
      </div></div>
    <div class="panel"><div class="panel-head"><h2>Тарифы</h2></div><div class="panel-body" style="padding:18px">
      <div class="plans">${plansR.plans.map((p) => planCard(p, sub)).join('')}</div></div></div>
    <div class="panel"><div class="panel-head"><h2>Реквизиты для оплаты (продавец)</h2></div>
      <div class="panel-body" style="padding:18px">
        <table style="max-width:640px"><tbody>
        <tr><td class="l" style="color:#64748b;width:200px">Наименование</td><td><b>${esc(rq.sellerName || '—')}</b></td></tr>
        <tr><td class="l" style="color:#64748b">ИНН</td><td>${esc(rq.sellerInn || '—')}</td></tr>
        <tr><td class="l" style="color:#64748b">Банк</td><td>${esc(rq.bank || '—')}</td></tr>
        <tr><td class="l" style="color:#64748b">Расчётный счёт</td><td>${esc(rq.account || '—')}</td></tr>
        <tr><td class="l" style="color:#64748b">МФО</td><td>${esc(rq.mfo || '—')}</td></tr>
        </tbody></table>
        <div style="color:#64748b;font-size:13px;margin-top:8px">Оплата по этим реквизитам — официально, банковским переводом. Доступ активируется после подтверждения оплаты.</div>
      </div></div>
    ${can('tenant.manage') ? `<div class="panel"><div class="panel-head"><h2>Платёжные реквизиты вашей компании</h2>
        ${detailsMissing ? '<span class="tag out">Заполните для счёта</span>' : '<span class="tag in">Заполнены</span>'}</div>
      <div class="panel-body" style="padding:18px"><button class="btn sm" id="editDetails">Редактировать реквизиты</button>
        <span style="color:#64748b;font-size:13px;margin-left:10px">${esc(DETAILS?.legalName || 'Юр. название и ИНН нужны для официального счёта')}</span></div></div>` : ''}
    <div class="panel"><div class="panel-head"><h2>Счета</h2></div><div class="panel-body">
      <table><thead><tr><th>№</th><th>Дата</th><th>Тариф</th><th>Способ</th><th class="num">Сумма</th><th>Статус</th><th></th></tr></thead>
      <tbody>${invR.invoices.map((i) => `<tr><td><small>${esc(i.number)}</small></td><td>${new Date(i.createdAt).toLocaleString('ru-RU')}</td><td>${esc(i.plan)}</td>
        <td>${i.method === 'bank_transfer' ? 'Реквизиты' : 'Карта'}</td>
        <td class="num">${money(i.amountMinor, i.currency)}</td>
        <td>${i.status === 'paid' ? '<span class="tag in">Оплачён</span>' : '<span class="tag muted">Ожидает</span>'}</td>
        <td>${i.method === 'bank_transfer' ? `<button class="btn ghost sm" data-doc="${i.id}">Открыть счёт</button>` : ''}</td></tr>`).join('') || '<tr><td colspan=7 class=empty>Счетов пока нет</td></tr>'}</tbody></table>
    </div></div>`;
  document.querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', () => subscribeFlow(b.getAttribute('data-plan'))));
  document.querySelectorAll('[data-doc]').forEach((b) => b.addEventListener('click', () => openInvoiceDoc(b.getAttribute('data-doc'))));
  const ed = $('#editDetails'); if (ed) ed.onclick = editBillingDetails;
};
async function openInvoiceDoc(id) {
  try {
    const res = await fetch(`${API}/billing/invoices/${id}/document`, { headers: { Authorization: 'Bearer ' + store.access } });
    if (!res.ok) { toast('Не удалось открыть счёт', true); return; }
    const html = await res.text();
    const w = window.open('', '_blank');
    if (!w) { toast('Разрешите всплывающие окна', true); return; }
    w.document.open(); w.document.write(html); w.document.close();
  } catch (e) { toast(e.message, true); }
}
function editBillingDetails() {
  const d = DETAILS || {};
  modal('Реквизиты компании (для счёта)', `
    <label>Юридическое название</label><input id="d_legal" value="${esc(d.legalName || '')}" />
    <div class="row2"><div><label>ИНН</label><input id="d_inn" value="${esc(d.inn || '')}" /></div>
    <div><label>МФО</label><input id="d_mfo" value="${esc(d.mfo || '')}" /></div></div>
    <label>Адрес</label><input id="d_addr" value="${esc(d.address || '')}" />
    <label>Банк</label><input id="d_bank" value="${esc(d.bank || '')}" />
    <label>Расчётный счёт</label><input id="d_acc" value="${esc(d.account || '')}" />
    <div class="row2"><div><label>Директор</label><input id="d_dir" value="${esc(d.director || '')}" /></div>
    <div><label>Телефон</label><input id="d_phone" value="${esc(d.phone || '')}" /></div></div>
  `, async () => {
    await api('/billing/details', { method: 'PATCH', body: {
      legalName: $('#d_legal').value.trim() || null, inn: $('#d_inn').value.trim() || null,
      mfo: $('#d_mfo').value.trim() || null, address: $('#d_addr').value.trim() || null,
      bank: $('#d_bank').value.trim() || null, account: $('#d_acc').value.trim() || null,
      director: $('#d_dir').value.trim() || null, phone: $('#d_phone').value.trim() || null,
    }});
    toast('Реквизиты сохранены'); RENDER.billing();
  }, 'Сохранить');
}
function planCard(p, sub) {
  const price = p.priceMinor === null ? 'по запросу' : (p.priceMinor === 0 ? 'бесплатно' : money(p.priceMinor, p.currency) + '/мес');
  const current = sub.plan === p.key;
  const canBuy = can('tenant.manage') && (p.key === 'starter' || p.key === 'business') && !current;
  const lim = (v) => v === null ? '∞' : v;
  return `<div class="plan ${p.highlight ? 'featured' : ''}">
    <h3>${esc(p.name)}</h3><div class="price">${price}</div>
    <ul style="list-style:none;text-align:left;margin:12px 0;color:#64748b;font-size:14px">
      <li>Пользователей: ${lim(p.maxUsers)}</li><li>Складов: ${lim(p.maxWarehouses)}</li><li>Товаров: ${lim(p.maxProducts)}</li></ul>
    ${current ? '<button class="btn ghost sm" disabled>Текущий</button>' : canBuy ? `<button class="btn sm" data-plan="${p.key}">Оформить</button>` : '<button class="btn ghost sm" disabled>—</button>'}
  </div>`;
}
function subscribeFlow(planKey) {
  // Choose method first: official bank transfer (invoice) or card (online).
  modal('Оформление тарифа', `
    <div>Тариф: <b>${esc(planKey)}</b></div>
    <label style="margin-top:12px">Способ оплаты</label>
    <select id="sub_method">
      <option value="bank_transfer">По реквизитам — счёт, банковский перевод (официально)</option>
      <option value="card">Картой онлайн</option>
    </select>
    <div class="hint" style="text-align:left;margin-top:10px">«По реквизитам» — мы выставим официальный счёт с нашими реквизитами; доступ откроется после подтверждения оплаты. «Картой» — мгновенно (сейчас тестовый режим).</div>
  `, async () => {
    const method = $('#sub_method').value;
    const { invoice } = await api('/billing/subscribe', { method: 'POST', body: { plan: planKey, method } });
    if (method === 'bank_transfer') {
      toast('Счёт создан');
      SUB = await api('/billing/subscription'); updateBanner();
      RENDER.billing();
      setTimeout(() => openInvoiceDoc(invoice.id), 100);
    } else {
      setTimeout(() => payByCard(invoice), 0);
    }
  }, 'Далее');
}
function payByCard(invoice) {
  modal('Оплата картой (тестовый режим)', `
    <div class="hint" style="text-align:left;margin:0 0 10px">Тестовая оплата — реальные деньги не списываются. Payme/Click/Stripe подключаются по ключам.</div>
    <div>К оплате: <b>${money(invoice.amountMinor, invoice.currency)}</b></div>
    <label style="margin-top:12px">Провайдер</label>
    <select id="pay_method"><option value="card">Тестовая карта (sandbox)</option><option value="payme">Payme (скоро)</option><option value="click">Click (скоро)</option><option value="stripe">Stripe (скоро)</option></select>
  `, async () => {
    await api('/billing/pay', { method: 'POST', body: { invoiceId: invoice.id, method: $('#pay_method').value } });
    toast('Оплата прошла — подписка активна');
    SUB = await api('/billing/subscription'); updateBanner(); RENDER.billing();
  }, 'Оплатить');
}

// ---------- super-admin (platform) ----------
RENDER.platform = async () => {
  const c = $('#content'); c.innerHTML = '<div class="empty">Loading…</div>';
  const [r, reqR, invR] = await Promise.all([
    api('/superadmin/tenants'), api('/superadmin/requisites'), api('/superadmin/invoices?status=open'),
  ]);
  const rq = reqR.requisites;
  const pending = invR.invoices.filter((i) => i.method === 'bank_transfer');
  c.innerHTML = `
    <div class="panel"><div class="panel-head"><h2>Счета на подтверждение (перевод)</h2><span style="color:#64748b;font-size:13px">${pending.length}</span></div>
      <div class="panel-body"><table><thead><tr><th>№</th><th>Компания</th><th>Тариф</th><th class="num">Сумма</th><th>Didox</th><th>Действия</th></tr></thead>
      <tbody>${pending.map((i) => `<tr><td><small>${esc(i.number)}</small></td><td>${esc(i.tenant)}</td><td>${esc(i.plan)}</td>
        <td class="num">${money(i.amountMinor, i.currency)}</td><td>${i.didoxId ? esc(i.didoxId) : '<span class="tag muted">нет</span>'}</td>
        <td><button class="btn green sm" data-pay="${i.id}">Подтвердить оплату</button> <button class="btn ghost sm" data-didox="${i.id}">Didox ЭСФ</button></td></tr>`).join('') || '<tr><td colspan=6 class=empty>Нет счетов, ожидающих оплаты</td></tr>'}</tbody></table></div></div>
    <div class="panel"><div class="panel-head"><h2>Реквизиты продавца</h2>${reqR.didoxConfigured ? '<span class="tag in">Didox подключён</span>' : '<span class="tag muted">Didox не настроен</span>'}</div>
      <div class="panel-body" style="padding:18px"><button class="btn sm" id="editReq">Редактировать реквизиты</button>
        <span style="color:#64748b;font-size:13px;margin-left:10px">${esc(rq.sellerName)} · ИНН ${esc(rq.sellerInn || '—')} · счёт ${esc(rq.account || '—')}</span></div></div>
    <div class="panel"><div class="panel-head"><h2>Все компании (SaaS)</h2><span style="color:#64748b;font-size:13px">${r.tenants.length} тенантов</span></div>
    <div class="panel-body"><table><thead><tr><th>Компания</th><th>Тариф</th><th>Подписка</th><th>Статус</th><th class="num">Польз.</th><th class="num">Товары</th><th>Действия</th></tr></thead>
    <tbody>${r.tenants.map((t) => `<tr>
      <td>${esc(t.name)}<br><small style="color:#94a3b8">${esc(t.slug)}</small></td>
      <td>${esc(t.plan)}</td>
      <td><span class="tag ${t.subscriptionStatus === 'active' ? 'in' : t.subscriptionStatus === 'trialing' ? 'adjust' : 'out'}">${esc(t.subscriptionStatus)}</span></td>
      <td>${esc(t.status)}</td><td class="num">${t.users}</td><td class="num">${t.products}</td>
      <td><button class="btn ghost sm" data-t="${t.id}" data-act="manage">Управлять</button></td></tr>`).join('')}</tbody></table></div></div>`;
  document.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/superadmin/invoices/${b.getAttribute('data-pay')}/mark-paid`, { method: 'POST' }); toast('Оплата подтверждена — подписка активна'); RENDER.platform(); }
    catch (e) { toast(e.message, true); }
  }));
  document.querySelectorAll('[data-didox]').forEach((b) => b.addEventListener('click', async () => {
    try { const res = await api(`/superadmin/invoices/${b.getAttribute('data-didox')}/didox`, { method: 'POST' }); toast('ЭСФ создана: ' + res.didoxId); RENDER.platform(); }
    catch (e) { toast(e.message, true); }
  }));
  $('#editReq').onclick = () => editSellerRequisites(rq);
  document.querySelectorAll('[data-act="manage"]').forEach((b) => b.addEventListener('click', () => {
    const t = r.tenants.find((x) => x.id === b.getAttribute('data-t'));
    modal(`Управление: ${t.name}`, `
      <label>Статус компании</label><select id="sa_status"><option value="active">active</option><option value="suspended">suspended</option><option value="cancelled">cancelled</option></select>
      <label>Тариф</label><select id="sa_plan"><option value="trial">trial</option><option value="starter">starter</option><option value="business">business</option><option value="enterprise">enterprise</option></select>
      <label>Продлить пробный период (дней)</label><input id="sa_ext" type="number" min="0" value="0" />
    `, async () => {
      const body = { status: $('#sa_status').value, plan: $('#sa_plan').value };
      const ext = Number($('#sa_ext').value) || 0; if (ext > 0) body.extendTrialDays = ext;
      await api(`/superadmin/tenants/${t.id}`, { method: 'PATCH', body });
      toast('Компания обновлена'); RENDER.platform();
    }, 'Сохранить');
    $('#sa_status').value = t.status; $('#sa_plan').value = t.plan;
  }));
};
function editSellerRequisites(rq) {
  modal('Реквизиты продавца (на счетах)', `
    <label>Наименование</label><input id="q_name" value="${esc(rq.sellerName || '')}" />
    <div class="row2"><div><label>ИНН</label><input id="q_inn" value="${esc(rq.sellerInn || '')}" /></div>
    <div><label>МФО</label><input id="q_mfo" value="${esc(rq.mfo || '')}" /></div></div>
    <label>Адрес</label><input id="q_addr" value="${esc(rq.address || '')}" />
    <label>Банк</label><input id="q_bank" value="${esc(rq.bank || '')}" />
    <label>Расчётный счёт</label><input id="q_acc" value="${esc(rq.account || '')}" />
    <div class="row2"><div><label>Директор</label><input id="q_dir" value="${esc(rq.director || '')}" /></div>
    <div><label>НДС %</label><input id="q_vat" type="number" min="0" max="100" value="${esc(rq.vatPercent ?? 0)}" /></div></div>
    <div class="row2"><div><label>Телефон</label><input id="q_phone" value="${esc(rq.phone || '')}" /></div>
    <div><label>Email</label><input id="q_email" value="${esc(rq.email || '')}" /></div></div>
  `, async () => {
    await api('/superadmin/requisites', { method: 'PATCH', body: {
      sellerName: $('#q_name').value.trim(), sellerInn: $('#q_inn').value.trim(), mfo: $('#q_mfo').value.trim(),
      address: $('#q_addr').value.trim(), bank: $('#q_bank').value.trim(), account: $('#q_acc').value.trim(),
      director: $('#q_dir').value.trim(), phone: $('#q_phone').value.trim(), email: $('#q_email').value.trim(),
      vatPercent: Number($('#q_vat').value) || 0,
    }});
    toast('Реквизиты продавца сохранены'); RENDER.platform();
  }, 'Сохранить');
}

// ---------- start ----------
$('#toRegister')?.addEventListener('click', () => setTimeout(showAuth, 0));
$('#toLogin')?.addEventListener('click', () => setTimeout(showAuth, 0));
(async () => {
  if (store.access) { try { await boot(); return; } catch { store.access = null; store.refresh = null; } }
  showAuth();
})();
