/* MEW Shift — منبّه الإشعارات (Cloudflare Worker)
   - يعمل كل دقيقة (Cron) ويرسل تنبيه بصمة التواجد للمجموعة التي عليها شفت،
     وتنبيه الانصراف لمن سجّل دخوله.
   - لا يحفظ بصمات ولا إجازات: فقط اشتراك الإشعار، والمجموعة، واللغة، وأيام الإجازة القادمة لتجنب التنبيه فيها.
   - مفاتيح VAPID تُنشأ تلقائياً في أول تشغيل وتُحفظ في قاعدة D1. */

const APP_ORIGINS = ['https://work.ihussain.net', 'http://localhost:8765'];
const PUSH_HOSTS = ['web.push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];
const KUWAIT_OFFSET_MS = 3 * 3600 * 1000;

/* نفس قواعد التطبيق (js/rules.js) */
const REF = '2026-11-20';
const POS = { A: 4, B: 3, C: 2, D: 1, E: 0 };
const CYCLE = ['M', 'A', 'N', 'O', 'O'];
/* وقت بداية نافذة التواجد (بتوقيت الكويت) → الشفت، وكم يوماً نرجع لتاريخ الشفت */
const ATT_TIMES = { '09:01': { shift: 'M', back: 0 }, '17:01': { shift: 'A', back: 0 }, '01:01': { shift: 'N', back: 1 } };

const MSG = {
  ar: { att: 'حان وقت بصمة التواجد', attBody: 'النافذة مفتوحة لمدة ساعة.', exit: 'حان وقت الانصراف', exitBody: 'لا تنسَ بصمة الانصراف.' },
  en: { att: 'Time for your presence punch', attBody: 'The window is open for one hour.', exit: 'Time to leave', exitBody: 'Don’t forget to punch out.' }
};

/* ---------- التواريخ والشفتات ---------- */
const toUTC = d => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
const addDays = (d, n) => new Date(toUTC(d) + n * 864e5).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((toUTC(a) - toUTC(b)) / 864e5);
export function shiftOf(group, date) { return CYCLE[(((POS[group] + diffDays(date, REF)) % 5) + 5) % 5]; }
export function groupsOn(shift, date) { return Object.keys(POS).filter(g => shiftOf(g, date) === shift); }

/* ---------- ترميز ---------- */
const te = new TextEncoder();
const enc = s => te.encode(s);
function concat(...arrs) { const n = arrs.reduce((a, b) => a + b.length, 0); const o = new Uint8Array(n); let i = 0; for (const a of arrs) { o.set(a, i); i += a.length; } return o; }
function b64u(bytes) { let s = ''; bytes.forEach(b => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64uDec(str) { const s = str.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(bin, c => c.charCodeAt(0)); }

/* ---------- قاعدة البيانات ---------- */
let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS subs (
      endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      grp TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'ar', att INTEGER NOT NULL DEFAULT 1, exit INTEGER NOT NULL DEFAULT 1,
      skip TEXT NOT NULL DEFAULT '', exit_at TEXT, updated TEXT)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS subs_grp ON subs (grp)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
  ]);
  ready = true;
}

/* ---------- مفاتيح VAPID ---------- */
let vapidCache = null;
export async function getVapid(env) {
  if (vapidCache) return vapidCache;
  let row = await env.DB.prepare("SELECT v FROM config WHERE k = 'vapid'").first();
  if (!row) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
    await env.DB.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('vapid', ?)").bind(JSON.stringify({ jwk, pub })).run();
    row = await env.DB.prepare("SELECT v FROM config WHERE k = 'vapid'").first();
  }
  const { jwk, pub } = JSON.parse(row.v);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  vapidCache = { key, pub };
  return vapidCache;
}

async function vapidJWT(aud, key) {
  const h = b64u(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u(enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://work.ihussain.net' })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(`${h}.${p}`)));
  return `${h}.${p}.${b64u(sig)}`;
}

/* ---------- تشفير الرسالة (RFC 8291, aes128gcm) ---------- */
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
export async function encryptPayload(text, p256dhB64, authB64) {
  const ua = b64uDec(p256dhB64), auth = b64uDec(authB64);
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concat(enc('WebPush: info\0'), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc(text), new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPub.length);
  header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = asPub.length; header.set(asPub, 21);
  return concat(header, ct);
}

async function sendPush(env, sub, payload) {
  const { key, pub } = await getVapid(env);
  const aud = new URL(sub.endpoint).origin;
  const body = await encryptPayload(JSON.stringify(payload), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '3600', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${await vapidJWT(aud, key)}, k=${pub}`
    },
    body
  });
  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?').bind(sub.endpoint).run();
  }
  return res.status;
}

/* ---------- المنبّه (كل دقيقة) ---------- */
export async function runTick(env, nowMs) {
  await init(env);
  const kw = new Date(nowMs + KUWAIT_OFFSET_MS).toISOString();
  const hhmm = kw.slice(11, 16), today = kw.slice(0, 10);
  const jobs = [];

  const a = ATT_TIMES[hhmm];
  if (a) {
    const date = addDays(today, -a.back);
    for (const g of groupsOn(a.shift, date)) {
      const { results } = await env.DB.prepare('SELECT * FROM subs WHERE grp = ? AND att = 1').bind(g).all();
      for (const s of results) {
        if (s.skip && s.skip.split(',').includes(date)) continue;
        const m = MSG[s.lang] || MSG.ar;
        jobs.push(sendPush(env, s, { title: m.att, body: m.attBody, tag: 'att-' + date }));
      }
    }
  }

  const nowIso = new Date(nowMs).toISOString().slice(0, 16);
  const oldest = new Date(nowMs - 15 * 60000).toISOString().slice(0, 16);
  const { results: exits } = await env.DB.prepare('SELECT * FROM subs WHERE exit = 1 AND exit_at IS NOT NULL AND exit_at <= ?').bind(nowIso).all();
  for (const s of exits) {
    await env.DB.prepare('UPDATE subs SET exit_at = NULL WHERE endpoint = ?').bind(s.endpoint).run();
    if (s.exit_at < oldest) continue; // قديم جداً، لا نرسله متأخراً
    const m = MSG[s.lang] || MSG.ar;
    jobs.push(sendPush(env, s, { title: m.exit, body: m.exitBody, tag: 'exit-' + s.exit_at }));
  }
  const out = await Promise.allSettled(jobs);
  return out.length;
}

/* ---------- واجهة التطبيق ---------- */
function cors(req) {
  const o = req.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': APP_ORIGINS.includes(o) ? o : APP_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400', Vary: 'Origin'
  };
}
const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function validEndpoint(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && PUSH_HOSTS.some(h => x.hostname === h || x.hostname.endsWith('.' + h)) && u.length < 1000; } catch (e) { return false; }
}

export default {
  async fetch(req, env) {
    const h = cors(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url);
    try {
      await init(env);
      if (url.pathname === '/vapid' && req.method === 'GET') {
        const { pub } = await getVapid(env);
        return json({ publicKey: pub }, 200, h);
      }
      if (url.pathname === '/sync' && req.method === 'POST') {
        const b = await req.json();
        const s = b.subscription || {};
        const keys = s.keys || {};
        if (!validEndpoint(s.endpoint) || !keys.p256dh || !keys.auth || keys.p256dh.length > 200 || keys.auth.length > 100) return json({ error: 'bad subscription' }, 400, h);
        if (!Object.prototype.hasOwnProperty.call(POS, b.group)) return json({ error: 'bad group' }, 400, h);
        const skip = (Array.isArray(b.skip) ? b.skip : []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 200).join(',');
        const exitAt = typeof b.exitAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.exitAt) ? b.exitAt : null;
        await env.DB.prepare(`INSERT INTO subs (endpoint, p256dh, auth, grp, lang, att, exit, skip, exit_at, updated)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
          ON CONFLICT(endpoint) DO UPDATE SET p256dh = ?2, auth = ?3, grp = ?4, lang = ?5, att = ?6, exit = ?7, skip = ?8, exit_at = ?9, updated = ?10`)
          .bind(s.endpoint, keys.p256dh, keys.auth, b.group, b.lang === 'en' ? 'en' : 'ar', b.att ? 1 : 0, b.exit ? 1 : 0, skip, exitAt, new Date().toISOString())
          .run();
        return json({ ok: true }, 200, h);
      }
      if (url.pathname === '/unsubscribe' && req.method === 'POST') {
        const b = await req.json();
        if (typeof b.endpoint === 'string') await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?').bind(b.endpoint).run();
        return json({ ok: true }, 200, h);
      }
      if (url.pathname === '/test' && req.method === 'POST') {
        const b = await req.json();
        const row = await env.DB.prepare('SELECT * FROM subs WHERE endpoint = ?').bind(String(b.endpoint || '')).first();
        if (!row) return json({ error: 'not subscribed' }, 404, h);
        const m = row.lang === 'en' ? { title: 'MEW Shift', body: 'Notifications are working ✓' } : { title: 'MEW Shift', body: 'الإشعارات تعمل ✓' };
        const status = await sendPush(env, row, { ...m, tag: 'test' });
        return json({ ok: status >= 200 && status < 300, status }, 200, h);
      }
      if (url.pathname === '/' && req.method === 'GET') return new Response('MEW Shift push: OK', { headers: h });
      return json({ error: 'not found' }, 404, h);
    } catch (e) {
      return json({ error: 'server error' }, 500, h);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTick(env, event.scheduledTime));
  }
};
