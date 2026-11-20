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
    env.DB.prepare('CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS ann (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL)')
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

/* ---------- المنبّه (كل دقيقة) ----------
   الخطة المجانية في Cloudflare تسمح بـ 50 طلباً خارجياً في كل تشغيل،
   لذلك تُوضع الرسائل في طابور (outbox) ويُرسل منها 40 كل دقيقة. */
const SEND_PER_TICK = 40;
const MAX_AGE_MS = 50 * 60 * 1000; // رسالة أقدم من 50 دقيقة لا تُرسل

async function enqueue(env, rows, payloadFor, nowMs) {
  if (!rows.length) return 0;
  const stmts = rows.map(r => env.DB.prepare('INSERT INTO outbox (endpoint, payload, created) VALUES (?, ?, ?)').bind(r.endpoint, JSON.stringify(payloadFor(r)), nowMs));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return rows.length;
}

export async function drain(env, nowMs) {
  const { results } = await env.DB.prepare(`SELECT o.id AS oid, o.payload AS payload, o.created AS created, s.* FROM outbox o
    LEFT JOIN subs s ON s.endpoint = o.endpoint ORDER BY o.id LIMIT ?`).bind(SEND_PER_TICK).all();
  if (!results.length) return 0;
  const jobs = [];
  for (const r of results) {
    if (!r.p256dh || nowMs - r.created > MAX_AGE_MS) continue;
    jobs.push(sendPush(env, r, JSON.parse(r.payload)));
  }
  await Promise.allSettled(jobs);
  const ids = results.map(r => r.oid);
  await env.DB.prepare(`DELETE FROM outbox WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
  return jobs.length;
}

export async function runTick(env, nowMs) {
  await init(env);
  const kw = new Date(nowMs + KUWAIT_OFFSET_MS).toISOString();
  const hhmm = kw.slice(11, 16), today = kw.slice(0, 10);

  const a = ATT_TIMES[hhmm];
  if (a) {
    const date = addDays(today, -a.back);
    for (const g of groupsOn(a.shift, date)) {
      const { results } = await env.DB.prepare('SELECT endpoint, lang, skip FROM subs WHERE grp = ? AND att = 1').bind(g).all();
      const due = results.filter(s => !(s.skip && s.skip.split(',').includes(date)));
      await enqueue(env, due, s => { const m = MSG[s.lang] || MSG.ar; return { title: m.att, body: m.attBody, tag: 'att-' + date }; }, nowMs);
    }
  }

  const nowIso = new Date(nowMs).toISOString().slice(0, 16);
  const oldest = new Date(nowMs - 15 * 60000).toISOString().slice(0, 16);
  const { results: exits } = await env.DB.prepare('SELECT endpoint, lang, exit_at FROM subs WHERE exit = 1 AND exit_at IS NOT NULL AND exit_at <= ?').bind(nowIso).all();
  if (exits.length) {
    await env.DB.prepare('UPDATE subs SET exit_at = NULL WHERE exit = 1 AND exit_at IS NOT NULL AND exit_at <= ?').bind(nowIso).run();
    await enqueue(env, exits.filter(s => s.exit_at >= oldest), s => { const m = MSG[s.lang] || MSG.ar; return { title: m.exit, body: m.exitBody, tag: 'exit-' + s.exit_at }; }, nowMs);
  }
  return drain(env, nowMs);
}

/* مقارنة كلمة السر بوقت ثابت */
function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const x = enc(a), y = enc(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
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
      if (url.pathname === '/announcements' && req.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT id, title, body, created FROM ann ORDER BY id DESC LIMIT 5').all();
        return json({ items: results }, 200, { ...h, 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/admin/broadcast' && req.method === 'POST') {
        const b = await req.json();
        if (!sameKey(b.key, env.ADMIN_KEY)) return json({ error: 'unauthorized' }, 401, h);
        const title = String(b.title || '').trim().slice(0, 80), body = String(b.body || '').trim().slice(0, 300);
        if (!title || !body) return json({ error: 'empty' }, 400, h);
        const now = Date.now();
        await env.DB.prepare('INSERT INTO ann (title, body, created) VALUES (?, ?, ?)').bind(title, body, new Date(now).toISOString()).run();
        const r = await env.DB.prepare(`INSERT INTO outbox (endpoint, payload, created) SELECT endpoint, ?, ? FROM subs`)
          .bind(JSON.stringify({ title: '📣 ' + title, body, tag: 'ann-' + now }), now).run();
        return json({ ok: true, queued: (r.meta && r.meta.changes) || 0 }, 200, h);
      }
      if (url.pathname === '/admin/delete' && req.method === 'POST') {
        const b = await req.json();
        if (!sameKey(b.key, env.ADMIN_KEY)) return json({ error: 'unauthorized' }, 401, h);
        await env.DB.prepare('DELETE FROM ann WHERE id = ?').bind(Number(b.id) || 0).run();
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
