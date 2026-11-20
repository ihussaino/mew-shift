/* MEW Shift — قواعد الدوام (محطة الشعيبة)
   كل القواعد هنا في مكان واحد حتى يسهل تعديلها. */

const RULES = {
  // التاريخ المرجعي: الجمعة 20 نوفمبر 2026 — E صبح، D عصر، C ليل، B راحة أولى، A راحة ثانية
  refDate: '2026-11-20',
  posOnRef: { A: 4, B: 3, C: 2, D: 1, E: 0 },
  cycle: ['M', 'A', 'N', 'O', 'O'],
  shifts: {
    M: { start: 7 * 60, end: 15 * 60 },
    A: { start: 15 * 60, end: 23 * 60 },
    N: { start: 23 * 60, end: 31 * 60 } // ينتهي 7:00 صباح اليوم التالي
  },
  shiftHours: 8,
  earlyGrace: 30,          // من يبصم في بداية الشفت أو قبلها يخرج قبل النهاية بنصف ساعة
  lateGrace: 30,           // أول نصف ساعة بلا تأخير، بعدها يُحسب التأخير بالدقيقة
  attOffsetStart: 121,     // بصمة التواجد تبدأ بعد ساعتين ودقيقة
  attOffsetEnd: 180,       // وتنتهي بعد 3 ساعات من بداية الشفت
  attPenalty: 60,          // نسيان التواجد أو التأخر فيه = ساعة
  monthlyPermMinutes: 12 * 60,
  monthlyPermTimes: 4,
  monthlyLateMinutes: 105,
  annualCap: 180,
  sickPerYear: 15,
  emergencyPerYear: 4,
  bonusPercent: 70,
  hijriAdjust: 0            // تعديل التاريخ الهجري بالأيام إذا اختلفت رؤية الهلال في الكويت عن تقويم أم القرى
};

/* التاريخ الهجري (تقويم أم القرى) */
function hijriOf(date) {
  try {
    const f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const p = f.formatToParts(new Date(toUTC(addDays(date, -RULES.hijriAdjust))));
    const g = k => Number((p.find(x => x.type === k) || {}).value);
    return { d: g('day'), m: g('month'), y: g('year') };
  } catch (e) { return null; }
}
function isRamadan(date) { const h = hijriOf(date); return !!h && h.m === 9; }

/* تصميم المناسبة: رمضان طوال الشهر، والعيد الوطني طوال فبراير.
   إذا تداخلا، رمضان أولاً إلا من 20 فبراير (أسبوع العيد الوطني والتحرير). */
function seasonOf(date) {
  const ram = isRamadan(date), feb = date.slice(5, 7) === '02';
  if (ram && feb && date.slice(8) >= '20') return 'national';
  if (ram) return 'ramadan';
  if (feb) return 'national';
  return null;
}

/* العطل الرسمية — التواريخ النهائية بعد ترحيل الجمعة إلى الأحد.
   2026: من جدول نوبات محطات الشعيبة. العطل الإسلامية لسنة 2027 تُضاف عند إعلانها. */
const HOLIDAYS = [
  { from: '2026-01-01', to: '2026-01-03', ar: 'رأس السنة الميلادية', en: 'New Year' },
  { from: '2026-01-18', to: '2026-01-18', ar: 'الإسراء والمعراج', en: 'Isra and Mi\'raj' },
  { from: '2026-02-25', to: '2026-02-28', ar: 'العيد الوطني وعيد التحرير', en: 'National & Liberation Days' },
  { from: '2026-03-20', to: '2026-03-23', ar: 'عيد الفطر', en: 'Eid al-Fitr' },
  { from: '2026-05-26', to: '2026-05-31', ar: 'وقفة عرفات وعيد الأضحى', en: 'Arafat Day & Eid al-Adha' },
  { from: '2026-06-16', to: '2026-06-16', ar: 'رأس السنة الهجرية', en: 'Islamic New Year' },
  { from: '2026-08-27', to: '2026-08-27', ar: 'المولد النبوي', en: 'Prophet\'s Birthday' },
  { from: '2027-01-03', to: '2027-01-03', ar: 'رأس السنة الميلادية', en: 'New Year' },
  { from: '2027-02-25', to: '2027-02-25', ar: 'العيد الوطني', en: 'National Day' },
  { from: '2027-02-28', to: '2027-02-28', ar: 'عيد التحرير', en: 'Liberation Day' }
];

/* ---------- التواريخ ---------- */
function toUTC(d) { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); }
function diffDays(a, b) { return Math.round((toUTC(a) - toUTC(b)) / 864e5); }
function addDays(d, n) { return new Date(toUTC(d) + n * 864e5).toISOString().slice(0, 10); }
function weekday(d) { return new Date(toUTC(d)).getUTCDay(); } // 0 الأحد … 5 الجمعة، 6 السبت
function isFriday(d) { return weekday(d) === 5; }
function localISO(dt) {
  const y = dt.getFullYear(), m = String(dt.getMonth() + 1).padStart(2, '0'), d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function hm(min) { // دقائق → "HH:MM" على مدار 24 ساعة
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
function parseHM(s) { if (!s) return null; const [h, m] = s.split(':').map(Number); return h * 60 + m; }

/* ---------- الشفتات ---------- */
function shiftOf(group, date) {
  if (!group) return null;
  const p = (((RULES.posOnRef[group] + diffDays(date, RULES.refDate)) % 5) + 5) % 5;
  return RULES.cycle[p];
}
function isWorkShift(s) { return s === 'M' || s === 'A' || s === 'N'; }

function holidayOn(date) {
  return HOLIDAYS.find(h => date >= h.from && date <= h.to) || null;
}

/* فرق الدقائق بين وقت مسجّل وبداية الشفت، مع مراعاة تجاوز منتصف الليل */
function deltaFromStart(shift, timeMin) {
  let d = timeMin - RULES.shifts[shift].start;
  if (d < -720) d += 1440;
  if (d > 720) d -= 1440;
  return d;
}

/* بصمة الدخول → وقت الخروج والتأخير */
function evalEntry(shift, entryHM) {
  const sh = RULES.shifts[shift];
  const t = parseHM(entryHM);
  if (t == null || !sh) return null;
  const d = deltaFromStart(shift, t);
  if (d <= 0) return { exit: sh.end - RULES.earlyGrace, late: 0, early: true };
  if (d <= RULES.lateGrace) return { exit: sh.end, late: 0, early: false };
  return { exit: sh.end, late: d - RULES.lateGrace, early: false };
}

function attWindow(shift) {
  const sh = RULES.shifts[shift];
  return { from: sh.start + RULES.attOffsetStart, to: sh.start + RULES.attOffsetEnd };
}

/* بصمة التواجد → جزاء (0 أو 60 دقيقة) */
function evalAttendance(shift, attHM) {
  const t = parseHM(attHM);
  if (t == null) return { penalty: 0 };
  const d = deltaFromStart(shift, t);
  if (d > RULES.attOffsetEnd) return { penalty: RULES.attPenalty, late: true };
  return { penalty: 0, early: d < RULES.attOffsetStart };
}

/* أيام الإجازة المخصومة: كل الأيام ما عدا الجمعة والعطل الرسمية */
function leaveDays(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!isFriday(d) && !holidayOn(d)) out.push(d);
  }
  return out;
}
