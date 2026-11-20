/* MEW Shift — الواجهة والحالة */
'use strict';

const KEY = 'mewshift.v1';
const DEFAULT = {
  settings: {
    group: null, grade: 45, annualBase: null, annualBaseDate: null,
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
        days: raw.days || {}, perms: raw.perms || [], leaves: raw.leaves || []
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
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* التخزين غير متاح */ }
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

function dayDeductions(date) {
  const d = S.days[date], sh = shiftOf(group(), date), res = [];
  if (!d || !isWorkShift(sh)) return res;
  if (d.in) { const e = evalEntry(sh, d.in); if (e && e.late > 0) res.push({ kind: 'late', minutes: e.late, src: d.inSrc || 'late' }); }
  if (d.att) { const a = evalAttendance(sh, d.att); if (a.penalty) res.push({ kind: 'att', minutes: a.penalty, src: d.attSrc || 'late' }); }
  else if (d.attMissed) res.push({ kind: 'att', minutes: RULES.attPenalty, src: d.attSrc || 'late' });
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
function leaveOn(date) { return S.leaves.find(l => date >= l.from && date <= l.to && !isFriday(date) && !holidayOn(date)) || null; }

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
  applyTheme();
  document.documentElement.lang = S.settings.lang;
  document.documentElement.dir = S.settings.lang === 'ar' ? 'rtl' : 'ltr';
  document.title = 'MEW Shift';
  const html = view === 'today' ? renderToday() : view === 'calendar' ? renderCalendar() : view === 'records' ? renderRecords() : renderSettings();
  $app().innerHTML = html;
  renderNav();
}

function renderNav() {
  const items = [['today', 'navToday', ICONS.home], ['calendar', 'navCalendar', ICONS.cal], ['records', 'navRecords', ICONS.chart], ['settings', 'navSettings', ICONS.gear]];
  document.getElementById('nav').innerHTML = items.map(([k, l, ic]) =>
    `<button type="button" class="nav-btn${view === k ? ' on' : ''}" data-act="nav" data-v="${k}" aria-current="${view === k ? 'page' : 'false'}">${ic}<span>${t(l)}</span></button>`).join('');
}

function groupChip() {
  return `<button type="button" class="chip-primary" data-act="nav" data-v="settings">${t('group')} ${esc(group() || '?')}</button>`;
}

function renderToday() {
  if (!group()) return `
    <header class="top"><div><div class="muted">${fmtDate(todayISO())}</div><h1>MEW Shift</h1></div></header>
    <section class="card stack"><h2>${t('welcome')}</h2><p class="muted">${t('chooseGroupFirst')}</p>
    <div class="grid5">${['A', 'B', 'C', 'D', 'E'].map(g => `<button type="button" class="seg-big" data-act="setGroup" data-v="${g}">${g}</button>`).join('')}</div></section>`;

  const date = activeDate(), sh = shiftOf(group(), date), d = S.days[date] || {}, hol = holidayOn(date), lv = leaveOn(date);
  const ym = todayISO().slice(0, 7), u = monthUsage(ym);
  const permLeft = Math.max(0, RULES.monthlyPermMinutes - u.perm), lateLeft = Math.max(0, RULES.monthlyLateMinutes - u.late);
  const timesLeft = Math.max(0, RULES.monthlyPermTimes - u.permTimes);
  let main = '';

  if (isWorkShift(sh) && !lv) {
    const e = d.in ? evalEntry(sh, d.in) : null;
    const win = attWindow(sh);
    const nr = nowRel(date);
    const status = e
      ? `<div class="shift-info"><span>${t('punchedIn')} ${fmtHM(d.in)}</span><b>${t('yourExit')} ${fmt12(e.exit)}</b></div>${e.late ? `<div class="shift-info warn-row">${t('lateBy')} ${e.late} ${t('minutes')} — ${t('from_' + (d.inSrc || 'late'))}</div>` : ''}`
      : `<div class="shift-info"><span>${t('pressAfterPunch')}</span></div>`;
    main += `
      <section class="shift-card s-${sh}${hol ? ' has-hol' : ''}">
        <div class="row-between"><span class="label">${date !== todayISO() ? t('yesterdayShift') : t('todayShift')}</span>${hol ? `<span class="hol-tag">${esc(hol[S.settings.lang] || hol.ar)}</span>` : ''}</div>
        <div class="shift-name">${shiftName(sh)}</div>
        <div class="shift-hours">${shiftHours(sh)}</div>
        ${status}
      </section>
      <div class="grid3">
        ${punchBtn('in', d.in, t('btnIn'), e ? '' : fmt12(RULES.shifts[sh].start))}
        ${punchBtn('att', d.att, t('btnAtt'), d.attMissed ? t('forgot') : `${fmtPlain(win.from)} – ${fmtPlain(win.to)}`, !d.att && !d.attMissed && d.in)}
        ${punchBtn('out', d.out, t('btnOut'), e ? fmt12(e.exit) : '')}
      </div>`;
    if (d.in && !d.att && !d.attMissed && nr > win.to) {
      main += `<section class="card alert stack"><b>${t('attMissedQ')}</b><div class="grid2">
        <button type="button" class="btn" data-act="editDay" data-v="${date}">${t('enterTime')}</button>
        <button type="button" class="btn danger" data-act="forgotAtt" data-v="${date}">${t('forgotDeduct')}</button></div></section>`;
    } else {
      main += `<section class="card info-row">${ICONS.bell}<span>${t('attWindow')} ${fmt12(win.from)} – ${fmt12(win.to)}${S.settings.notify.att ? ' · ' + t('willNotify') : ''}</span></section>`;
    }
  } else {
    const next = nextWork(date);
    main += `
      <section class="shift-card s-O${hol ? ' has-hol' : ''}">
        <div class="row-between"><span class="label">${t('todayShift')}</span>${hol ? `<span class="hol-tag">${esc(hol[S.settings.lang] || hol.ar)}</span>` : ''}</div>
        <div class="shift-name">${lv ? t('leave_' + lv.type) : t('shift_O')}</div>
        ${next ? `<div class="shift-hours">${t('nextShift')}: ${shiftName(next.s)} — ${dayName(next.d)} ${fmt12(RULES.shifts[next.s].start)}</div>` : ''}
      </section>`;
  }

  main += `
    <div class="grid2">
      ${balanceCard(t('permLeft'), fmtDur(permLeft), t('of') + ' 12 ' + t('hShort'), permLeft / RULES.monthlyPermMinutes, `${t('timesLeft')} ${timesLeft} ${t('of')} 4`, 'primary')}
      ${balanceCard(t('lateLeft'), lateLeft + ' ' + t('mShort'), t('of') + ' 105', lateLeft / RULES.monthlyLateMinutes, t('renewsOn') + ' 1 ' + monthName(Number(addDays(monthBounds(ym)[1], 1).slice(5, 7))), 'warn')}
    </div>
    <section class="stack"><h3>${t('nextDays')}</h3><div class="grid5">${[1, 2, 3, 4, 5].map(i => {
      const dd = addDays(todayISO(), i), s = shiftOf(group(), dd), h = holidayOn(dd);
      return `<button type="button" class="mini s-${s}${h ? ' has-hol' : ''}" data-act="openDay" data-v="${dd}"><span>${dayName(dd)}</span><b>${shiftName(s)}</b></button>`;
    }).join('')}</div></section>`;

  return `<header class="top"><div><div class="muted">${fmtDate(todayISO())}</div><h1>MEW Shift</h1></div>${groupChip()}</header>${main}`;
}

function punchBtn(kind, val, label, sub, primary) {
  const done = !!val;
  const cls = done ? 'punch done' : primary ? 'punch primary' : 'punch';
  const icon = done ? ICONS.check : kind === 'att' ? ICONS.clock : kind === 'out' ? ICONS.out : ICONS.in;
  return `<button type="button" class="${cls}" data-act="punch" data-v="${kind}">${icon}<b>${label}</b><span>${done ? fmtHM(val) : esc(sub || '')}</span></button>`;
}
function balanceCard(title, big, small, ratio, foot, tone) {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  return `<section class="card bal"><span class="muted">${title}</span><div class="big">${big} <small>${small}</small></div>
    <div class="bar"><i class="${tone}" style="width:${pct}%"></i></div><span class="muted sm">${foot}</span></section>`;
}
function nextWork(date) {
  for (let i = 1; i <= 6; i++) { const d = addDays(date, i), s = shiftOf(group(), d); if (isWorkShift(s)) return { d, s }; }
  return null;
}

function renderCalendar() {
  const [y, m] = calMonth.split('-').map(Number);
  const [first, last] = monthBounds(calMonth);
  const lead = weekday(first);
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<div></div>';
  let work = 0;
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const s = shiftOf(group(), d), h = holidayOn(d), lv = leaveOn(d);
    if (isWorkShift(s)) work++;
    const cls = ['cell', 's-' + (s || 'O')];
    if (h && !isWorkShift(s)) cls.push('hol-full'); else if (h) cls.push('has-hol');
    if (d === todayISO()) cls.push('today');
    cells += `<button type="button" class="${cls.join(' ')}" data-act="openDay" data-v="${d}" aria-label="${fmtDate(d)} ${shiftName(s)}${h ? ' — ' + esc(h.ar) : ''}">
      <span>${Number(d.slice(8))}</span>${lv ? `<i class="leave-dot" title="${t('leave_' + lv.type)}"></i>` : ''}</button>`;
  }
  const hols = HOLIDAYS.filter(h => h.from <= last && h.to >= first);
  return `
    <header class="top"><h1>${t('navCalendar')}</h1>${groupChip()}</header>
    <div class="month-nav">
      <button type="button" class="icon-btn" data-act="month" data-v="-1" aria-label="${t('prevMonth')}">${S.settings.lang === 'ar' ? ICONS.right : ICONS.left}</button>
      <b>${monthName(m)} ${y}</b>
      <button type="button" class="icon-btn" data-act="month" data-v="1" aria-label="${t('nextMonth')}">${S.settings.lang === 'ar' ? ICONS.left : ICONS.right}</button>
    </div>
    <section class="card cal">
      <div class="cal-grid head">${t('weekdaysShort').split(',').map(w => `<span>${w}</span>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
    </section>
    <div class="legend">
      <span><i class="sw s-M"></i>${t('shift_M')}</span><span><i class="sw s-A"></i>${t('shift_A')}</span><span><i class="sw s-N"></i>${t('shift_N')}</span>
      <span><i class="sw s-O"></i>${t('shift_O')}</span><span><i class="sw hol"></i>${t('holiday')}</span><span><i class="sw s-M has-hol"></i>${t('holidayOnWork')}</span><span><i class="leave-dot static"></i>${t('leave')}</span>
    </div>
    ${hols.length ? `<section class="card stack">${hols.map(h => `<div class="row-between"><span>${esc(h[S.settings.lang] || h.ar)}</span><span class="muted">${fmtShort(h.from)}${h.to !== h.from ? ' – ' + fmtShort(h.to) : ''}</span></div>`).join('')}</section>` : ''}
    <section class="summary"><span>${t('monthHours')}</span><b>${work * RULES.shiftHours} ${t('hour')} · ${work} ${t('workDays')}</b></section>`;
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
    <section class="card stack">
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
    </section>
    <section class="card stack">
      <b>${t('notifications')}</b>
      ${[['att', 'notifyAtt'], ['exit', 'notifyExit'], ['balance', 'notifyBalance']].map(([k, l]) => `
        <div class="row-between toggle-row"><span>${t(l)}</span>
          <button type="button" role="switch" aria-checked="${s.notify[k]}" aria-label="${t(l)}" class="switch${s.notify[k] ? ' on' : ''}" data-act="toggleNotify" data-v="${k}"><i></i></button></div>`).join('')}
      ${notifState === 'default' ? `<button type="button" class="btn primary" data-act="askNotify">${t('allowNotify')}</button>` : ''}
      ${notifState === 'denied' ? `<span class="muted sm">${t('notifyDenied')}</span>` : ''}
      <span class="muted sm">${t('notifyNote')}</span>
    </section>
    <section class="card row-between"><b>${t('language')}</b><div class="seg small">${segBtns('lang', [['ar', 'العربية'], ['en', 'English']], s.lang)}</div></section>
    <section class="card pro stack">
      <div class="row-between"><b>MEW Shift Pro</b><span class="pill gold">${t('soon')}</span></div>
      <span class="sm">${t('proDesc')}</span>
      <div class="grid2"><div class="price">${t('monthly')}<b>$1.99</b></div><div class="price">${t('yearly')}<b>$19.99</b></div></div>
    </section>
    <section class="card stack">
      <b>${t('data')}</b><span class="muted sm">${t('dataNote')}</span>
      <button type="button" class="btn danger" data-act="resetAsk">${t('resetAll')}</button>
    </section>
    <p class="muted sm center">MEW Shift · v0.1</p>`;
}

/* ---------- النوافذ (Sheets) ---------- */
function openSheet(html) {
  const el = document.getElementById('sheet');
  el.innerHTML = `<div class="sheet-backdrop" data-act="closeSheet"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  el.hidden = false;
}
function closeSheet() { const el = document.getElementById('sheet'); el.hidden = true; el.innerHTML = ''; }

function srcSelect(name, cur) {
  return `<select name="${name}" class="sel"><option value="late"${cur !== 'perm' ? ' selected' : ''}>${t('from_late')}</option><option value="perm"${cur === 'perm' ? ' selected' : ''}>${t('from_perm')}</option></select>`;
}

function daySheet(date) {
  const sh = shiftOf(group(), date), d = S.days[date] || {}, hol = holidayOn(date);
  const perms = S.perms.filter(p => p.date === date);
  const leaves = S.leaves.filter(l => date >= l.from && date <= l.to);
  let body = `<div class="row-between"><h2>${fmtDate(date)}</h2><span class="pill s-${sh || 'O'}">${shiftName(sh)}</span></div>
    <span class="muted">${shiftHours(sh)}${hol ? ' · ' + esc(hol[S.settings.lang] || hol.ar) : ''}</span>`;
  if (isWorkShift(sh)) {
    const e = d.in ? evalEntry(sh, d.in) : null, a = d.att ? evalAttendance(sh, d.att) : null;
    body += `<form class="stack" data-form="punches" data-date="${date}">
      <h3>${t('punches')}</h3>
      <label class="row-between">${t('btnIn')}<input type="time" name="in" value="${esc(d.in || '')}" class="time"></label>
      ${e && e.late ? `<label class="row-between sm">${t('lateBy')} ${e.late} ${t('minutes')}${srcSelect('inSrc', d.inSrc)}</label>` : ''}
      <label class="row-between">${t('btnAtt')}<input type="time" name="att" value="${esc(d.att || '')}" class="time"></label>
      <label class="row-between sm"><span>${t('forgotAtt')}</span><input type="checkbox" name="attMissed"${d.attMissed ? ' checked' : ''} class="chk"></label>
      ${(a && a.penalty) || d.attMissed ? `<label class="row-between sm">${t('attPenalty')}${srcSelect('attSrc', d.attSrc)}</label>` : ''}
      <label class="row-between">${t('btnOut')}<input type="time" name="out" value="${esc(d.out || '')}" class="time"></label>
      ${e ? `<span class="muted sm">${t('yourExit')} ${fmt12(e.exit)}</span>` : ''}
      <button type="submit" class="btn primary">${t('save')}</button>
    </form>`;
  }
  body += `<form class="stack" data-form="perm" data-date="${date}">
      <h3>${t('addPerm')}</h3>
      <div class="row-between"><label class="inline">${t('hours')}<input type="number" name="h" min="0" max="12" value="0" class="num"></label>
      <label class="inline">${t('minutes')}<input type="number" name="m" min="0" max="59" value="0" class="num"></label>
      <button type="submit" class="btn">${t('add')}</button></div>
      ${perms.map(p => `<div class="row-between list-row"><span>${t('perm')} ${fmtDur(p.minutes)}</span><button type="button" class="link danger-t" data-act="delPerm" data-v="${p.id}">${t('delete')}</button></div>`).join('')}
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
    case 'punch': doPunch(v); break;
    case 'editDay': case 'openDay': daySheet(v); break;
    case 'forgotAtt': mutate(v, () => { S.days[v] = Object.assign({}, S.days[v], { attMissed: true }); }); sourceSheet(v, 'att', RULES.attPenalty); break;
    case 'pickSrc': { const [date, which, src] = v.split('|'); mutate(date, () => { S.days[date] = Object.assign({}, S.days[date], which === 'in' ? { inSrc: src } : { attSrc: src }); }); closeSheet(); break; }
    case 'month': { const [y, m] = calMonth.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1 + Number(v), 1)); calMonth = dt.toISOString().slice(0, 7); render(); break; }
    case 'range': recRange = v; render(); break;
    case 'grade': S.settings.grade = Number(v); save(); render(); break;
    case 'themeMode': S.settings.themeMode = v; save(); render(); break;
    case 'theme': S.settings.theme = v; save(); render(); break;
    case 'lang': S.settings.lang = v; save(); render(); break;
    case 'toggleNotify': S.settings.notify[v] = !S.settings.notify[v]; save(); render(); break;
    case 'askNotify': if ('Notification' in window) Notification.requestPermission().then(render); break;
    case 'delPerm': { const p = S.perms.find(x => x.id === v); S.perms = S.perms.filter(x => x.id !== v); save(); render(); if (p) daySheet(p.date); break; }
    case 'delLeave': { const l = S.leaves.find(x => x.id === v); S.leaves = S.leaves.filter(x => x.id !== v); save(); render(); if (l) daySheet(l.from); break; }
    case 'closeSheet': closeSheet(); break;
    case 'resetAsk': openSheet(`<h2>${t('resetAll')}</h2><p>${t('resetConfirm')}</p><div class="grid2"><button type="button" class="btn" data-act="closeSheet">${t('cancel')}</button><button type="button" class="btn danger" data-act="resetDo">${t('delete')}</button></div>`); break;
    case 'resetDo': S = JSON.parse(JSON.stringify(DEFAULT)); save(); closeSheet(); view = 'today'; render(); break;
  }
});

document.addEventListener('change', ev => {
  const el = ev.target;
  if (el.dataset && el.dataset.act === 'annualBase') {
    const n = el.value === '' ? null : Math.max(0, Math.min(180, Number(el.value)));
    S.settings.annualBase = n; S.settings.annualBaseDate = n == null ? null : todayISO(); save(); render();
  }
});

document.addEventListener('submit', ev => {
  const f = ev.target; ev.preventDefault();
  const fd = new FormData(f);
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
    toast(t('saved')); daySheet(date);
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

function doPunch(kind) {
  const date = activeDate(), sh = shiftOf(group(), date);
  if (!isWorkShift(sh)) return;
  const d = S.days[date] || {};
  if (d[kind]) { daySheet(date); return; }
  const now = hm(nowMin());
  mutate(date, () => { S.days[date] = Object.assign({}, d, { [kind]: now }, kind === 'att' ? { attMissed: false } : {}); });
  if (kind === 'in') {
    const e = evalEntry(sh, now);
    if (e.late > 0) sourceSheet(date, 'in', e.late); else toast(`${t('yourExit')} ${fmt12(e.exit)}`);
  } else if (kind === 'att') {
    const a = evalAttendance(sh, now);
    if (a.penalty) sourceSheet(date, 'att', a.penalty); else toast(t('attDone'));
  } else toast(t('outDone'));
}

/* ---------- التنبيهات أثناء فتح التطبيق ---------- */
function notify(msg) {
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification('MEW Shift', { body: msg, icon: 'icons/icon-192.png' }); } catch (e) { /* */ }
}
function tick() {
  if (!group()) return;
  const date = activeDate(), sh = shiftOf(group(), date), d = S.days[date] || {};
  if (!isWorkShift(sh) || leaveOn(date)) return;
  const nr = nowRel(date), win = attWindow(sh);
  const k1 = date + 'att';
  if (S.settings.notify.att && !d.att && !notified.has(k1) && nr >= win.from && nr <= win.to) {
    notified.add(k1); notify(t('attNow')); toast(t('attNow'), true);
  }
  if (S.settings.notify.exit && d.in && !d.out) {
    const e = evalEntry(sh, d.in), k2 = date + 'exit';
    const exitRel = e.exit; // منسوب لبداية يوم الشفت
    if (!notified.has(k2) && nr >= exitRel && nr <= exitRel + 30) { notified.add(k2); notify(t('exitNow')); toast(t('exitNow'), true); }
  }
}

/* ---------- المظهر ---------- */
function applyTheme() {
  const s = S.settings;
  const dark = s.themeMode === 'auto' ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) : s.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = dark ? '#0D1320' : '#F3F5F9';
}
if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.settings.themeMode === 'auto') applyTheme(); });

let toastTimer;
function toast(msg, strong) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show' + (strong ? ' strong' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

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
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'
};

/* ---------- البدء ---------- */
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if (S.settings.group) save();
render();
setInterval(() => { tick(); }, 30000);
tick();
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); tick(); } });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
