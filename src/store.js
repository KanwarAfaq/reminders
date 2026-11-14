// Shared client state + helpers for reminders and working hours.
export const S = { reminders: [], work: [], settings: { tz: 'Asia/Taipei', workPromptTime: '19:00', workPromptOn: true, schools: [], classes: [] }, line: false, loaded: false };

export const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const toLocalInput = ms => { const d = new Date(ms); return `${ymd(d)}T${hm(d)}`; };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const minutes = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const durationMin = (s, e) => { let d = minutes(e) - minutes(s); if (d <= 0) d += 1440; return d; };
export const fmtHours = min => { const h = Math.floor(min / 60), m = min % 60; return m ? `${h}h ${pad(m)}m` : `${h}h`; };
export const fmtWhen = ms => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export function rel(ms, now = Date.now()) {
  const d = ms - now, a = Math.abs(d), m = Math.round(a / 60000);
  const t = m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  return d >= 0 ? `in ${t}` : `${t} ago`;
}

export function report(entries, from, to) {
  const list = entries.filter(e => e.date >= from && e.date <= to);
  const total = list.reduce((a, e) => a + e.minutes, 0);
  const group = key => {
    const m = new Map(); for (const e of list) m.set(e[key], (m.get(e[key]) || 0) + e.minutes);
    return [...m].map(([name, min]) => ({ name, minutes: min, label: fmtHours(min), pct: total ? Math.round(min * 100 / total) : 0 })).sort((a, b) => b.minutes - a.minutes);
  };
  return { from, to, total, label: fmtHours(total), hours: +(total / 60).toFixed(2), sessions: list.length,
    bySchool: group('school'), byClass: group('classKey'), byDay: group('date').sort((a, b) => a.name.localeCompare(b.name)),
    entries: list.sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start)) };
}
export function rangePreset(p) {
  const n = new Date(), y = n.getFullYear(), m = n.getMonth();
  if (p === 'week') { const s = new Date(n); s.setDate(n.getDate() - ((n.getDay() + 6) % 7)); return [ymd(s), ymd(n)]; }
  if (p === 'month') return [ymd(new Date(y, m, 1)), ymd(n)];
  if (p === 'last') return [ymd(new Date(y, m - 1, 1)), ymd(new Date(y, m, 0))];
  if (p === 'all') return ['2000-01-01', ymd(n)];
  return [ymd(n), ymd(n)];
}
export function toCSV(entries) {
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  return ['Date,School,Class,Start,End,Hours,Note', ...entries.map(e => [e.date, e.school, e.class, e.start, e.end, (e.minutes / 60).toFixed(2), e.note || ''].map(q).join(','))].join('\n');
}
