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
    s.src = 'js/firebase.bundle.js?v=1'; s.onload = res; s.onerror = () => { Cloud.loading = null; rej(new Error('load')); };
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
  FB.onAuthStateChanged(fbAuth, u => {
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
  out.profile = (a.profile && a.profile.u || 0) >= (b.profile && b.profile.u || 0) ? a.profile : b.profile;
  out.tomb = Object.assign({}, b.tomb || {});
  Object.entries(a.tomb || {}).forEach(([k, v]) => { out.tomb[k] = Math.max(v, out.tomb[k] || 0); });
  out.days = {};
  new Set([...Object.keys(a.days || {}), ...Object.keys(b.days || {})]).forEach(d => {
    const x = (a.days || {})[d], y = (b.days || {})[d];
    const w = !y ? x : !x ? y : ((x.u || 0) >= (y.u || 0) ? x : y);
    if (!(out.tomb['day:' + d] >= (w.u || 0))) out.days[d] = w;
  });
  const list = key => {
    const m = new Map();
    [...(b[key] || []), ...(a[key] || [])].forEach(it => { const p = m.get(it.id); if (!p || (it.u || 0) >= (p.u || 0)) m.set(it.id, it); });
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

function startSync(u) {
  stopSync();
  Cloud.status = 'syncing';
  cloudUnsub = FB.onSnapshot(FB.doc(fbDb, 'users', u.uid), snap => {
    remoteState = snap.exists() ? (snap.data().state || null) : null;
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
  if (c.includes('too-many-requests')) return t('authTooMany');
  return t('authFailed');
}
async function openAuth(mode) {
  try { await cloudInit(); } catch (e) { toast(t('authNetwork'), true); return; }
  const title = mode === 'register' ? t('authRegister') : mode === 'reset' ? t('authReset') : t('authLogin');
  openSheet(`<h2>${title}</h2>
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

function accountCard() {
  if (!cloudEnabled()) return '';
  if (!Cloud.user) {
    return `<section class="card stack account">
      <div class="row-between"><b>${t('account')}</b><span class="pill">${t('free')}</span></div>
      <span class="muted sm">${t('accountWhy')}</span>
      <div class="grid2"><button type="button" class="btn primary" data-act="openAuth" data-v="login">${t('authLogin')}</button><button type="button" class="btn" data-act="openAuth" data-v="register">${t('authRegister')}</button></div>
    </section>`;
  }
  const st = Cloud.status === 'ok' ? `${t('synced')} ✓` : Cloud.status === 'syncing' ? t('syncing') : Cloud.status === 'offline' ? t('syncOffline') : t('syncError');
  return `<section class="card stack account">
    <div class="row-between"><b>${t('account')}</b><span class="pill ${Cloud.status === 'ok' ? 'ok' : Cloud.status === 'error' ? 'bad' : ''}">${st}</span></div>
    <span dir="ltr" class="account-email">${esc(Cloud.user.email || '')}</span>
    <span class="muted sm">${t('syncWhat')}</span>
    <button type="button" class="btn" data-act="signOut">${t('signOut')}</button>
  </section>`;
}
