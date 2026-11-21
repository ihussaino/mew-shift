/* MEW Shift — الحساب والمزامنة (Firebase: الدخول بالإيميل + Firestore)
   - اختياري: التطبيق يعمل بدون حساب كما هو.
   - كل مستخدم له مستند واحد users/{uid} لا يقرؤه ولا يكتبه غيره (قواعد Firestore).
   - الدمج بين الأجهزة: لكل يوم ولكل إذن وإجازة وقت تعديل، ويُؤخذ الأحدث. المحذوفات تُسجل في tomb.
   يُحمّل قبل app.js، ومكتبة Firebase تُحمّل عند الحاجة فقط. */
'use strict';

/* إعدادات مشروع Firebase (ليست سرية). null = الحسابات غير مفعّلة بعد */
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDadEnrWt9JmG0E5kCetFyTsX52aXO6hzc',
  authDomain: 'mew-shift.firebaseapp.com',
  projectId: 'mew-shift',
  storageBucket: 'mew-shift.firebasestorage.app',
  messagingSenderId: '108458000267',
  appId: '1:108458000267:web:01a3b033320d120842398e'
};

const Cloud = { user: null, status: 'off', lastSync: 0, loading: null };
let fbAuth = null, fbDb = null, cloudUnsub = null, remoteState = null, pushTimer = null;
let lastProfileKey = null;

function cloudEnabled() { return !!FIREBASE_CONFIG; }

function loadFirebase() {
  if (window.FB) return Promise.resolve();
  if (Cloud.loading) return Cloud.loading;
  Cloud.loading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'js/firebase.bundle.js?v=2'; s.onload = res; s.onerror = () => { Cloud.loading = null; rej(new Error('load')); };
    document.head.appendChild(s);
  });
  return Cloud.loading;
}

async function cloudInit() {
  if (!cloudEnabled()) return false;
  if (fbAuth) return true;
  await loadFirebase();
  const app = FB.initializeApp(FIREBASE_CONFIG);
  fbAuth = FB.getAuth(app);
  fbDb = FB.initializeFirestore(app, { localCache: FB.persistentLocalCache() });
  FB.getRedirectResult(fbAuth).catch(e => toast(authErr(e), true));
  FB.onAuthStateChanged(fbAuth, u => {
    try { localStorage.removeItem('mewshift.redirect'); } catch (e) { /* */ }
    Cloud.user = u || null;
    if (u) { S.cloudUid = u.uid; startSync(u); } else { S.cloudUid = null; stopSync(); }
    saveLocalOnly(); render();
  });
  return true;
}

/* ---------- الحالة القابلة للمزامنة ---------- */
const PROFILE_KEYS = ['name', 'group', 'grade', 'annualBase', 'annualBaseDate'];
function profileOf() { const p = {}; PROFILE_KEYS.forEach(k => { p[k] = S.settings[k] == null ? null : S.settings[k]; }); return p; }
function localSyncable() {
  return JSON.parse(JSON.stringify({ profile: Object.assign(profileOf(), { u: S.profileU || 0 }), days: S.days, perms: S.perms, leaves: S.leaves, tomb: S.tomb || {} }));
}
function stable(o) {
  if (Array.isArray(o)) return '[' + o.map(stable).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
  return JSON.stringify(o === undefined ? null : o);
}
function mergeState(a, b) {
  if (!b) return JSON.parse(JSON.stringify(a));
  const out = {};
  out.profile = (a.profile && a.profile.u || 0) > (b.profile && b.profile.u || 0) ? a.profile : b.profile;
  out.tomb = Object.assign({}, b.tomb || {});
  Object.entries(a.tomb || {}).forEach(([k, v]) => { out.tomb[k] = Math.max(v, out.tomb[k] || 0); });
  out.days = {};
  new Set([...Object.keys(a.days || {}), ...Object.keys(b.days || {})]).forEach(d => {
    const x = (a.days || {})[d], y = (b.days || {})[d];
    const w = !y ? x : !x ? y : ((x.u || 0) > (y.u || 0) ? x : y);
    if (!(out.tomb['day:' + d] >= (w.u || 0))) out.days[d] = w;
  });
  const list = key => {
    const m = new Map();
    [...(a[key] || []), ...(b[key] || [])].forEach(it => { const p = m.get(it.id); if (!p || (it.u || 0) >= (p.u || 0)) m.set(it.id, it); });
    return [...m.values()].filter(it => !(out.tomb[it.id] >= (it.u || 0))).sort((p, q) => (p.date || p.from) < (q.date || q.from) ? -1 : 1);
  };
  out.perms = list('perms'); out.leaves = list('leaves');
  return JSON.parse(JSON.stringify(out));
}
function writeLocal(st) {
  PROFILE_KEYS.forEach(k => { if (st.profile && k in st.profile) S.settings[k] = st.profile[k]; });
  S.profileU = st.profile ? st.profile.u || 0 : 0;
  S.days = st.days || {}; S.perms = st.perms || []; S.leaves = st.leaves || []; S.tomb = st.tomb || {};
  cloudPrime();
}

/* يُستدعى من save(): يختم كل تعديل بوقته (يوم، إذن، إجازة، الاسم والمجموعة) ثم يرسل للسحابة */
let snapDays = null, snapItems = null;
const bare = o => { const c = Object.assign({}, o); delete c.u; return JSON.stringify(c); };
function cloudPrime() {
  snapDays = {}; Object.entries(S.days).forEach(([d, v]) => { snapDays[d] = bare(v); });
  snapItems = {}; [...S.perms, ...S.leaves].forEach(x => { snapItems[x.id] = bare(x); });
  lastProfileKey = JSON.stringify(profileOf());
}
function cloudOnSave() {
  if (!snapDays) cloudPrime();
  const now = Date.now(); S.tomb = S.tomb || {};
  Object.entries(S.days).forEach(([d, v]) => { const b = bare(v); if (snapDays[d] !== b) { v.u = now; snapDays[d] = b; } });
  Object.keys(snapDays).forEach(d => { if (!S.days[d]) { S.tomb['day:' + d] = now; delete snapDays[d]; } });
  const items = {};
  [...S.perms, ...S.leaves].forEach(x => { const b = bare(x); items[x.id] = b; if (snapItems[x.id] !== b || !x.u) x.u = now; });
  Object.keys(snapItems).forEach(id => { if (!(id in items)) S.tomb[id] = now; });
  snapItems = items;
  const pk = JSON.stringify(profileOf());
  if (pk !== lastProfileKey) { S.profileU = now; lastProfileKey = pk; }
  if (Cloud.user) schedulePush();
}

function stampAll() {
  const now = Date.now();
  Object.values(S.days).forEach(v => { v.u = now; });
  [...S.perms, ...S.leaves].forEach(x => { x.u = now; });
  S.profileU = now; cloudPrime();
}
function startSync(u) {
  stopSync();
  Cloud.status = 'syncing';
  cloudUnsub = FB.onSnapshot(FB.doc(fbDb, 'users', u.uid), snap => {
    remoteState = snap.exists() ? (snap.data().state || null) : null;
    if (!remoteState && !snap.metadata.fromCache) { stampAll(); saveLocalOnly(); }
    const local = localSyncable(), merged = mergeState(local, remoteState);
    if (stable(merged) !== stable(local)) {
      writeLocal(merged); saveLocalOnly();
      if (S.settings.name && S.settings.group) obActive = false;
      render();
    }
    if (!remoteState || stable(merged) !== stable(remoteState)) schedulePush();
    Cloud.status = snap.metadata && snap.metadata.fromCache ? 'offline' : 'ok';
    if (Cloud.status === 'ok') Cloud.lastSync = Date.now();
    if (view === 'settings') render();
  }, () => { Cloud.status = 'error'; if (view === 'settings') render(); });
}
function stopSync() { if (cloudUnsub) cloudUnsub(); cloudUnsub = null; remoteState = null; Cloud.status = 'off'; }
function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 1200); }
async function pushNow() {
  if (!Cloud.user) return;
  const merged = mergeState(localSyncable(), remoteState);
  try {
    Cloud.status = 'syncing';
    await FB.setDoc(FB.doc(fbDb, 'users', Cloud.user.uid), { state: merged, updated: FB.serverTimestamp(), app: 'mew-shift' });
    Cloud.status = 'ok'; Cloud.lastSync = Date.now();
  } catch (e) { Cloud.status = navigator.onLine ? 'error' : 'offline'; }
  if (view === 'settings') render();
}

/* ---------- واجهة الدخول ---------- */
function authErr(e) {
  const c = (e && e.code) || '';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return t('authBadLogin');
  if (c.includes('email-already-in-use')) return t('authExists');
  if (c.includes('weak-password')) return t('authWeak');
  if (c.includes('invalid-email')) return t('authBadEmail');
  if (c.includes('network')) return t('authNetwork');
  if (c.includes('popup-closed') || c.includes('cancelled-popup')) return t('authCancelled');
  if (c.includes('account-exists-with-different-credential')) return t('authOtherMethod');
  if (c.includes('too-many-requests')) return t('authTooMany');
  return t('authFailed');
}
async function openAuth(mode) {
  try { await cloudInit(); } catch (e) { toast(t('authNetwork'), true); return; }
  const title = mode === 'register' ? t('authRegister') : mode === 'reset' ? t('authReset') : t('authLogin');
  openSheet(`<h2>${title}</h2>
    ${mode === 'reset' ? '' : `${googleBtn()}<div class="or-sep"><span>${t('orEmail')}</span></div>`}
    <p class="muted sm">${mode === 'reset' ? t('authResetHint') : t('authHint')}</p>
    <form class="stack" data-form="auth" data-mode="${mode}">
      <label class="stack sm-gap"><b>${t('email')}</b><input type="email" name="email" class="text-in" autocomplete="email" inputmode="email" dir="ltr" required></label>
      ${mode === 'reset' ? '' : `<label class="stack sm-gap"><b>${t('password')}</b><input type="password" name="password" class="text-in" minlength="6" autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}" dir="ltr" required></label>`}
      <div class="perm-preview bad" id="auth-msg" hidden></div>
      <button type="submit" class="btn primary">${title}</button>
    </form>
    <div class="stack sm-gap center">
      ${mode !== 'login' ? `<button type="button" class="link" data-act="authMode" data-v="login">${t('haveAccount')}</button>` : `<button type="button" class="link" data-act="authMode" data-v="register">${t('noAccount')}</button><button type="button" class="link" data-act="authMode" data-v="reset">${t('forgotPassword')}</button>`}
    </div>`);
}
FEATURE_SUBMIT.auth = async (f, fd) => {
  const mode = f.dataset.mode, email = String(fd.get('email') || '').trim(), pw = String(fd.get('password') || '');
  const msg = document.getElementById('auth-msg'), btn = f.querySelector('button[type=submit]');
  msg.hidden = true; btn.disabled = true;
  try {
    if (mode === 'reset') { await FB.sendPasswordResetEmail(fbAuth, email); msg.className = 'perm-preview ok'; msg.textContent = t('authResetSent'); msg.hidden = false; btn.disabled = false; return; }
    if (mode === 'register') await FB.createUserWithEmailAndPassword(fbAuth, email, pw);
    else await FB.signInWithEmailAndPassword(fbAuth, email, pw);
    closeSheet(); toast(t('authWelcome'));
  } catch (e) { msg.className = 'perm-preview bad'; msg.textContent = authErr(e); msg.hidden = false; btn.disabled = false; }
};
FEATURE_ACTIONS.authMode = v => openAuth(v);
FEATURE_ACTIONS.openAuth = v => openAuth(v || 'login');
FEATURE_ACTIONS.signOut = async () => {
  try { await cloudInit(); await FB.signOut(fbAuth); } catch (e) { /* */ }
  toast(t('signedOut'));
};

function googleBtn() { return `<button type="button" class="btn google-btn" data-act="googleSignIn"><svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg><span>${t('googleSignIn')}</span></button>`; }
async function googleSignIn() {
  try { await cloudInit(); } catch (e) { toast(t('authNetwork'), true); return; }
  const prov = new FB.GoogleAuthProvider(); prov.setCustomParameters({ prompt: 'select_account' });
  try { await FB.signInWithPopup(fbAuth, prov); closeSheet(); toast(t('authWelcome')); }
  catch (e) {
    const c = (e && e.code) || '';
    if (c.includes('popup-blocked') || c.includes('operation-not-supported')) {
      try { localStorage.setItem('mewshift.redirect', '1'); } catch (x) { /* */ }
      FB.signInWithRedirect(fbAuth, prov).catch(x => toast(authErr(x), true));
    } else if (!c.includes('popup-closed') && !c.includes('cancelled-popup')) toast(authErr(e), true);
  }
}
FEATURE_ACTIONS.googleSignIn = () => googleSignIn();
FEATURE_ACTIONS.useThisDevice = () => openSheet(`<h2>${t('useThisDevice')}</h2><p>${t('useThisDeviceConfirm')}</p>
  <div class="grid2"><button type="button" class="btn" data-act="closeSheet">${t('cancel')}</button><button type="button" class="btn primary" data-act="useThisDeviceDo">${t('confirm')}</button></div>`);
FEATURE_ACTIONS.useThisDeviceDo = async () => {
  if (!Cloud.user) return;
  stampAll(); saveLocalOnly();
  remoteState = null; await pushNow();
  closeSheet(); toast(t('useThisDeviceDone')); render();
};

function accountCard() {
  if (!cloudEnabled()) return '';
  if (!Cloud.user) {
    return `<section class="card stack account">
      <div class="row-between"><b>${t('account')}</b><span class="pill">${t('free')}</span></div>
      <span class="muted sm">${t('accountWhy')}</span>
      ${googleBtn()}
      <div class="grid2"><button type="button" class="btn primary" data-act="openAuth" data-v="login">${t('authLogin')}</button><button type="button" class="btn" data-act="openAuth" data-v="register">${t('authRegister')}</button></div>
    </section>`;
  }
  const st = Cloud.status === 'ok' ? `${t('synced')} ✓` : Cloud.status === 'syncing' ? t('syncing') : Cloud.status === 'offline' ? t('syncOffline') : t('syncError');
  return `<section class="card stack account">
    <div class="row-between"><b>${t('account')}</b><span class="pill ${Cloud.status === 'ok' ? 'ok' : Cloud.status === 'error' ? 'bad' : ''}">${st}</span></div>
    <span dir="ltr" class="account-email">${esc(Cloud.user.email || '')}${Cloud.user.providerData && Cloud.user.providerData.some(p => p.providerId === 'google.com') ? ' · Google' : ''}</span>
    <span class="muted sm">${t('syncWhat')}</span>
    <button type="button" class="btn" data-act="useThisDevice">${t('useThisDevice')}</button>
    <button type="button" class="btn" data-act="signOut">${t('signOut')}</button>
  </section>`;
}
