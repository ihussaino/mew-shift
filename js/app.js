/* MEW Shift — الواجهة والحالة */
'use strict';

const KEY = 'mewshift.v1';
/* رابط منبّه الإشعارات على Cloudflare (فارغ = غير مفعّل بعد) */
const PUSH_API = 'https://mew-shift-push.ihussain-u14.workers.dev';
const DEFAULT = {
  settings: {
    group: null, name: '', seasons: true, grade: 45, annualBase: null, annualBaseDate: null,
    lang: 'ar', themeMode: 'auto', theme: 'light',
    notify: { att: true, exit: true, balance: true }
  },
  days: {},     // 'YYYY-MM-DD' → { in, att, out, inSrc, attSrc, attMissed }
  perms: [],    // { id, date, minutes }
  leaves: []    // { id, type: annual|sick|emergency, from, to }
};

let S = load();
let view = 'today';
let calMonth = todayISO().slice(0, 7);
let recRange = 'month';
const notified = new Set();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') {
      return {
        settings: Object.assign({}, DEFAULT.settings, raw.settings, { notify: Object.assign({}, DEFAULT.settings.notify, raw.settings && raw.settings.notify) }),
        days: raw.days || {}, perms: raw.perms || [], leaves: raw.leaves || [], push: raw.push || null,
        tomb: raw.tomb || {}, profileU: raw.profileU || 0, cloudUid: raw.cloudUid || null
      };
    }
  } catch (e) { /* تجاهل */ }
  const fresh = JSON.parse(JSON.stringify(DEFAULT));
  const backup = readCookie();
  if (backup) Object.assign(fresh.settings, backup, { notify: Object.assign({}, fresh.settings.notify, backup.notify) });
  return fresh;
}
/* نسخة احتياطية صغيرة من الإعدادات (المجموعة وغيرها) في كوكي لمدة سنة */
function readCookie() {
  try {
    const m = document.cookie.match(/(?:^|; )mewshift=([^;]*)/);
    return m ? JSON.parse(decodeURIComponent(m[1])) : null;
  } catch (e) { return null; }
}
function saveLocalOnly() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* التخزين غير متاح */ }
}
function save() {
  if (typeof cloudOnSave === 'function') cloudOnSave();
  saveLocalOnly();
  if (S.push) { clearTimeout(save._t); save._t = setTimeout(syncPush, 1500); }
  try { document.cookie = 'mewshift=' + encodeURIComponent(JSON.stringify(S.settings)) + '; max-age=31536000; path=/; SameSite=Lax'; } catch (e) { /* */ }
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* ---------- اللغة والتنسيق ---------- */
function t(k) { const L = I18N[S.settings.lang] || I18N.ar; return L[k] != null ? L[k] : (I18N.ar[k] != null ? I18N.ar[k] : k); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function todayISO() { return localISO(new Date()); }
function nowMin() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function fmt12(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  let h = Math.floor(m / 60); const mm = String(m % 60).padStart(2, '0');
  const pm = h >= 12; h = h % 12; if (h === 0) h = 12;
  return `${h}:${mm} ${pm ? t('pm') : t('am')}`;
}
function fmtPlain(min) { const m = ((Math.round(min) % 1440) + 1440) % 1440; let h = Math.floor(m / 60) % 12; if (h === 0) h = 12; return `${h}:${String(m % 60).padStart(2, '0')}`; }
function fmtHM(s) { const v = parseHM(s); return v == null ? '' : fmt12(v); }
function fmtDur(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h} ${t('hShort')} ${m} ${t('mShort')}`;
  if (h) return `${h} ${t('hShort')}`;
  return `${m} ${t('mShort')}`;
}
function dayName(d) { return t('weekdays').split(',')[weekday(d)]; }
function monthName(m) { return t('months').split(',')[m - 1]; }
function fmtDate(d) { const [y, m, dd] = d.split('-').map(Number); return `${dayName(d)} ${dd} ${monthName(m)} ${y}`; }
function fmtShort(d) { const [, m, dd] = d.split('-').map(Number); return `${dd} ${monthName(m)}`; }
function shiftName(s) { return t('shift_' + (s || 'O')); }
function shiftHours(s) { if (!isWorkShift(s)) return t('restDay'); const sh = RULES.shifts[s]; return `${fmt12(sh.start)} — ${fmt12(sh.end)}`; }

/* ---------- الحسابات ---------- */
function group() { return S.settings.group; }

function activeDate() {
  const td = todayISO(), y = addDays(td, -1);
  if (nowMin() < 7 * 60 + 30 && shiftOf(group(), y) === 'N') return y;
  return td;
}
/* الدقائق الحالية منسوبة ليوم الشفت (لشفت الليل بعد منتصف الليل) */
function nowRel(date) { return nowMin() + (date !== todayISO() ? 1440 : 0); }

/* ---------- الاستئذانات: دخول، أثناء الدوام، انصراف ---------- */
function permsOn(date) { return S.perms.filter(p => p.date === date); }
function arrivalPerm(date) { return permsOn(date).find(p => p.kind === 'in') || null; }
function leavePerm(date) { return permsOn(date).find(p => p.kind === 'out') || null; }
/* إذن دخول يمتد بعد نافذة التواجد = لا تُطلب بصمة التواجد */
function attExempt(date) {
  const sh = shiftOf(group(), date), p = arrivalPerm(date);
  return !!p && isWorkShift(sh) && deltaFromStart(sh, parseHM(p.to)) > RULES.attOffsetEnd;
}
/* وقت الانصراف المحسوب لليوم (2:30 إذا بصم مبكراً، وإلا نهاية الدوام) بالدقائق المنسوبة لبداية يوم الشفت */
function exitRelOf(date) {
  const sh = shiftOf(group(), date), d = S.days[date] || {};
  if (!isWorkShift(sh)) return null;
  if (arrivalPerm(date)) return RULES.shifts[sh].end;
  return d.in ? evalEntry(sh, d.in).exit : RULES.shifts[sh].end;
}
/* مدة الاستئذان بالدقائق حسب نوعه */
function permMinutes(kind, date, a, b) {
  const sh = shiftOf(group(), date);
  if (!isWorkShift(sh)) return 0;
  const start = RULES.shifts[sh].start, rel = x => start + deltaFromStart(sh, parseHM(x));
  if (kind === 'in') return a ? rel(a) - start : 0;
  if (kind === 'out') return a ? exitRelOf(date) - rel(a) : 0;
  if (kind === 'mid') return a && b ? rel(b) - rel(a) : 0;
  return 0;
}

function dayDeductions(date) {
  const d = S.days[date], sh = shiftOf(group(), date), res = [];
  if (!d || !isWorkShift(sh)) return res;
  if (d.in && !arrivalPerm(date)) { const e = evalEntry(sh, d.in); if (e && e.late > 0) res.push({ kind: 'late', minutes: e.late, src: d.inSrc || 'late' }); }
  if (!attExempt(date)) {
    if (d.att) { const a = evalAttendance(sh, d.att); if (a.penalty) res.push({ kind: 'att', minutes: a.penalty, src: d.attSrc || 'late' }); }
    else if (d.attMissed) res.push({ kind: 'att', minutes: RULES.attPenalty, src: d.attSrc || 'late' });
  }
  return res;
}

function usage(from, to) {
  let late = 0, perm = 0, permTimes = 0, attMissed = 0;
  Object.keys(S.days).forEach(date => {
    if (date < from || date > to) return;
    dayDeductions(date).forEach(x => {
      if (x.src === 'perm') { perm += x.minutes; permTimes++; } else late += x.minutes;
      if (x.kind === 'att') attMissed++;
    });
  });
  S.perms.forEach(p => { if (p.date >= from && p.date <= to) { perm += p.minutes; permTimes++; } });
  return { late, perm, permTimes, attMissed };
}
function monthBounds(ym) { const [y, m] = ym.split('-').map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`]; }
function monthUsage(ym) { const [a, b] = monthBounds(ym); return usage(a, b); }

function leaveDaysOf(l) { return leaveDays(l.from, l.to); }
function leaveUsage(year) {
  const y = String(year); let annual = 0, sick = 0, emergency = 0;
  S.leaves.forEach(l => {
    const n = leaveDaysOf(l).filter(d => d.startsWith(y)).length;
    if (l.type === 'annual') annual += n;
    else if (l.type === 'sick') sick += n;
    else if (l.type === 'emergency' && l.from.startsWith(y)) emergency += 1;
  });
  return { annual, sick, emergency };
}
function annualRemaining() {
  const s = S.settings;
  if (s.annualBase == null || !s.annualBaseDate) return null;
  let bal = Number(s.annualBase);
  const y0 = Number(s.annualBaseDate.slice(0, 4)), cy = Number(todayISO().slice(0, 4));
  const days = S.leaves.filter(l => l.type === 'annual').flatMap(leaveDaysOf).filter(d => d >= s.annualBaseDate);
  for (let y = y0; y <= cy; y++) {
    if (y > y0) bal = Math.min(RULES.annualCap, bal + Number(s.grade));
    bal -= days.filter(d => d.startsWith(String(y))).length;
  }
  return bal;
}
/* لعرض اليوم كإجازة وحساب الحضور: كل أيام الفترة. الخصم من الرصيد يستثني الجمعة والعطل (leaveDays). */
function leaveOn(date) { return S.leaves.find(l => date >= l.from && date <= l.to) || null; }

function stats(from, to) {
  const end = to < todayISO() ? to : todayISO();
  let scheduled = 0, onLeave = 0;
  for (let d = from; d <= end; d = addDays(d, 1)) {
    if (isWorkShift(shiftOf(group(), d))) { scheduled++; if (leaveOn(d)) onLeave++; }
  }
  const present = scheduled - onLeave;
  const pct = scheduled ? Math.round(present / scheduled * 100) : 0;
  return { scheduled, present, pct, hours: present * RULES.shiftHours, u: usage(from, to) };
}

/* تنبيه نفاد الرصيد بعد أي تغيير */
function checkExhaust(before, ym) {
  const after = monthUsage(ym);
  const msgs = [];
  if (after.late >= RULES.monthlyLateMinutes && before.late < RULES.monthlyLateMinutes) msgs.push(t('lateExhausted'));
  if (after.perm >= RULES.monthlyPermMinutes && before.perm < RULES.monthlyPermMinutes) msgs.push(t('permExhausted'));
  if (after.permTimes >= RULES.monthlyPermTimes && before.permTimes < RULES.monthlyPermTimes) msgs.push(t('permTimesExhausted'));
  if (after.late > RULES.monthlyLateMinutes || after.perm > RULES.monthlyPermMinutes || after.permTimes > RULES.monthlyPermTimes) {
    if (!msgs.length) msgs.push(t('overBalance'));
  }
  msgs.forEach(m => { toast(m, true); if (S.settings.notify.balance) notify(m); });
}
function mutate(date, fn) {
  const ym = date.slice(0, 7), before = monthUsage(ym);
  fn(); save(); checkExhaust(before, ym); render();
}

/* ---------- العرض ---------- */
const $app = () => document.getElementById('app');

function render() {
  if (sharedView()) return;
  applyTheme();
  document.documentElement.lang = S.settings.lang;
  document.documentElement.dir = S.settings.lang === 'ar' ? 'rtl' : 'ltr';
  document.title = 'MEW Shift';
  if (!group() || !S.settings.name) obActive = true;
  const onboarding = obActive;
  if (onboarding) view = 'today';
  document.getElementById('nav').hidden = onboarding;
  const html = view === 'today' ? renderToday() : view === 'calendar' ? renderCalendar() : view === 'records' ? renderRecords() : view === 'about' ? renderAbout() : renderSettings();
  $app().innerHTML = html;
  renderNav();
  updateCountdowns();
}

function renderNav() {
  const items = [['today', 'navToday', ICONS.home], ['calendar', 'navCalendar', ICONS.cal], ['records', 'navRecords', ICONS.chart], ['settings', 'navSettings', ICONS.gear], ['about', 'navAbout', ICONS.info]];
  document.getElementById('nav').innerHTML = `<div class="nav-brand"><img src="icons/icon-192.png?v=3" alt="" width="44" height="44"><div><b>MEW Shift</b><span>${t('station')}</span></div></div>` + items.map(([k, l, ic]) =>
    `<button type="button" class="nav-btn${view === k ? ' on' : ''}" data-act="nav" data-v="${k}" aria-current="${view === k ? 'page' : 'false'}">${ic}<span>${t(l)}</span></button>`).join('');
}

function groupChip() {
  return `<button type="button" class="chip-primary" data-act="nav" data-v="settings">${t('group')} ${esc(group() || '?')}</button>`;
}

/* أول دخول: الاسم والمجموعة */
/* ---------- الترحيب: 4 خطوات (الاسم، المجموعة، الإجازات، التنبيهات) ---------- */
let obName = null, obGroup = null, obStep = 1, obActive = false, obInstallDismissed = false;
try { obInstallDismissed = sessionStorage.getItem('mewshift.installHint') === '1'; } catch (e) { /* */ }
function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function obProgress(step, skippable) {
  return `<div class="ob-progress"><div class="row-between"><span class="muted sm">${t('stepOf').replace('{n}', step)}</span>${skippable ? `<button type="button" class="link" data-act="obSkip">${t('later')}</button>` : ''}</div>
    <div class="ob-bars">${[1, 2, 3, 4].map(i => `<span class="${i <= step ? 'on' : ''}"></span>`).join('')}</div></div>`;
}
function installHint() {
  if (obInstallDismissed || !isIOS() || isStandalone()) return '';
  return `<div class="install-hint" role="dialog" aria-label="${t('installTitle')}"><div class="install-card">
    <div class="install-head"><img src="icons/icon-192.png?v=3" alt="" width="52" height="52"><div class="stack sm-gap"><b>${t('installTitle')}</b><span class="muted sm">${t('installWhy')}</span></div></div>
    <ol class="install-steps"><li>${t('installStep1')} ${ICONS.share}</li><li>${t('installStep2')}</li><li>${t('installStep3')}</li></ol>
    <button type="button" class="link" data-act="obInstallLater">${t('continueBrowser')}</button></div>
    <svg class="install-arrow" viewBox="0 0 40 60" aria-hidden="true"><path d="M20 4v44M8 36l12 14 12-14"/></svg></div>`;
}
function renderOnboarding() {
  if (obName == null) obName = S.settings.name || '';
  if (obGroup == null) obGroup = S.settings.group;
  let body = '';
  if (obStep === 1) {
    body = `${obProgress(1)}
      <div class="stack sm-gap ob-title"><h1>${t('obHello')} 👋</h1><p class="muted">${t('obNameQ')}</p></div>
      <label class="stack sm-gap"><b>${t('yourName')}</b><input type="text" class="text-in big-in" data-act="obName" value="${esc(obName)}" maxlength="30" autocomplete="given-name" placeholder="${t('namePlaceholder')}"></label>
      <div class="privacy-note">${ICONS.lock}<span>${t('privacyNote')}</span></div>
      <button type="button" class="btn primary ob-next" data-act="obNext"${obName.trim() ? '' : ' disabled'}>${t('next')}</button>
      ${cloudEnabled() ? `<div class="or-sep"><span>${t('haveAccountLogin')}</span></div>${googleBtn()}<button type="button" class="link center" data-act="openAuth" data-v="login">${t('emailLogin')}</button>` : ''}`;
  } else if (obStep === 2) {
    const today = todayISO();
    const preview = obGroup ? (() => { const sh = shiftOf(obGroup, today), tm = shiftOf(obGroup, addDays(today, 1)); return `<div class="ob-preview"><span>${t('today')}: <b>${shiftName(sh)}</b></span><span>${t('tomorrow')}: <b>${shiftName(tm)}</b></span></div>`; })() : '';
    body = `${obProgress(2)}
      <div class="stack sm-gap ob-title"><h1>${t('obGroupQ')}</h1><p class="muted">${t('obGroupHint')}</p></div>
      <div class="grid5">${['A', 'B', 'C', 'D', 'E'].map(g => `<button type="button" class="seg-big ob-group${obGroup === g ? ' on' : ''}" data-act="obGroup" data-v="${g}" aria-pressed="${obGroup === g}">${g}</button>`).join('')}</div>
      ${preview}
      <span class="muted sm">${t('station')}</span>
      <button type="button" class="btn primary ob-next" data-act="obNext"${obGroup ? '' : ' disabled'}>${t('next')}</button>`;
  } else if (obStep === 3) {
    const st = S.settings;
    body = `${obProgress(3, true)}
      <div class="stack sm-gap ob-title"><h1>${t('obLeaveQ')}</h1><p class="muted">${t('obLeaveHint')}</p></div>
      <section class="card stack"><b>${t('gradeLabel')}</b><div class="seg">${[[35, '35 ' + t('day')], [45, '45 ' + t('day')]].map(([v, l]) => `<button type="button" class="${Number(st.grade) === v ? 'on' : ''}" data-act="grade" data-v="${v}">${l}</button>`).join('')}</div></section>
      <section class="card stack"><label class="row-between"><b>${t('currentBalance')}</b><input type="number" inputmode="numeric" min="0" max="180" class="num" data-act="annualBase" value="${st.annualBase == null ? '' : esc(st.annualBase)}" placeholder="0"></label><span class="muted sm">${t('obBalanceWhere')}</span></section>
      <button type="button" class="btn primary ob-next" data-act="obNext">${t('next')}</button>`;
  } else {
    const canPush = pushSupported() && (!isIOS() || isStandalone());
    body = `${obProgress(4, true)}
      <div class="ob-bell">${ICONS.bell}</div>
      <div class="stack sm-gap ob-title center"><h1>${t('obNotifyTitle')}</h1><p class="muted">${t('obNotifyHint')}</p></div>
      <section class="card ob-list"><div class="row-between"><span>${t('btnAtt')}</span><span class="muted sm">9:01 · 5:01 · 1:01</span></div><div class="row-between"><span>${t('notifyExit')}</span><span class="muted sm">${t('byPunch')}</span></div><div class="row-between"><span>${t('stationAnn')}</span><span class="muted sm">${t('annKinds')}</span></div></section>
      ${canPush ? '' : `<span class="muted sm center">${t('installFirst')}</span>`}
      <div class="stack ob-next">${canPush ? `<button type="button" class="btn primary" data-act="obEnablePush">${t('obEnable')}</button>` : ''}<button type="button" class="btn" data-act="obFinish">${t('obWithout')}</button></div>`;
  }
  return `<div class="onboard-flow">${body}</div>${installHint()}`;
}
function obFinish() { obActive = false; obStep = 1; save(); view = 'today'; render(); toast(`${t('hello')} ${S.settings.name}`); }

/* ---------- عبارة الترحيب حسب الوقت والشفت ---------- */
function greeting() {
  const n = esc(S.settings.name), date = activeDate(), sh = shiftOf(group(), date), lv = leaveOn(date), d = S.days[date] || {};
  if (lv) return lv.type === 'sick' ? `${t('gSick')} 🤲` : lv.type === 'emergency' ? `${t('gEmergency')} ${n}` : `${t('gAnnual')} ${n} 🌴`;
  if (!isWorkShift(sh)) return `${t('gRest')} ${n} 😌`;
  if (d.out) return `${t('gDone')} 👏`;
  const nr = nowRel(date), st = RULES.shifts[sh].start;
  if (d.in || nr >= st) return `${t('gWorking')} ${n} 💪🏻`;
  if (sh === 'N') return `${t('gNight')} 🌙`;
  if (sh === 'A') return `${t('gEvening')} ${n} 🌤️`;
  return `${t('gMorning')} ${n} ☀️`;
}

function renderToday() {
  if (obActive) return renderOnboarding();

  const date = activeDate(), sh = shiftOf(group(), date), d = S.days[date] || {}, hol = holidayOn(date), lv = leaveOn(date);
  const ym = todayISO().slice(0, 7), u = monthUsage(ym);
  const permLeft = Math.max(0, RULES.monthlyPermMinutes - u.perm), lateLeft = Math.max(0, RULES.monthlyLateMinutes - u.late);
  const timesLeft = Math.max(0, RULES.monthlyPermTimes - u.permTimes);
  let main = '';

  if (isWorkShift(sh) && !lv) {
    const e = d.in ? evalEntry(sh, d.in) : null;
    const win = attWindow(sh);
    const nr = nowRel(date);
    const exempt = attExempt(date), outP = leavePerm(date);
    const status = e
      ? `<div class="shift-info"><span>${t('punchedIn')} ${fmtHM(d.in)}</span><b>${t('yourExit')} ${outP ? fmtHM(outP.from) + ' (' + t('permShort') + ')' : fmt12(exitRelOf(date))}</b></div>${e.late && !arrivalPerm(date) ? `<div class="shift-info warn-row">${t('lateBy')} ${e.late} ${t('minutes')} — ${t('from_' + (d.inSrc || 'late'))}</div>` : ''}`
      : `<div class="shift-info"><span>${t('pressAfterPunch')}</span></div>`;
    main += `
      <section class="shift-card s-${sh}${hol ? ' has-hol' : ''}">
        <div class="row-between"><span class="label">${date !== todayISO() ? t('yesterdayShift') : t('todayShift')}</span>${hol ? `<span class="hol-tag">${esc(hol[S.settings.lang] || hol.ar)}</span>` : ''}</div>
        <div class="shift-head">
          <div class="stack sm-gap"><div class="shift-name">${shiftName(sh)}</div><div class="shift-hours">${shiftHours(sh)}</div></div>
          ${d.out ? '' : shiftRing(tsOf(date, RULES.shifts[sh].start), tsOf(date, outP ? RULES.shifts[sh].start + deltaFromStart(sh, parseHM(outP.from)) : exitRelOf(date)))}
        </div>
        ${status}
      </section>
      <div class="punch-head"><button type="button" class="edit-link" data-act="editPunches" data-v="${date}">${ICONS.pencil}<span>${t('edit')}</span></button></div>
      <div class="grid3">
        ${punchBtn('in', d.in, t('btnIn'), arrivalPerm(date) ? `${t('permShort')} ${fmtHM(arrivalPerm(date).to)}` : e ? '' : fmt12(RULES.shifts[sh].start))}
        ${exempt ? `<div class="punch done k-att" aria-disabled="true">${ICONS.check}<b>${t('btnAtt')}</b><span>${t('attExempt')}</span></div>`
          : punchBtn('att', d.att, t('btnAtt'), d.attMissed ? t('forgot') : `${fmtPlain(win.from)} – ${fmtPlain(win.to)}`, !d.att && !d.attMissed && d.in, !d.att && !d.attMissed && nr < win.from ? tsOf(date, win.from) : 0)}
        ${outP && !d.out ? `<div class="punch done k-out" aria-disabled="true">${ICONS.out}<b>${t('btnOut')}</b><span>${t('permShort')} ${fmtHM(outP.from)}</span></div>` : punchBtn('out', d.out, t('btnOut'), fmt12(exitRelOf(date)))}
      </div>
      <div class="grid2">
        <button type="button" class="leave-btn" data-act="quickLeave" data-v="sick"${d.in ? ' disabled' : ''}><span class="emo" aria-hidden="true">🏥</span><b>${t('btnSick')}</b></button>
        <button type="button" class="leave-btn" data-act="quickLeave" data-v="emergency"${d.in ? ' disabled' : ''}><span class="emo" aria-hidden="true">🚨</span><b>${t('btnEmergency')}</b></button>
      </div>
      <button type="button" class="leave-btn perm-btn" data-act="openPerm" data-v="${date}"><span class="emo" aria-hidden="true">🚪</span><b>${t('btnPerm')}</b>${permsOn(date).length ? `<span class="pill">${permsOn(date).length}</span>` : ''}</button>`;
    if (d.in && !d.att && !d.attMissed && !exempt && nr > win.to) {
      main += `<section class="card alert stack"><b>${t('attMissedQ')}</b><div class="grid2">
        <button type="button" class="btn" data-act="editDay" data-v="${date}">${t('enterTime')}</button>
        <button type="button" class="btn danger" data-act="forgotAtt" data-v="${date}">${t('forgotDeduct')}</button></div></section>`;
    } else {
      main += currentSeason() === 'ramadan'
        ? `<section class="card info-row">${SEASON_ART.lantern}<span class="stack sm-gap"><b class="season-title-sm">${t('ramadanWish')}</b><span>${t('attWindow')} ${fmt12(win.from)} – ${fmt12(win.to)}${S.settings.notify.att ? ' · ' + t('willNotify') : ''}</span></span></section>`
        : `<section class="card info-row">${ICONS.bell}<span>${t('attWindow')} ${fmt12(win.from)} – ${fmt12(win.to)}${S.settings.notify.att ? ' · ' + t('willNotify') : ''}</span></section>`;
    }
  } else {
    const next = nextWork(date);
    main += `
      <section class="shift-card s-O${hol ? ' has-hol' : ''}">
        <div class="row-between"><span class="label">${t('todayShift')}</span>${hol ? `<span class="hol-tag">${esc(hol[S.settings.lang] || hol.ar)}</span>` : ''}</div>
        <div class="shift-name">${lv ? (lv.type === 'sick' ? '🏥 ' : lv.type === 'emergency' ? '🚨 ' : '') + t('leave_' + lv.type) : t('shift_O')}</div>
        ${lv && isWorkShift(sh) ? `<div class="shift-hours">${t('insteadOf')} ${shiftName(sh)} · ${shiftHours(sh)}</div>` : ''}
        ${lv ? `<button type="button" class="btn" data-act="cancelLeave" data-v="${lv.id}">${t('cancelLeave')}</button>` : ''}
        ${next ? `<div class="shift-hours">${t('nextShift')}: ${shiftName(next.s)} — ${dayName(next.d)} ${fmt12(RULES.shifts[next.s].start)}</div>${countdownBox(tsOf(next.d, RULES.shifts[next.s].start), 'next')}` : ''}
      </section>`;
  }

  const primaryCol = main; main = '';
  main += `
    <div class="grid2">
      ${balanceCard(t('permLeft'), fmtDur(permLeft), t('of') + ' 12 ' + t('hShort'), permLeft / RULES.monthlyPermMinutes, `${t('timesLeft')} ${timesLeft} ${t('of')} 4`, 'primary')}
      ${balanceCard(t('lateLeft'), lateLeft + ' ' + t('mShort'), t('of') + ' 105', lateLeft / RULES.monthlyLateMinutes, t('renewsOn') + ' 1 ' + monthName(Number(addDays(monthBounds(ym)[1], 1).slice(5, 7))), 'warn')}
    </div>
    <section class="stack"><h3>${t('nextDays')}</h3><div class="grid5">${[1, 2, 3, 4, 5].map(i => {
      const dd = addDays(todayISO(), i), s = shiftOf(group(), dd), h = holidayOn(dd);
      return `<button type="button" class="mini s-${s}${h ? ' has-hol' : ''}" data-act="openDay" data-v="${dd}"><span>${dayName(dd)}</span><b>${shiftName(s)}</b></button>`;
    }).join('')}</div></section>`;

  const season = currentSeason();
  let decor = '', kicker = '', dateLine = fmtDate(todayISO()), banner = '';
  if (season === 'ramadan') {
    const h = hijriOf(todayISO());
    decor = SEASON_ART.ramadan; kicker = `<div class="season-kicker">${t('ramadanKareem')}</div>`;
    if (h) dateLine += ` · ${h.d} ${t('ramadanMonth')} ${h.y}`;
  } else if (season === 'national') {
    decor = SEASON_ART.national;
    banner = `<section class="card national-banner">${SEASON_ART.flag}<div class="stack sm-gap"><b class="season-title">${t('halaFeb')}</b><span class="sm">${t('nationalWish')}</span></div></section>`;
  }
  return `${decor}<header class="top${decor ? ' with-decor season-' + season : ''}"><div>${kicker}<div class="muted">${dateLine}</div><h1>${greeting()}</h1></div>${groupChip()}</header><div class="cols"><div class="col">${annBanner()}${banner}${primaryCol}</div><div class="col">${main}</div></div>`;
}

/* ---------- دائرة الشفت: قبل البداية تعدّ تنازلياً، وأثناء الدوام تمتلئ حتى وقت الخروج ---------- */
const RING_R = 42, RING_C = 2 * Math.PI * RING_R;
function shiftRing(start, end) {
  return `<div class="shift-ring" data-start="${start}" data-end="${end}" role="timer">
    <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="${RING_R}" class="sr-track"/><circle cx="50" cy="50" r="${RING_R}" class="sr-fill" stroke-dasharray="0 ${RING_C.toFixed(1)}" transform="rotate(-90 50 50)"/></svg>
    <div class="sr-center"><small class="sr-label"></small><b class="sr-time" dir="ltr"></b></div></div>`;
}
function updateShiftRings() {
  const now = Date.now();
  document.querySelectorAll('.shift-ring').forEach(el => {
    const start = Number(el.dataset.start), end = Number(el.dataset.end);
    let label, ms, prog;
    /* الحلقة تمثل الوقت المتبقي دائماً: تنقص حتى بداية الدوام، ثم تمتلئ من جديد وتنقص حتى وقت الخروج */
    if (now < start) { label = t('ringStartsIn'); ms = start - now; prog = Math.min(1, ms / (8 * 3600e3)); }
    else if (now < end) { label = t('ringLeft'); ms = end - now; prog = ms / (end - start); }
    else { label = t('ringDone'); ms = 0; prog = 0; }
    const sec = Math.floor(ms / 1000), h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s2 = sec % 60;
    const txt = ms ? (h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')}`) : '✓';
    el.querySelector('.sr-label').textContent = label;
    el.querySelector('.sr-time').textContent = txt;
    el.querySelector('.sr-fill').setAttribute('stroke-dasharray', `${(RING_C * prog).toFixed(1)} ${RING_C.toFixed(1)}`);
    el.setAttribute('aria-label', `${label} ${txt}`);
  });
}

/* ---------- العد التنازلي ---------- */
function tsOf(date, minutes) { const [y, m, dd] = date.split('-').map(Number); return new Date(y, m - 1, dd).getTime() + minutes * 60000; }
function countdownBox(target, mode) {
  return `<div class="countdown" data-target="${target}" data-mode="${mode}"><span class="cd-label"></span><b class="cd-time" dir="ltr"></b></div>`;
}
function fmtCount(ms) {
  const sec = Math.floor(Math.abs(ms) / 1000), days = Math.floor(sec / 86400);
  const h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s2 = sec % 60;
  const hms = [h, m, s2].map(x => String(x).padStart(2, '0')).join(':');
  return days ? `${days}d ${hms}` : hms;
}
function updateCountdowns() {
  updateShiftRings();
  const lockedBtn = document.querySelector('.punch.locked[data-opens]');
  if (lockedBtn && Date.now() >= Number(lockedBtn.dataset.opens) && !document.querySelector('#sheet:not([hidden])')) { render(); return; }
  document.querySelectorAll('.countdown').forEach(el => {
    const diff = Number(el.dataset.target) - Date.now(), mode = el.dataset.mode;
    const label = el.querySelector('.cd-label'), time = el.querySelector('.cd-time');
    let l;
    if (mode === 'exit') l = diff > 0 ? t('cdExit') : t('cdExitDone');
    else l = diff > 0 ? (mode === 'next' ? t('cdNext') : t('cdStart')) : t('cdStarted');
    if (label.textContent !== l) label.textContent = l;
    time.textContent = mode === 'exit' && diff <= 0 ? '' : fmtCount(diff);
    el.classList.toggle('over', diff <= 0);
  });
}

/* opensAt: وقت فتح الزر (للتواجد قبل نافذته) — قبله يكون شفافاً ومعطلاً ويتفعّل وحده عند الوقت */
function punchBtn(kind, val, label, sub, primary, opensAt) {
  const done = !!val;
  const locked = !done && opensAt > Date.now();
  const cls = done ? 'punch done' : locked ? 'punch locked' : primary ? 'punch primary' : 'punch';
  const icon = done ? ICONS.check : kind === 'att' ? ICONS.clock : kind === 'out' ? ICONS.out : ICONS.in;
  const lock = locked ? ` disabled aria-disabled="true" data-opens="${opensAt}" title="${t('opensAt')} ${esc(sub || '')}"` : '';
  return `<button type="button" class="${cls} k-${kind}" data-act="punch" data-v="${kind}"${lock}>${icon}<b>${label}</b><span>${done ? fmtHM(val) : locked ? t('opensAt') + ' ' + esc((sub || '').split(' – ')[0]) : esc(sub || '')}</span></button>`;
}
/* بطاقة رصيد بحلقة دائرية: الحلقة تمثل المتبقي من الرصيد */
function balanceCard(title, big, small, ratio, foot, tone) {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const r = 40, c = 2 * Math.PI * r, dash = (c * pct / 100).toFixed(1);
  const color = pct === 0 ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : 'var(--primary)';
  return `<section class="card bal ring-bal">
    <span class="muted">${title}</span>
    <div class="ring-wrap">
      <svg viewBox="0 0 100 100" role="img" aria-label="${title}: ${big} ${small}">
        <circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--line)" stroke-width="9"/>
        <circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${dash} ${c.toFixed(1)}" transform="rotate(-90 50 50)"/>
      </svg>
      <div class="ring-center"><b>${big}</b><small>${small}</small></div>
    </div>
    <span class="muted sm center">${foot}</span></section>`;
}
function nextWork(date) {
  for (let i = 1; i <= 6; i++) { const d = addDays(date, i), s = shiftOf(group(), d); if (isWorkShift(s)) return { d, s }; }
  return null;
}

let calGroup = null; // مجموعة معروضة مؤقتاً في الجدول (لا تغيّر الإعدادات)
function renderCalendar() {
  if (calGroup === group()) calGroup = null;
  const g = calGroup || group(), mine = !calGroup;
  const [y, m] = calMonth.split('-').map(Number);
  const [first, last] = monthBounds(calMonth);
  const lead = weekday(first);
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<div></div>';
  let work = 0;
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const s = shiftOf(g, d), h = holidayOn(d), lv = mine ? leaveOn(d) : null;
    if (isWorkShift(s)) work++;
    const cls = ['cell', 's-' + (s || 'O')];
    if (h && !isWorkShift(s)) cls.push('hol-full'); else if (h) cls.push('has-hol');
    if (d === todayISO()) cls.push('today');
    cells += `<button type="button" class="${cls.join(' ')}" data-act="${mine ? 'openDay' : 'peekDay'}" data-v="${d}" aria-label="${fmtDate(d)} ${shiftName(s)}${h ? ' — ' + esc(h.ar) : ''}">
      <span>${Number(d.slice(8))}</span>${lv ? `<i class="leave-dot" title="${t('leave_' + lv.type)}"></i>` : ''}</button>`;
  }
  const hols = HOLIDAYS.filter(h => h.from <= last && h.to >= first);
  return `
    <header class="top"><h1>${t('navCalendar')}</h1>${groupChip()}</header>
    <div class="seg group-seg" role="group" aria-label="${t('viewGroup')}">${['A', 'B', 'C', 'D', 'E'].map(x =>
      `<button type="button" class="${x === g ? 'on' : ''}" data-act="calGroup" data-v="${x}" aria-pressed="${x === g}">${x}${x === group() ? '<small>' + t('mine') + '</small>' : ''}</button>`).join('')}</div>
    ${mine ? '' : `<div class="card info-row viewing"><span>${t('viewingGroup')} <b>${g}</b></span><button type="button" class="link" data-act="calGroup" data-v="${group()}">${t('backToMine')}</button></div>`}
    ${mine ? `<div class="grid2"><button type="button" class="btn feature-btn" data-act="openPlanner">✨ ${t('plannerTitle')}</button><button type="button" class="btn feature-btn" data-act="shareSchedule">${ICONS.share} ${t('shareSchedule')}</button></div>` : ''}
    <div class="cols cal-cols"><div class="col">
    <div class="month-nav">
      <button type="button" class="icon-btn" data-act="month" data-v="-1" aria-label="${t('prevMonth')}">${S.settings.lang === 'ar' ? ICONS.right : ICONS.left}</button>
      <b>${monthName(m)} ${y}</b>
      <button type="button" class="icon-btn" data-act="month" data-v="1" aria-label="${t('nextMonth')}">${S.settings.lang === 'ar' ? ICONS.left : ICONS.right}</button>
    </div>
    <section class="card cal">
      <div class="cal-grid head">${t('weekdaysShort').split(',').map(w => `<span>${w}</span>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
    </section>
    </div><div class="col">
    <div class="legend">
      <span><i class="sw s-M"></i>${t('shift_M')}</span><span><i class="sw s-A"></i>${t('shift_A')}</span><span><i class="sw s-N"></i>${t('shift_N')}</span>
      <span><i class="sw s-O"></i>${t('shift_O')}</span><span><i class="sw hol"></i>${t('holiday')}</span><span><i class="sw s-M has-hol"></i>${t('holidayOnWork')}</span><span><i class="leave-dot static"></i>${t('leave')}</span>
    </div>
    ${hols.length ? `<section class="card stack">${hols.map(h => `<div class="row-between"><span>${esc(h[S.settings.lang] || h.ar)}</span><span class="muted">${fmtShort(h.from)}${h.to !== h.from ? ' – ' + fmtShort(h.to) : ''}</span></div>`).join('')}</section>` : ''}
    <section class="summary"><span>${t('monthHours')}</span><b>${work * RULES.shiftHours} ${t('hour')} · ${work} ${t('workDays')}</b></section>
    </div></div>`;
}

function renderRecords() {
  const td = todayISO(), y = td.slice(0, 4);
  const [from, to] = recRange === 'month' ? monthBounds(td.slice(0, 7)) : [`${y}-01-01`, `${y}-12-31`];
  const st = stats(from, to), lu = leaveUsage(y), ar = annualRemaining();
  const ok = st.pct >= RULES.bonusPercent;
  const circ = 2 * Math.PI * 44, dash = circ * st.pct / 100;
  return `
    <header class="top"><h1>${t('navRecords')}</h1></header>
    <div class="seg">
      <button type="button" class="${recRange === 'month' ? 'on' : ''}" data-act="range" data-v="month">${monthName(Number(td.slice(5, 7)))}</button>
      <button type="button" class="${recRange === 'year' ? 'on' : ''}" data-act="range" data-v="year">${t('year')} ${y}</button>
    </div>
    <button type="button" class="btn feature-btn summary-btn" data-act="openSummary">📸 ${t('summaryTitle')}</button>
    <section class="card ring-card">
      <svg width="104" height="104" viewBox="0 0 104 104" role="img" aria-label="${t('attendance')} ${st.pct}%">
        <circle cx="52" cy="52" r="44" fill="none" stroke="var(--line)" stroke-width="10"></circle>
        <circle cx="52" cy="52" r="44" fill="none" stroke="${ok ? 'var(--ok)' : 'var(--warn)'}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 52 52)"></circle>
        <text x="52" y="59" text-anchor="middle" font-size="22" font-weight="700" fill="var(--ink)">${st.pct}%</text>
      </svg>
      <div class="stack sm-gap">
        <b>${t('attendance')}</b>
        <span>${st.present} ${t('presentOf')} ${st.scheduled} ${t('workDay')}</span>
        <span class="pill ${ok ? 'ok' : 'bad'}">${ok ? t('aboveBonus') : t('belowBonus')}</span>
        <span class="muted sm">${t('pctTemp')}</span>
      </div>
    </section>
    <div class="grid2">
      ${statCard(t('workHours'), st.hours + ' ' + t('hShort'))}
      ${statCard(t('totalLate'), st.u.late + ' ' + t('mShort'))}
      ${statCard(t('permUsed'), fmtDur(st.u.perm) + ' · ' + st.u.permTimes + ' ' + t('times'))}
      ${statCard(t('attForgot'), st.u.attMissed + ' ' + t('times'))}
    </div>
    <section class="card stack">
      <b>${t('leaves')} ${y}</b>
      ${leaveBar(t('leave_annual'), ar == null ? t('setBalance') : `${t('used')} ${lu.annual} · ${t('balance')} ${ar} ${t('of')} 180`, ar == null ? 0 : ar / 180, 'primary')}
      ${leaveBar(t('leave_sick'), `${t('used')} ${lu.sick} · ${t('left')} ${Math.max(0, 15 - lu.sick)} ${t('of')} 15`, (15 - lu.sick) / 15, 'blue')}
      ${leaveBar(t('leave_emergency'), `${t('used')} ${lu.emergency} · ${t('left')} ${Math.max(0, 4 - lu.emergency)} ${t('of')} 4 ${t('times')}`, (4 - lu.emergency) / 4, 'warn')}
      <span class="muted sm">${t('leavesNote')}</span>
    </section>`;
}
function statCard(title, val) { return `<section class="card bal"><span class="muted">${title}</span><div class="big">${val}</div></section>`; }
function leaveBar(title, txt, ratio, tone) {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  return `<div class="stack sm-gap"><div class="row-between"><b class="sm-b">${title}</b><span class="sm">${txt}</span></div><div class="bar"><i class="${tone}" style="width:${pct}%"></i></div></div>`;
}

function renderSettings() {
  const s = S.settings;
  const segBtns = (act, opts, cur) => opts.map(([v, l]) => `<button type="button" class="${String(cur) === String(v) ? 'on' : ''}" data-act="${act}" data-v="${v}">${l}</button>`).join('');
  const notifState = ('Notification' in window) ? Notification.permission : 'unsupported';
  return `
    <header class="top"><h1>${t('navSettings')}</h1></header>
    <div class="settings-grid">
    <section class="card stack">
      <label class="stack sm-gap"><b>${t('yourName')}</b>
        <input type="text" class="text-in" data-act="setName" value="${esc(s.name || '')}" maxlength="30" autocomplete="given-name"></label>
      <b>${t('myGroup')}</b><span class="muted sm">${t('station')}</span>
      <div class="grid5">${['A', 'B', 'C', 'D', 'E'].map(g => `<button type="button" class="seg-big${s.group === g ? ' on' : ''}" data-act="setGroup" data-v="${g}">${g}</button>`).join('')}</div>
    </section>
    <section class="card stack">
      <b>${t('leaves')}</b>
      <div class="row-between"><span>${t('gradeLabel')}</span><div class="seg small">${segBtns('grade', [[35, '35 ' + t('day')], [45, '45 ' + t('day')]], s.grade)}</div></div>
      <label class="row-between">${t('currentBalance')}
        <input type="number" inputmode="numeric" min="0" max="180" class="num" data-act="annualBase" value="${s.annualBase == null ? '' : esc(s.annualBase)}" placeholder="0"></label>
      <span class="muted sm">${s.annualBaseDate ? t('balanceAsOf') + ' ' + fmtShort(s.annualBaseDate) : t('balanceHint')}</span>
    </section>
    <section class="card stack">
      <b>${t('appearance')}</b>
      <div class="row-between"><span>${t('dayNight')}</span><div class="seg small">${segBtns('themeMode', [['auto', t('auto')], ['manual', t('manual')]], s.themeMode)}</div></div>
      ${s.themeMode === 'auto' ? `<span class="muted sm">${t('autoHint')}</span>` : `<div class="seg">${segBtns('theme', [['light', t('light')], ['dark', t('dark')]], s.theme)}</div>`}
      <div class="row-between toggle-row"><span class="stack sm-gap"><span>${t('seasonThemes')}</span><span class="muted sm">${t('seasonHint')}</span></span>
        <button type="button" role="switch" aria-checked="${s.seasons !== false}" aria-label="${t('seasonThemes')}" class="switch${s.seasons !== false ? ' on' : ''}" data-act="toggleSeasons"><i></i></button></div>
    </section>
    <section class="card stack">
      <b>${t('notifications')}</b>
      ${[['att', 'notifyAtt'], ['exit', 'notifyExit'], ['balance', 'notifyBalance']].map(([k, l]) => `
        <div class="row-between toggle-row"><span>${t(l)}</span>
          <button type="button" role="switch" aria-checked="${s.notify[k]}" aria-label="${t(l)}" class="switch${s.notify[k] ? ' on' : ''}" data-act="toggleNotify" data-v="${k}"><i></i></button></div>`).join('')}
      ${pushSupported() ? (S.push && notifState === 'granted'
        ? `<div class="pill ok">${t('pushActive')}</div><div class="grid2"><button type="button" class="btn" data-act="testPush">${t('testPush')}</button><button type="button" class="btn" data-act="disablePush">${t('stopPush')}</button></div>`
        : notifState === 'denied' ? `<span class="muted sm">${t('notifyDenied')}</span>`
        : `<button type="button" class="btn primary" data-act="enablePush">${t('enablePush')}</button>${!isStandalone() ? `<span class="muted sm">${t('installFirst')}</span>` : ''}`)
      : `${notifState === 'default' ? `<button type="button" class="btn primary" data-act="askNotify">${t('allowNotify')}</button>` : ''}
      ${notifState === 'denied' ? `<span class="muted sm">${t('notifyDenied')}</span>` : ''}
      <span class="muted sm">${t('notifyNote')}</span>`}
    </section>
    <section class="card row-between"><b>${t('language')}</b><div class="seg small">${segBtns('lang', [['ar', 'العربية'], ['en', 'English']], s.lang)}</div></section>
    <section class="card pro stack">
      <div class="row-between"><b>MEW Shift Pro</b><span class="pill gold">${t('soon')}</span></div>
      <span class="sm">${t('proDesc')}</span>
      <div class="grid2"><div class="price">${t('monthly')}<b>$1.99</b></div><div class="price">${t('yearly')}<b>$19.99</b></div></div>
    </section>
    ${accountCard()}
    <section class="card stack">
      <b>${t('data')}</b><span class="muted sm">${Cloud.user ? t('dataNoteCloud') : t('dataNote')}</span>
      <button type="button" class="btn danger" data-act="resetAsk">${t('resetAll')}</button>
    </section>
    </div>
    <p class="muted sm center">MEW Shift · v1.0</p>`;
}

function renderAbout() {
  return `
    <section class="card about">
      <h1 class="about-title">About</h1>
      <img class="about-logo logo-light" src="img/ihussain-black.png" alt="iHussain" width="260" height="250">
      <img class="about-logo logo-dark" src="img/ihussain-white.png" alt="iHussain" width="260" height="250">
      <p class="about-text">${t('aboutText')}</p>
      <hr>
      <a class="about-mail" href="mailto:iHussain@Engineer.com" dir="ltr">iHussain@Engineer.com</a>
      <hr>
      <p class="about-copy">${t('aboutCopy')}</p>
    </section>`;
}

/* ---------- النوافذ (Sheets) ---------- */
/* النافذة السفلية: تطلع من تحت لفوق، وفيها زر إغلاق بالأعلى.
   إذا كانت مفتوحة أصلاً نحدّث محتواها فقط بدون إعادة الحركة. */
let sheetTimer;
function openSheet(html) {
  const el = document.getElementById('sheet');
  clearTimeout(sheetTimer);
  const open = !el.hidden && el.querySelector('.sheet') && !el.classList.contains('closing');
  if (open) {
    const body = el.querySelector('.sheet-body'), top = body.scrollTop;
    body.innerHTML = html; body.scrollTop = top; return;
  }
  el.classList.remove('closing');
  el.innerHTML = `<div class="sheet-backdrop" data-act="closeSheet"></div>
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-top"><div class="grab"></div><button type="button" class="sheet-close" data-act="closeSheet" aria-label="${t('close')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="sheet-body">${html}</div></div>`;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('open'));
}
function closeSheet() {
  const el = document.getElementById('sheet');
  if (el.hidden) return;
  el.classList.remove('open'); el.classList.add('closing');
  sheetTimer = setTimeout(() => { el.hidden = true; el.innerHTML = ''; el.classList.remove('closing'); }, 280);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

function srcSelect(name, cur) {
  return `<select name="${name}" class="sel"><option value="late"${cur !== 'perm' ? ' selected' : ''}>${t('from_late')}</option><option value="perm"${cur === 'perm' ? ' selected' : ''}>${t('from_perm')}</option></select>`;
}

function daySheet(date, onlyPunches) {
  const sh = shiftOf(group(), date), d = S.days[date] || {}, hol = holidayOn(date);
  const perms = S.perms.filter(p => p.date === date);
  const leaves = S.leaves.filter(l => date >= l.from && date <= l.to);
  let body = `<div class="row-between"><h2>${fmtDate(date)}</h2><span class="pill s-${sh || 'O'}">${shiftName(sh)}</span></div>
    <span class="muted">${shiftHours(sh)}${hol ? ' · ' + esc(hol[S.settings.lang] || hol.ar) : ''}</span>`;
  if (isWorkShift(sh)) {
    const e = d.in ? evalEntry(sh, d.in) : null, a = d.att ? evalAttendance(sh, d.att) : null;
    body += `<form class="stack" data-form="punches" data-date="${date}" data-only="${onlyPunches ? 1 : 0}">
      <h3>${t('punches')}</h3>
      <label class="row-between">${t('btnIn')}<input type="time" name="in" value="${esc(d.in || '')}" class="time"></label>
      ${e && e.late && !arrivalPerm(date) ? `<label class="row-between sm">${t('lateBy')} ${e.late} ${t('minutes')}${srcSelect('inSrc', d.inSrc)}</label>` : ''}
      <label class="row-between">${t('btnAtt')}<input type="time" name="att" value="${esc(d.att || '')}" class="time"></label>
      <label class="row-between sm"><span>${t('forgotAtt')}</span><input type="checkbox" name="attMissed"${d.attMissed ? ' checked' : ''} class="chk"></label>
      ${(a && a.penalty) || d.attMissed ? `<label class="row-between sm">${t('attPenalty')}${srcSelect('attSrc', d.attSrc)}</label>` : ''}
      <label class="row-between">${t('btnOut')}<input type="time" name="out" value="${esc(d.out || '')}" class="time"></label>
      ${e ? `<span class="muted sm">${t('yourExit')} ${fmt12(e.exit)}</span>` : ''}
      <button type="submit" class="btn primary">${t('save')}</button>
    </form>`;
  }
  if (onlyPunches) { openSheet(body); return; }
  body += `<form class="stack" data-form="perm" data-date="${date}">
      <h3>${t('addPerm')}</h3>
      <div class="row-between"><label class="inline">${t('hours')}<input type="number" name="h" min="0" max="12" value="0" class="num"></label>
      <label class="inline">${t('minutes')}<input type="number" name="m" min="0" max="59" value="0" class="num"></label>
      <button type="submit" class="btn">${t('add')}</button></div>
      ${perms.map(p => `<div class="row-between list-row"><span>${permLabel(p)}</span><button type="button" class="link danger-t" data-act="delPerm" data-v="${p.id}">${t('delete')}</button></div>`).join('')}
    </form>
    <form class="stack" data-form="leave">
      <h3>${t('addLeave')}</h3>
      <select name="type" class="sel"><option value="annual">${t('leave_annual')}</option><option value="sick">${t('leave_sick')}</option><option value="emergency">${t('leave_emergency')}</option></select>
      <div class="grid2"><label class="stack sm-gap sm">${t('fromDate')}<input type="date" name="from" value="${date}" class="time"></label>
      <label class="stack sm-gap sm">${t('toDate')}<input type="date" name="to" value="${date}" class="time"></label></div>
      <span class="muted sm">${t('leaveRule')}</span>
      <button type="submit" class="btn">${t('add')}</button>
      ${leaves.map(l => `<div class="row-between list-row"><span>${t('leave_' + l.type)} · ${fmtShort(l.from)}${l.to !== l.from ? ' – ' + fmtShort(l.to) : ''} (${leaveDaysOf(l).length} ${t('day')})</span><button type="button" class="link danger-t" data-act="delLeave" data-v="${l.id}">${t('delete')}</button></div>`).join('')}
    </form>`;
  openSheet(body);
}

/* ---------- نافذة الاستئذان ---------- */
let permKindSel = 'out';
function permLabel(p) {
  if (!p.kind) return `${t('perm')} ${fmtDur(p.minutes)}`;
  const times = p.kind === 'mid' ? `${fmtHM(p.from)} – ${fmtHM(p.to)}` : p.kind === 'in' ? `${t('until')} ${fmtHM(p.to)}` : `${t('fromTime')} ${fmtHM(p.from)}`;
  return `${t('permKind_' + p.kind)} · ${times} · ${fmtDur(p.minutes)}`;
}
function permBalance(date) {
  const u = monthUsage(date.slice(0, 7));
  return { min: Math.max(0, RULES.monthlyPermMinutes - u.perm), times: Math.max(0, RULES.monthlyPermTimes - u.permTimes) };
}
function permSheet(date, kind) {
  const sh = shiftOf(group(), date), bal = permBalance(date), now = hm(nowMin());
  const sel = (k) => `<button type="button" class="${kind === k ? 'on' : ''}" data-act="permKind" data-v="${k}" data-date="${date}">${t('permKind_' + k)}</button>`;
  const later = hm(nowMin() + 60);
  const fields = kind === 'in'
    ? `<label class="row-between">${t('arriveAt')}<input type="time" class="time" data-perm="a" value="${now}"></label>`
    : kind === 'mid'
      ? `<label class="row-between">${t('leaveAt')}<input type="time" class="time" data-perm="a" value="${now}"></label><label class="row-between">${t('backAt')}<input type="time" class="time" data-perm="b" value="${later}"></label>`
      : `<label class="row-between">${t('leaveAt')}<input type="time" class="time" data-perm="a" value="${now}"></label><span class="muted sm">${t('yourExit')} ${fmt12(exitRelOf(date))}</span>`;
  const list = permsOn(date);
  openSheet(`<div class="row-between"><h2>🚪 ${t('btnPerm')}</h2><span class="pill s-${sh}">${shiftName(sh)}</span></div>
    <div class="perm-bal"><span>${t('permBalanceNow')}</span><b>${fmtDur(bal.min)} ${t('of')} 12 ${t('hShort')}</b><span class="muted sm">${t('timesLeft')} ${bal.times} ${t('of')} 4</span></div>
    <div class="seg" role="group">${sel('in')}${sel('mid')}${sel('out')}</div>
    <form class="stack" data-form="permNew" data-date="${date}" data-kind="${kind}">
      ${fields}
      <div class="perm-preview" id="perm-preview" aria-live="polite"></div>
      <button type="submit" class="btn primary" id="perm-ok">${t('permConfirm')}</button>
    </form>
    ${list.length ? `<section class="card stack"><b>${t('permToday')}</b>${list.map(p => `<div class="row-between list-row"><span class="sm">${permLabel(p)}</span><button type="button" class="link danger-t" data-act="delPermToday" data-v="${p.id}">${t('delete')}</button></div>`).join('')}</section>` : ''}`);
  updatePermPreview();
}
function permCheck(date, kind, a, b) {
  const bal = permBalance(date), min = permMinutes(kind, date, a, b);
  if (!a || (kind === 'mid' && !b) || min <= 0) return { ok: false, min, err: t('permErrInvalid') };
  /* الأوقات لازم تكون داخل الدوام */
  const sh = shiftOf(group(), date), start = RULES.shifts[sh].start, end = exitRelOf(date);
  const rel = x => start + deltaFromStart(sh, parseHM(x));
  if (rel(a) < start || rel(a) > end || (b && (rel(b) > end || rel(b) < start))) return { ok: false, min, err: t('permErrOutside') };
  if (permsOn(date).some(p => p.kind === kind && kind !== 'mid')) return { ok: false, min, err: t('permExists') };
  if (bal.times <= 0) return { ok: false, min, err: t('permErrTimes') };
  if (min > bal.min) return { ok: false, min, err: `${t('permErrBalance')} (${fmtDur(bal.min)})` };
  return { ok: true, min, left: bal.min - min };
}
function updatePermPreview() {
  const f = document.querySelector('form[data-form="permNew"]'); if (!f) return;
  const a = (f.querySelector('[data-perm="a"]') || {}).value, b = (f.querySelector('[data-perm="b"]') || {}).value;
  const r = permCheck(f.dataset.date, f.dataset.kind, a, b);
  const box = document.getElementById('perm-preview'), btn = document.getElementById('perm-ok');
  box.className = 'perm-preview ' + (r.ok ? 'ok' : 'bad');
  box.textContent = r.ok ? `${t('willDeduct')} ${fmtDur(r.min)} · ${t('remainAfter')} ${fmtDur(r.left)}` : r.err;
  btn.disabled = !r.ok;
}
FEATURE_SUBMIT.permNew = (f) => {
  const date = f.dataset.date, kind = f.dataset.kind;
  const a = (f.querySelector('[data-perm="a"]') || {}).value, b = (f.querySelector('[data-perm="b"]') || {}).value;
  const r = permCheck(date, kind, a, b);
  if (!r.ok) { updatePermPreview(); return; }
  const rec = { id: uid(), date, minutes: r.min, kind };
  if (kind === 'in') { rec.from = hm(RULES.shifts[shiftOf(group(), date)].start); rec.to = a; }
  else if (kind === 'out') { rec.from = a; rec.to = hm(exitRelOf(date)); }
  else { rec.from = a; rec.to = b; }
  mutate(date, () => { S.perms.push(rec); });
  closeSheet(); toast(`${t('permAdded')} · ${fmtDur(r.min)}`);
};

function sourceSheet(date, which, minutes) {
  openSheet(`<h2>${which === 'in' ? t('lateTitle') : t('attPenaltyTitle')}</h2>
    <p>${which === 'in' ? `${t('lateBy')} ${minutes} ${t('minutes')}` : `${t('deduct')} ${minutes} ${t('minutes')}`}. ${t('chooseSource')}</p>
    <div class="grid2"><button type="button" class="btn" data-act="pickSrc" data-v="${date}|${which}|late">${t('from_late')}</button>
    <button type="button" class="btn primary" data-act="pickSrc" data-v="${date}|${which}|perm">${t('from_perm')}</button></div>`);
}

/* ---------- الأحداث ---------- */
document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const act = el.dataset.act, v = el.dataset.v;
  switch (act) {
    case 'nav': view = v; closeSheet(); render(); window.scrollTo(0, 0); break;
    case 'setGroup': S.settings.group = v; save(); render(); break;
    case 'obGroup': obGroup = v; render(); break;
    case 'obNext':
      if (obStep === 1) { const n = (obName || '').trim().slice(0, 30); if (!n) break; S.settings.name = n; obStep = 2; }
      else if (obStep === 2) { if (!obGroup) break; S.settings.group = obGroup; obStep = 3; }
      else if (obStep === 3) obStep = 4;
      save(); render(); window.scrollTo(0, 0); break;
    case 'obSkip': if (obStep === 3) { obStep = 4; render(); } else obFinish(); break;
    case 'obFinish': obFinish(); break;
    case 'obEnablePush': enablePush().then(obFinish); break;
    case 'obInstallLater': obInstallDismissed = true; try { sessionStorage.setItem('mewshift.installHint', '1'); } catch (e) { /* */ } render(); break;
    case 'punch': doPunch(v); break;
    case 'editDay': case 'openDay': daySheet(v); break;
    case 'forgotAtt': mutate(v, () => { S.days[v] = Object.assign({}, S.days[v], { attMissed: true }); }); sourceSheet(v, 'att', RULES.attPenalty); break;
    case 'pickSrc': { const [date, which, src] = v.split('|'); mutate(date, () => { S.days[date] = Object.assign({}, S.days[date], which === 'in' ? { inSrc: src } : { attSrc: src }); }); closeSheet(); break; }
    case 'calGroup': calGroup = v === group() ? null : v; render(); break;
    case 'peekDay': { const s2 = shiftOf(calGroup, v); toast(`${t('group')} ${calGroup} · ${fmtDate(v)}: ${shiftName(s2)}${isWorkShift(s2) ? ' — ' + shiftHours(s2) : ''}`); break; }
    case 'month': { const [y, m] = calMonth.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1 + Number(v), 1)); calMonth = dt.toISOString().slice(0, 7); render(); break; }
    case 'range': recRange = v; render(); break;
    case 'grade': S.settings.grade = Number(v); save(); render(); break;
    case 'themeMode': S.settings.themeMode = v; save(); render(); break;
    case 'theme': S.settings.theme = v; save(); render(); break;
    case 'lang': S.settings.lang = v; save(); render(); break;
    case 'toggleSeasons': S.settings.seasons = S.settings.seasons === false; save(); render(); break;
    case 'toggleNotify': S.settings.notify[v] = !S.settings.notify[v]; save(); render(); break;
    case 'enablePush': enablePush(); break;
    case 'disablePush': disablePush(); break;
    case 'testPush': testPush(); break;
    case 'askNotify': if ('Notification' in window) Notification.requestPermission().then(render); break;
    case 'delPerm': { const p = S.perms.find(x => x.id === v); S.perms = S.perms.filter(x => x.id !== v); save(); render(); if (p) daySheet(p.date); break; }
    case 'delLeave': { const l = S.leaves.find(x => x.id === v); S.leaves = S.leaves.filter(x => x.id !== v); save(); render(); if (l) daySheet(l.from); break; }
    case 'quickLeave': quickLeave(v); break;
    case 'cancelLeave': openSheet(`<h2>${t('cancelLeave')}</h2><p>${t('cancelLeaveQ')}</p><div class="grid2"><button type="button" class="btn" data-act="closeSheet">${t('cancel')}</button><button type="button" class="btn danger" data-act="cancelLeaveDo" data-v="${v}">${t('cancelLeave')}</button></div>`); break;
    case 'cancelLeaveDo': S.leaves = S.leaves.filter(x => x.id !== v); save(); closeSheet(); render(); toast(t('leaveCancelled')); break;
    case 'editPunches': daySheet(v, true); break;
    case 'openPerm': permSheet(v, permKindSel); break;
    case 'permKind': permKindSel = v; permSheet(el.dataset.date, v); break;
    case 'delPermToday': { S.perms = S.perms.filter(x => x.id !== v); save(); render(); permSheet(activeDate(), permKindSel); break; }
    case 'closeSheet': closeSheet(); break;
    default: if (FEATURE_ACTIONS[act]) FEATURE_ACTIONS[act](v, el); break;
    case 'resetAsk': openSheet(`<h2>${t('resetAll')}</h2><p>${t('resetConfirm')}</p><div class="grid2"><button type="button" class="btn" data-act="closeSheet">${t('cancel')}</button><button type="button" class="btn danger" data-act="resetDo">${t('delete')}</button></div>`); break;
    case 'resetDo': if (Cloud.user) { stopSync(); FB.signOut(fbAuth).catch(() => {}); } S = JSON.parse(JSON.stringify(DEFAULT)); cloudPrime(); saveLocalOnly(); closeSheet(); view = 'today'; render(); break;
  }
});

document.addEventListener('input', ev => {
  const el = ev.target;
  if (el.dataset && el.dataset.perm) { updatePermPreview(); return; }
  if (el.dataset && el.dataset.act === 'obName') {
    obName = el.value;
    const btn = document.querySelector('[data-act="obNext"]');
    if (btn) btn.disabled = !obName.trim();
  }
});

document.addEventListener('change', ev => {
  const el = ev.target;
  if (el.dataset && el.dataset.act === 'setName') {
    const n = el.value.trim().slice(0, 30);
    if (n) { S.settings.name = n; save(); toast(t('saved')); } else { el.value = S.settings.name; }
    return;
  }
  if (el.dataset && el.dataset.act === 'annualBase') {
    const n = el.value === '' ? null : Math.max(0, Math.min(180, Number(el.value)));
    S.settings.annualBase = n; S.settings.annualBaseDate = n == null ? null : todayISO(); save(); render();
  }
});

document.addEventListener('submit', ev => {
  const f = ev.target; ev.preventDefault();
  const fd = new FormData(f);
  if (FEATURE_SUBMIT[f.dataset.form]) { FEATURE_SUBMIT[f.dataset.form](f, fd); return; }
  if (f.dataset.form === 'punches') {
    const date = f.dataset.date;
    mutate(date, () => {
      const prev = S.days[date] || {};
      S.days[date] = Object.assign({}, prev, {
        in: fd.get('in') || null, att: fd.get('att') || null, out: fd.get('out') || null,
        attMissed: !!fd.get('attMissed') && !fd.get('att'),
        inSrc: fd.get('inSrc') || prev.inSrc || 'late', attSrc: fd.get('attSrc') || prev.attSrc || 'late'
      });
    });
    toast(t('saved')); daySheet(date, f.dataset.only === '1');
  } else if (f.dataset.form === 'perm') {
    const date = f.dataset.date, min = Number(fd.get('h') || 0) * 60 + Number(fd.get('m') || 0);
    if (min <= 0) return;
    mutate(date, () => { S.perms.push({ id: uid(), date, minutes: min }); });
    daySheet(date);
  } else if (f.dataset.form === 'leave') {
    let from = fd.get('from'), to = fd.get('to');
    if (!from || !to) return; if (to < from) [from, to] = [to, from];
    S.leaves.push({ id: uid(), type: fd.get('type'), from, to }); save(); render();
    toast(`${t('leaveAdded')}: ${leaveDays(from, to).length} ${t('day')}`); daySheet(from);
  }
});

function quickLeave(type) {
  const date = activeDate();
  if (leaveOn(date)) { toast(t('alreadyLeave'), true); return; }
  S.leaves.push({ id: uid(), type, from: date, to: date }); save(); render();
  const y = date.slice(0, 4), lu = leaveUsage(y);
  if (type === 'sick') toast(`${t('sickAdded')} · ${t('left')} ${Math.max(0, RULES.sickPerYear - lu.sick)} ${t('of')} ${RULES.sickPerYear}`, lu.sick > RULES.sickPerYear);
  else toast(`${t('emergencyAdded')} · ${t('left')} ${Math.max(0, RULES.emergencyPerYear - lu.emergency)} ${t('of')} ${RULES.emergencyPerYear}`, lu.emergency > RULES.emergencyPerYear);
}

function doPunch(kind) {
  const date = activeDate(), sh = shiftOf(group(), date);
  if (!isWorkShift(sh)) return;
  const d = S.days[date] || {};
  if (d[kind]) return;
  const now = hm(nowMin());
  mutate(date, () => { S.days[date] = Object.assign({}, d, { [kind]: now }, kind === 'att' ? { attMissed: false } : {}); });
  if (kind === 'in') {
    const e = evalEntry(sh, now);
    if (e.late > 0 && !arrivalPerm(date)) sourceSheet(date, 'in', e.late);
    else if (e.early) celebrate(`${t('yourExit')} ${fmt12(e.exit)}`);
    else toast(`${t('yourExit')} ${fmt12(e.exit)}`);
  } else if (kind === 'att') {
    const a = evalAttendance(sh, now);
    if (a.penalty) sourceSheet(date, 'att', a.penalty); else toast(t('attDone'));
  } else toast(t('outDone'));
}

/* ---------- إشعارات الخادم (تصل والتطبيق مغلق) ---------- */
function pushSupported() { return !!PUSH_API && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; }
function b64uToBytes(str) { const s = str.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast(t('notifyDenied'), true); render(); return; }
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await (await fetch(PUSH_API + '/vapid')).json();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
    S.push = { endpoint: sub.endpoint }; save();
    await syncPush(); toast(t('pushOn')); render();
  } catch (e) { toast(t('pushFail'), true); }
}
async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    if (sub) { await fetch(PUSH_API + '/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
  } catch (e) { /* */ }
  S.push = null; save(); render();
}
async function testPush() {
  try {
    const r = await (await fetch(PUSH_API + '/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: S.push.endpoint }) })).json();
    toast(r.ok ? t('testSent') : t('pushFail'), !r.ok);
  } catch (e) { toast(t('pushFail'), true); }
}
async function syncPush() {
  if (!S.push || !pushSupported() || !group()) return;
  try {
    const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    if (!sub) { S.push = null; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* */ } return; }
    const td = todayISO(), end = addDays(td, 120), skip = [];
    S.leaves.forEach(l => { for (let d = l.from; d <= l.to && d <= end; d = addDays(d, 1)) if (d >= addDays(td, -1)) skip.push(d); });
    const date = activeDate(), sh = shiftOf(group(), date), dd = S.days[date] || {};
    let exitAt = null;
    if (attExempt(date)) skip.push(date);
    if (isWorkShift(sh) && dd.in && !dd.out && !leavePerm(date)) { const e = evalEntry(sh, dd.in); const at = tsOf(date, e.exit); if (at > Date.now()) exitAt = new Date(at).toISOString().slice(0, 16); }
    await fetch(PUSH_API + '/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), group: group(), lang: S.settings.lang, att: S.settings.notify.att, exit: S.settings.notify.exit, skip, exitAt })
    });
  } catch (e) { /* يعاد المحاولة عند الحفظ القادم */ }
}

/* ---------- التنبيهات أثناء فتح التطبيق ---------- */
function notify(msg) {
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification('MEW Shift', { body: msg, icon: 'icons/icon-192.png?v=3' }); } catch (e) { /* */ }
}
function tick() {
  if (SPECIAL_PAGE || !group()) return;
  const date = activeDate(), sh = shiftOf(group(), date), d = S.days[date] || {};
  if (!isWorkShift(sh) || leaveOn(date)) return;
  const nr = nowRel(date), win = attWindow(sh);
  const k1 = date + 'att';
  if (S.settings.notify.att && !d.att && !attExempt(date) && !notified.has(k1) && nr >= win.from && nr <= win.to) {
    notified.add(k1); if (!S.push) notify(t('attNow')); toast(t('attNow'), true);
  }
  if (S.settings.notify.exit && d.in && !d.out && !leavePerm(date)) {
    const e = evalEntry(sh, d.in), k2 = date + 'exit';
    const exitRel = e.exit; // منسوب لبداية يوم الشفت
    if (!notified.has(k2) && nr >= exitRel && nr <= exitRel + 30) { notified.add(k2); if (!S.push) notify(t('exitNow')); toast(t('exitNow'), true); }
  }
}

/* ---------- المظهر ---------- */
function currentSeason() {
  const q = new URLSearchParams(location.search).get('season');
  if (q === 'ramadan' || q === 'national') return q;
  if (q === 'none' || S.settings.seasons === false) return null;
  return seasonOf(todayISO());
}
function applyTheme() {
  const s = S.settings;
  const season = currentSeason();
  if (season) document.documentElement.dataset.season = season; else delete document.documentElement.dataset.season;
  const dark = s.themeMode === 'auto' ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) : s.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = season === 'ramadan' ? '#0D1530' : dark ? '#0D1320' : '#F3F5F9';
}
if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.settings.themeMode === 'auto') applyTheme(); });

/* احتفال الدخول المبكر: زينة تنزل من فوق مع رسالة */
function celebrate(sub) {
  const old = document.getElementById('celebrate'); if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = 'celebrate'; wrap.setAttribute('role', 'status');
  const colors = ['#F6C945', '#F08A24', '#2E46A0', '#00C2C7', '#D7263D', '#3FB168', '#5B9BE0'];
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pieces = '';
  if (!reduce) {
    for (let i = 0; i < 80; i++) {
      const left = Math.random() * 100, delay = Math.random() * 0.9, dur = 2.2 + Math.random() * 1.6;
      const w = 6 + Math.random() * 6, h = w * (0.4 + Math.random() * 0.8), rot = Math.random() * 360, drift = (Math.random() * 80 - 40).toFixed(0);
      const round = Math.random() < 0.25 ? 'border-radius:50%;' : '';
      pieces += `<i class="confetti" style="left:${left}%;width:${w}px;height:${h}px;background:${colors[i % colors.length]};${round}--rot:${rot}deg;--drift:${drift}px;animation-delay:${delay}s;animation-duration:${dur}s"></i>`;
    }
  }
  wrap.innerHTML = `${pieces}<div class="cheer"><div class="cheer-emoji" aria-hidden="true">🎉</div><b>${t('cheer')}</b><span>${esc(sub)}</span></div>`;
  wrap.addEventListener('click', () => wrap.remove());
  document.body.appendChild(wrap);
  try { if (navigator.vibrate) navigator.vibrate([30, 40, 30]); } catch (e) { /* */ }
  setTimeout(() => { wrap.classList.add('out'); setTimeout(() => wrap.remove(), 400); }, 4200);
}

let toastTimer;
function toast(msg, strong) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show' + (strong ? ' strong' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

/* رسومات تصاميم المناسبات */
const SEASON_ART = {
  ramadan: '<div class="season-decor ramadan"><svg class="season-art" viewBox="0 0 390 170" preserveAspectRatio="xMidYMin slice" aria-hidden="true"><circle cx="30" cy="40" r="1.4" fill="#F4E3B0" opacity="0.8"/><circle cx="80" cy="90" r="1" fill="#F4E3B0" opacity="0.6"/><circle cx="150" cy="30" r="1.2" fill="#F4E3B0" opacity="0.7"/><circle cx="210" cy="70" r="0.9" fill="#F4E3B0" opacity="0.5"/><circle cx="250" cy="25" r="1.5" fill="#F4E3B0" opacity="0.9"/><circle cx="120" cy="120" r="0.8" fill="#F4E3B0" opacity="0.5"/><circle cx="300" cy="110" r="1" fill="#F4E3B0" opacity="0.6"/><circle cx="40" cy="150" r="1" fill="#F4E3B0" opacity="0.5"/><circle cx="190" cy="140" r="1.3" fill="#F4E3B0" opacity="0.7"/><circle cx="330" cy="55" r="0.9" fill="#F4E3B0" opacity="0.6"/><circle cx="360" cy="130" r="1.1" fill="#F4E3B0" opacity="0.6"/><path d="M62 52a26 26 0 1 0 26 34a21 21 0 1 1-26-34z" fill="#F2C94C"/><g transform="translate(150,0)"><line x1="0" y1="0" x2="0" y2="30" stroke="#C9A24A" stroke-width="1.2"/><g transform="translate(0,30) scale(0.9)"><path d="M-8 0h16l-3 6h-10z" fill="#E8B84A"/><path d="M-12 6h24l-4 34h-16z" fill="#E8B84A" fill-opacity=".18" stroke="#E8B84A" stroke-width="1.6"/><path d="M-6 12h12M-7 22h14M-8 32h16" stroke="#E8B84A" stroke-width="1" opacity=".7"/><ellipse cx="0" cy="23" rx="4" ry="7" fill="#FFD27A" opacity=".85"/><path d="M-8 40h16l-3 6h-10z" fill="#E8B84A"/><circle cx="0" cy="50" r="2.2" fill="#E8B84A"/></g></g><g transform="translate(196,0)"><line x1="0" y1="0" x2="0" y2="56" stroke="#C9A24A" stroke-width="1.2"/><g transform="translate(0,56) scale(1)"><path d="M-8 0h16l-3 6h-10z" fill="#E8B84A"/><path d="M-12 6h24l-4 34h-16z" fill="#E8B84A" fill-opacity=".18" stroke="#E8B84A" stroke-width="1.6"/><path d="M-6 12h12M-7 22h14M-8 32h16" stroke="#E8B84A" stroke-width="1" opacity=".7"/><ellipse cx="0" cy="23" rx="4" ry="7" fill="#FFD27A" opacity=".85"/><path d="M-8 40h16l-3 6h-10z" fill="#E8B84A"/><circle cx="0" cy="50" r="2.2" fill="#E8B84A"/></g></g><g transform="translate(242,0)"><line x1="0" y1="0" x2="0" y2="18" stroke="#C9A24A" stroke-width="1.2"/><g transform="translate(0,18) scale(0.8)"><path d="M-8 0h16l-3 6h-10z" fill="#E8B84A"/><path d="M-12 6h24l-4 34h-16z" fill="#E8B84A" fill-opacity=".18" stroke="#E8B84A" stroke-width="1.6"/><path d="M-6 12h12M-7 22h14M-8 32h16" stroke="#E8B84A" stroke-width="1" opacity=".7"/><ellipse cx="0" cy="23" rx="4" ry="7" fill="#FFD27A" opacity=".85"/><path d="M-8 40h16l-3 6h-10z" fill="#E8B84A"/><circle cx="0" cy="50" r="2.2" fill="#E8B84A"/></g></g></svg></div>',
  national: '<div class="season-decor national"><svg class="season-art" viewBox="0 0 390 60" preserveAspectRatio="xMidYMin slice" aria-hidden="true"><path d="M0 12 Q195 40 390 12" fill="none" stroke="#8A94A6" stroke-width="1.2"/><path d="M4 10.0h22l-11 22z" fill="#007A3D"/><path d="M32 12.2h22l-11 22z" fill="#FFFFFF" stroke="#C5CEDB" stroke-width="1"/><path d="M60 14.4h22l-11 22z" fill="#CE1126"/><path d="M88 16.6h22l-11 22z" fill="#000000"/><path d="M116 18.8h22l-11 22z" fill="#007A3D"/><path d="M144 21.0h22l-11 22z" fill="#FFFFFF" stroke="#C5CEDB" stroke-width="1"/><path d="M172 23.2h22l-11 22z" fill="#CE1126"/><path d="M200 23.2h22l-11 22z" fill="#000000"/><path d="M228 21.0h22l-11 22z" fill="#007A3D"/><path d="M256 18.8h22l-11 22z" fill="#FFFFFF" stroke="#C5CEDB" stroke-width="1"/><path d="M284 16.6h22l-11 22z" fill="#CE1126"/><path d="M312 14.4h22l-11 22z" fill="#000000"/><path d="M340 12.2h22l-11 22z" fill="#007A3D"/><path d="M368 10.0h22l-11 22z" fill="#FFFFFF" stroke="#C5CEDB" stroke-width="1"/></svg></div>',
  flag: '<svg class="flag" viewBox="0 0 64 40" role="img" aria-label="علم الكويت"><rect width="64" height="13.34" fill="#007A3D"/><rect y="13.33" width="64" height="13.34" fill="#FFFFFF"/><rect y="26.66" width="64" height="13.34" fill="#CE1126"/><path d="M0 0l16 13.33v13.34L0 40z" fill="#000000"/></svg>',
  lantern: '<svg class="lantern-ic" viewBox="0 0 40 40" aria-hidden="true"><path d="M14 2h12l-2 5H16z" fill="#E8B84A"/><path d="M11 7h18l-3 26H14z" fill="#E8B84A" fill-opacity=".2" stroke="#E8B84A" stroke-width="1.6"/><ellipse cx="20" cy="20" rx="3.5" ry="6" fill="#FFD27A"/><path d="M14 33h12l-2 5H16z" fill="#E8B84A"/></svg>'
};

const ICONS = {
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  chart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  in: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M14 8l4 4-4 4M18 12H8"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16l-4-4 4-4M6 12h10"/></svg>',
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 20a1.9 1.9 0 0 0 3.4 0"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5L12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>'
};

/* ---------- البدء ---------- */
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if (S.settings.group) save();
render();
fetchAnnouncements();
if (S.push) syncPush();
cloudPrime();
if (cloudEnabled() && (S.cloudUid || (() => { try { return localStorage.getItem('mewshift.redirect'); } catch (e) { return null; } })())) cloudInit().catch(() => {});
setInterval(() => { tick(); }, 30000);
setInterval(updateCountdowns, 1000);
tick();
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); tick(); } });
/* التحديث التلقائي: يفحص عند كل فتح، ويعيد تحميل التطبيق مرة واحدة عند وصول نسخة جديدة */
if ('serviceWorker' in navigator) {
  let reloaded = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
  });
}
