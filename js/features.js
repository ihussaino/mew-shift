/* MEW Shift — مزايا إضافية: مخطط الإجازة، مشاركة الجدول، ملخص الشهر، الإعلانات.
   يُحمّل قبل app.js، ويستخدم دواله وقت التشغيل فقط. */
'use strict';

const FEATURE_ACTIONS = {};
const FEATURE_SUBMIT = {};
const QS = new URLSearchParams(location.search);
const SPECIAL_PAGE = QS.has('admin') || QS.has('view');

/* =========================================================
   ١. مخطط الإجازة الذكي
   الفكرة: الموظف يقدّم الإجازة على أيام الدوام فقط (كل مجموعة أيام متصلة طلب منفصل)،
   فأيام الراحة حولها مجانية، والجمعة والعطل داخل الإجازة لا تُخصم.
   ========================================================= */
/* عدّ الأيام بصيغة عربية صحيحة */
function daysCount(n) {
  if (S.settings.lang !== 'ar') return `${n} ${n === 1 ? 'day' : 'days'}`;
  if (n === 0) return 'ولا يوم';
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومين';
  if (n <= 10) return `${n} أيام`;
  return `${n} يوماً`;
}
/* حاسبة الإجازة: تختار من وإلى، وتعرف كم ينخصم (الجمعة والعطل الرسمية لا تُخصم) */
let calcFrom = null, calcTo = null;
function leaveCalc(from, to) {
  const total = diffDays(to, from) + 1, fridays = [], hols = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const h = holidayOn(d);
    if (h) { const k = h.ar + h.from; if (!hols.has(k)) hols.set(k, { h, days: [] }); hols.get(k).days.push(d); }
    else if (isFriday(d)) fridays.push(d);
  }
  const cost = leaveDays(from, to).length;
  const overlap = S.leaves.some(l => !(to < l.from || from > l.to));
  return { total, cost, free: total - cost, fridays, hols: [...hols.values()], overlap };
}
function plannerSheet() {
  const ar = annualRemaining();
  const today = todayISO();
  if (!calcFrom) { calcFrom = addDays(today, 1); calcTo = addDays(today, 7); }
  let out = '';
  if (calcTo < calcFrom) out = `<div class="perm-preview bad">${t('calcBadRange')}</div>`;
  else {
    const r = leaveCalc(calcFrom, calcTo), after = ar == null ? null : ar - r.cost;
    const freeList = [
      ...r.fridays.map(d => `<li>${fmtShort(d)} · ${t('friday')}</li>`),
      ...r.hols.map(x => `<li>${x.days.length > 1 ? fmtShort(x.days[0]) + ' – ' + fmtShort(x.days[x.days.length - 1]) : fmtShort(x.days[0])} · ${esc(x.h[S.settings.lang] || x.h.ar)}${x.days.length > 1 ? ' (' + daysCount(x.days.length) + ')' : ''}</li>`)
    ].join('');
    out = `<section class="plan-card stack sm-gap">
      <div class="row-between"><span>${t('calcTotal')}</span><b>${daysCount(r.total)}</b></div>
      <div class="row-between"><span>${t('calcCost')}</span><b class="calc-cost">${daysCount(r.cost)}</b></div>
      <div class="row-between"><span>${t('calcFree')}</span><b>${daysCount(r.free)}</b></div>
      ${freeList ? `<ul class="calc-free muted sm">${freeList}</ul>` : ''}
      ${after != null ? `<div class="row-between"><span>${t('calcAfter')}</span><b>${daysCount(Math.max(0, after))}</b></div>` : ''}
    </section>
    ${after != null && after < 0 ? `<div class="perm-preview bad">${t('calcNoBalance')}</div>` : ''}
    ${r.overlap ? `<div class="perm-preview bad">${t('calcOverlap')}</div>` : ''}
    <button type="button" class="btn primary" data-act="calcAdd"${r.overlap ? ' disabled' : ''}>${t('addThisLeave')}</button>`;
  }
  openSheet(`<h2>🧮 ${t('plannerTitle')}</h2>
    <p class="muted sm">${t('calcIntro')}</p>
    <form class="stack" data-form="planner">
      <div class="grid2"><label class="stack sm-gap sm">${t('fromDate')}<input type="date" name="from" value="${calcFrom}" class="time" required></label>
      <label class="stack sm-gap sm">${t('toDate')}<input type="date" name="to" value="${calcTo}" class="time" required></label></div>
      ${ar != null ? `<span class="muted sm">${t('balance')}: ${daysCount(ar)}</span>` : ''}
      <button type="submit" class="btn">${t('calcGo')}</button>
    </form>
    ${out}`);
}
FEATURE_ACTIONS.openPlanner = () => plannerSheet();
FEATURE_SUBMIT.planner = (f, fd) => {
  calcFrom = String(fd.get('from') || calcFrom); calcTo = String(fd.get('to') || calcTo);
  plannerSheet();
};
FEATURE_ACTIONS.calcAdd = () => {
  if (!calcFrom || calcTo < calcFrom) return;
  const r = leaveCalc(calcFrom, calcTo);
  if (r.overlap) return;
  S.leaves.push({ id: uid(), type: 'annual', from: calcFrom, to: calcTo });
  save(); closeSheet(); render();
  toast(`${t('leaveAdded')}: ${t('calcCost')} ${daysCount(r.cost)}`);
  calcFrom = calcTo = null;
};

/* =========================================================
   ٢. رابط مشاركة الجدول (عرض فقط، بدون أي بيانات شخصية)
   ========================================================= */
FEATURE_ACTIONS.shareSchedule = async () => {
  const url = `${location.origin}/?view=${group()}&n=${encodeURIComponent(S.settings.name || '')}`;
  const title = `${t('scheduleOf')} ${S.settings.name || ''}`.trim();
  try {
    if (navigator.share) { await navigator.share({ title, text: t('shareText'), url }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast(t('linkCopied')); } catch (e) { prompt(t('copyLink'), url); }
};

let sharedMonth = null;
function sharedView() {
  if (QS.has('admin')) { renderAdmin(); return true; }
  const g = (QS.get('view') || '').toUpperCase();
  if (!['A', 'B', 'C', 'D', 'E'].includes(g)) return false;
  applyTheme();
  document.documentElement.lang = S.settings.lang;
  document.documentElement.dir = S.settings.lang === 'ar' ? 'rtl' : 'ltr';
  document.getElementById('nav').hidden = true;
  const name = (QS.get('n') || '').slice(0, 30);
  if (!sharedMonth) sharedMonth = todayISO().slice(0, 7);
  const td = todayISO();
  const [y, m] = sharedMonth.split('-').map(Number);
  const [first, last] = monthBounds(sharedMonth);
  let cells = '';
  for (let i = 0; i < weekday(first); i++) cells += '<div></div>';
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const s = shiftOf(g, d), h = holidayOn(d);
    const cls = ['cell', 's-' + s];
    if (h && !isWorkShift(s)) cls.push('hol-full'); else if (h) cls.push('has-hol');
    if (d === td) cls.push('today');
    cells += `<div class="${cls.join(' ')}" aria-label="${fmtDate(d)} ${shiftName(s)}"><span>${Number(d.slice(8))}</span></div>`;
  }
  const next = [0, 1, 2, 3, 4, 5, 6].map(i => {
    const d = addDays(td, i), s = shiftOf(g, d), h = holidayOn(d);
    return `<div class="share-row"><span>${i === 0 ? t('today') : i === 1 ? t('tomorrow') : dayName(d)} <span class="muted sm">${fmtShort(d)}</span></span><span class="pill s-${s}${h ? ' has-hol' : ''}">${shiftName(s)}${isWorkShift(s) ? ' · ' + shiftHours(s) : ''}</span></div>`;
  }).join('');
  document.getElementById('app').innerHTML = `
    <header class="top"><div><div class="muted">${t('sharedSchedule')}</div><h1>${name ? `${t('scheduleOf')} ${esc(name)}` : `${t('group')} ${g}`}</h1></div><span class="chip-primary">${t('group')} ${g}</span></header>
    <div class="cols"><div class="col">
      <section class="card stack">${next}</section>
    </div><div class="col">
      <div class="month-nav">
        <button type="button" class="icon-btn" data-act="sharedMonth" data-v="-1" aria-label="${t('prevMonth')}">${S.settings.lang === 'ar' ? ICONS.right : ICONS.left}</button>
        <b>${monthName(m)} ${y}</b>
        <button type="button" class="icon-btn" data-act="sharedMonth" data-v="1" aria-label="${t('nextMonth')}">${S.settings.lang === 'ar' ? ICONS.left : ICONS.right}</button>
      </div>
      <section class="card cal"><div class="cal-grid head">${t('weekdaysShort').split(',').map(w => `<span>${w}</span>`).join('')}</div><div class="cal-grid">${cells}</div></section>
      <div class="legend"><span><i class="sw s-M"></i>${t('shift_M')}</span><span><i class="sw s-A"></i>${t('shift_A')}</span><span><i class="sw s-N"></i>${t('shift_N')}</span><span><i class="sw s-O"></i>${t('shift_O')}</span><span><i class="sw hol"></i>${t('holiday')}</span></div>
    </div></div>
    <a class="btn primary share-cta" href="/">${t('getApp')}</a>
    <p class="muted sm center">MEW Shift · ${t('station')}</p>`;
  return true;
}
FEATURE_ACTIONS.sharedMonth = v => {
  const [y, m] = sharedMonth.split('-').map(Number);
  sharedMonth = new Date(Date.UTC(y, m - 1 + Number(v), 1)).toISOString().slice(0, 7);
  sharedView();
};

/* =========================================================
   ٣. ملخص الشهر كصورة (للستوري والقروبات)
   ========================================================= */
function monthSummary(ym) {
  const [from, to] = monthBounds(ym);
  const st = stats(from, to);
  let early = 0, streak = 0, best = 0;
  const end = to < todayISO() ? to : todayISO();
  for (let d = from; d <= end; d = addDays(d, 1)) {
    const sh = shiftOf(group(), d);
    if (!isWorkShift(sh) || leaveOn(d)) continue;
    const rec = S.days[d];
    const e = rec && rec.in ? evalEntry(sh, rec.in) : null;
    if (e && e.early) { early++; streak++; best = Math.max(best, streak); } else if (d < todayISO() || (rec && rec.in)) streak = 0;
  }
  return { ym, st, early, best };
}

async function drawSummary(ym) {
  const m = monthSummary(ym);
  const W = 1080, H = 1920;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  try { await Promise.all(['400', '600', '700'].map(w => document.fonts.load(`${w} 40px "IBM Plex Sans Arabic"`, 'أ'))); await document.fonts.load('700 40px "Reem Kufi"', 'أ'); } catch (e) { /* */ }
  const F = (w, s, fam) => `${w} ${s}px "${fam || 'IBM Plex Sans Arabic'}", system-ui, sans-serif`;
  const rtl = S.settings.lang === 'ar';
  if ('direction' in x) x.direction = rtl ? 'rtl' : 'ltr';
  // الخلفية
  x.fillStyle = '#0F2D5C'; x.fillRect(0, 0, W, H);
  x.fillStyle = 'rgba(22,64,127,.6)'; x.beginPath(); x.arc(940, 260, 420, 0, Math.PI * 2); x.fill();
  x.fillStyle = 'rgba(10,37,80,.8)'; x.beginPath(); x.arc(80, 1660, 520, 0, Math.PI * 2); x.fill();
  const [yy, mm] = ym.split('-').map(Number);
  x.textAlign = 'center';
  x.fillStyle = '#F6C945'; x.font = F(700, 46, 'Reem Kufi');
  x.fillText(`${t('summaryOf')} ${monthName(mm)} ${yy}`, W / 2, 210);
  x.fillStyle = '#FFFFFF'; x.font = F(700, 104);
  x.fillText(S.settings.name || 'MEW Shift', W / 2, 350);
  x.fillStyle = '#C9D6EE'; x.font = F(400, 40);
  x.fillText(`${t('group')} ${group()} · ${t('station')}`, W / 2, 425);
  // البطاقات
  const tiles = [
    [String(m.st.hours), t('workHours')],
    [`${m.st.pct}%`, t('attendance')],
    [String(m.early), t('earlyPunches')],
    [`${m.best} 🔥`, t('bestStreak')],
    [String(m.st.present), t('daysPresent')],
    [String(m.st.u.late), t('lateMinutes')]
  ];
  const tw = 450, th = 250, gx = 60, gy = 50, x0 = (W - tw * 2 - gx) / 2, y0 = 540;
  tiles.forEach(([val, lab], i) => {
    const col = rtl ? 1 - (i % 2) : i % 2, row = Math.floor(i / 2);
    const tx = x0 + col * (tw + gx), ty = y0 + row * (th + gy);
    x.fillStyle = i === 3 ? 'rgba(246,201,69,.16)' : 'rgba(255,255,255,.08)';
    roundRect(x, tx, ty, tw, th, 36); x.fill();
    if (i === 3) { x.strokeStyle = '#F6C945'; x.lineWidth = 4; roundRect(x, tx, ty, tw, th, 36); x.stroke(); }
    x.fillStyle = '#FFFFFF'; x.font = F(700, 96); x.textAlign = 'center';
    x.fillText(val, tx + tw / 2, ty + 130);
    x.fillStyle = '#C9D6EE'; x.font = F(600, 38);
    x.fillText(lab, tx + tw / 2, ty + 200);
  });
  // رسالة
  const msg = m.best >= 3 || m.early >= 5 ? t('cheer') : m.st.pct >= 70 ? t('goodMonth') : t('nextMonthBetter');
  x.fillStyle = '#F6C945'; roundRect(x, 140, 1490, W - 280, 140, 70); x.fill();
  x.fillStyle = '#1F1800'; x.font = F(700, 54); x.textAlign = 'center';
  x.fillText(msg, W / 2, 1580);
  // التذييل
  try {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = 'icons/icon-192.png?v=3'; });
    x.save(); roundRect(x, W / 2 - 60, 1700, 120, 120, 28); x.clip(); x.drawImage(img, W / 2 - 60, 1700, 120, 120); x.restore();
  } catch (e) { /* */ }
  x.fillStyle = '#C9D6EE'; x.font = F(600, 34); x.textAlign = 'center';
  x.fillText('MEW Shift · work.ihussain.net', W / 2, 1870);
  return c;
}
function roundRect(x, a, b, w, h, r) {
  x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath();
}

let summaryBlob = null, summaryUrl = null, summaryYm = null;
async function openSummary(ym) {
  summaryYm = ym;
  openSheet(`<h2>📸 ${t('summaryTitle')}</h2><p class="muted">${t('preparing')}</p>`);
  const c = await drawSummary(ym);
  summaryBlob = await new Promise(r => c.toBlob(r, 'image/png'));
  if (summaryUrl) URL.revokeObjectURL(summaryUrl);
  summaryUrl = URL.createObjectURL(summaryBlob);
  const cur = todayISO().slice(0, 7), prev = new Date(Date.UTC(+cur.slice(0, 4), +cur.slice(5, 7) - 2, 1)).toISOString().slice(0, 7);
  openSheet(`<h2>📸 ${t('summaryTitle')}</h2>
    <div class="seg">${[[prev, monthName(+prev.slice(5, 7))], [cur, monthName(+cur.slice(5, 7))]].map(([v, l]) => `<button type="button" class="${v === ym ? 'on' : ''}" data-act="summaryMonth" data-v="${v}">${l}</button>`).join('')}</div>
    <img class="summary-img" src="${summaryUrl}" alt="${t('summaryTitle')}">
    <div class="grid2"><button type="button" class="btn primary" data-act="summaryShare">${t('share')}</button><a class="btn center-btn" href="${summaryUrl}" download="mew-shift-${ym}.png">${t('download')}</a></div>`);
}
FEATURE_ACTIONS.openSummary = () => { const td = todayISO(); openSummary(Number(td.slice(8)) <= 3 ? new Date(Date.UTC(+td.slice(0, 4), +td.slice(5, 7) - 2, 1)).toISOString().slice(0, 7) : td.slice(0, 7)); };
FEATURE_ACTIONS.summaryMonth = v => openSummary(v);
FEATURE_ACTIONS.summaryShare = async () => {
  const file = new File([summaryBlob], `mew-shift-${summaryYm}.png`, { type: 'image/png' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: t('summaryTitle') }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = summaryUrl; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
};

/* =========================================================
   ٤. الإعلانات
   ========================================================= */
let announcements = [];
try { announcements = JSON.parse(localStorage.getItem('mewshift.ann') || '[]'); } catch (e) { announcements = []; }
async function fetchAnnouncements() {
  if (!PUSH_API || !navigator.onLine) return;
  try {
    const r = await fetch(PUSH_API + '/announcements', { cache: 'no-store' });
    if (!r.ok) return;
    announcements = (await r.json()).items || [];
    try { localStorage.setItem('mewshift.ann', JSON.stringify(announcements)); } catch (e) { /* */ }
    if (view === 'today' && !QS.has('view') && !QS.has('admin')) render();
  } catch (e) { /* بدون إنترنت */ }
}
function annBanner() {
  const seen = S.settings.seenAnn || 0;
  const a = announcements.find(x => x.id > seen && Date.now() - Date.parse(x.created) < 30 * 864e5);
  if (!a) return '';
  return `<section class="card ann" role="status"><div class="row-between"><b>📣 ${esc(a.title)}</b><button type="button" class="link" data-act="annSeen" data-v="${a.id}">${t('dismiss')}</button></div><p class="sm">${esc(a.body)}</p></section>`;
}
FEATURE_ACTIONS.annSeen = v => { S.settings.seenAnn = Math.max(S.settings.seenAnn || 0, Number(v)); save(); render(); };

/* صفحة الإدارة: work.ihussain.net/?admin */
function renderAdmin() {
  applyTheme();
  document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl';
  document.getElementById('nav').hidden = true;
  let key = '';
  try { key = sessionStorage.getItem('mewshift.admin') || ''; } catch (e) { /* */ }
  document.getElementById('app').innerHTML = `
    <header class="top"><div><div class="muted">MEW Shift</div><h1>إرسال إعلان</h1></div></header>
    <form class="card stack" data-form="admin">
      <label class="stack sm-gap"><b>كلمة سر الإدارة</b><input type="password" name="key" class="text-in" value="${esc(key)}" autocomplete="current-password" required></label>
      <label class="stack sm-gap"><b>العنوان</b><input type="text" name="title" class="text-in" maxlength="80" required placeholder="مثال: اعتماد عطلة عيد الفطر"></label>
      <label class="stack sm-gap"><b>النص</b><textarea name="body" class="text-in area" maxlength="300" rows="4" required placeholder="مثال: العطلة من الأحد إلى الأربعاء."></textarea></label>
      <span class="muted sm">يصل كإشعار لكل من فعّل الإشعارات، ويظهر كبطاقة في الصفحة الرئيسية لكل المستخدمين لمدة 30 يوماً.</span>
      <button type="submit" class="btn primary">إرسال للجميع</button>
      <div id="admin-result" class="sm"></div>
    </form>
    <section class="card stack" id="admin-list"><b>آخر الإعلانات</b><span class="muted sm">جارٍ التحميل…</span></section>`;
  loadAdminList();
}
async function loadAdminList() {
  const box = document.getElementById('admin-list');
  try {
    const r = await (await fetch(PUSH_API + '/announcements', { cache: 'no-store' })).json();
    box.innerHTML = '<b>آخر الإعلانات</b>' + ((r.items || []).map(a => `<div class="list-row stack sm-gap"><div class="row-between"><b>${esc(a.title)}</b><button type="button" class="link danger-t" data-act="adminDelete" data-v="${a.id}">حذف</button></div><span class="sm">${esc(a.body)}</span><span class="muted sm">${esc(a.created.slice(0, 16).replace('T', ' '))}</span></div>`).join('') || '<span class="muted sm">لا توجد إعلانات.</span>');
  } catch (e) { box.innerHTML = '<b>آخر الإعلانات</b><span class="muted sm">تعذّر التحميل.</span>'; }
}
FEATURE_SUBMIT.admin = async (f, fd) => {
  const out = document.getElementById('admin-result');
  const key = fd.get('key');
  try { sessionStorage.setItem('mewshift.admin', key); } catch (e) { /* */ }
  out.textContent = 'جارٍ الإرسال…';
  try {
    const r = await fetch(PUSH_API + '/admin/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, title: fd.get('title'), body: fd.get('body') }) });
    const j = await r.json();
    if (r.status === 401) out.textContent = 'كلمة السر غير صحيحة.';
    else if (!r.ok) out.textContent = 'تعذّر الإرسال.';
    else { out.textContent = `تم ✓ سيصل الإشعار إلى ${j.queued} جهاز خلال دقائق.`; f.reset(); f.querySelector('[name=key]').value = key; loadAdminList(); }
  } catch (e) { out.textContent = 'تعذّر الاتصال.'; }
};
FEATURE_ACTIONS.adminDelete = async v => {
  let key = ''; try { key = sessionStorage.getItem('mewshift.admin') || ''; } catch (e) { /* */ }
  if (!key) { toast('أدخل كلمة السر وأرسل مرة أولاً', true); return; }
  try { await fetch(PUSH_API + '/admin/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, id: Number(v) }) }); } catch (e) { /* */ }
  loadAdminList();
};
