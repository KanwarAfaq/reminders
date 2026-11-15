import {
  storageReady, pinIsSet, setPin, checkPin, hgetall, hset, hdel, getJSON, setJSON, redis, uid, subId,
  partsInTz, minutes, durationMin, fmtHours, nextRepeat, lineReady, sendLine, reminderCard, workPromptCard, reportCard, pushAll, HUB_URL,
} from './_lib.js';

const DEFAULTS = { tz: 'Asia/Taipei', workPromptTime: '19:00', workPromptOn: true, schools: [], classes: [], rates: {}, currency: 'NT$', weeklyOn: true, weeklyTime: '20:00', followUp: true };
const send = (res, code, body) => { res.setHeader('Cache-Control', 'no-store'); res.status(code).json(body); };
const clean = (s, n) => String(s ?? '').trim().slice(0, n);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isHM = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function buildReport(entries, from, to, rates = {}, currency = '') {
  const list = entries.filter(e => e.date >= from && e.date <= to);
  const total = list.reduce((a, e) => a + e.minutes, 0);
  const group = key => {
    const m = new Map();
    for (const e of list) m.set(e[key], (m.get(e[key]) || 0) + e.minutes);
    return [...m].map(([name, min]) => ({ name, minutes: min, label: fmtHours(min), pct: total ? Math.round(min * 100 / total) : 0 })).sort((a, b) => b.minutes - a.minutes);
  };
  const earn = e => Math.round(e.minutes / 60 * (Number(rates[e.school]) || 0));
  const earnings = list.reduce((a, e) => a + earn(e), 0);
  const byDay = group('date').sort((a, b) => a.name.localeCompare(b.name));
  return { from, to, earnings, currency, totalMinutes: total, totalLabel: fmtHours(total), hours: +(total / 60).toFixed(2), sessions: list.length, days: byDay.length,
    bySchool: group('school').map(x => ({ ...x, earn: list.filter(e => e.school === x.name).reduce((a, e) => a + earn(e), 0) })), byClass: group('classKey'), byDay, entries: list.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)) };
}

// Atomic "first caller wins" so the cron job and the app can never send the same alert twice.
const claim = async key => (await redis('SETNX', key, '1')) === 1 && (await redis('EXPIRE', key, 3 * 86400), true);
export function rollForward(at, repeat, now) {
  let n = nextRepeat(at, repeat), guard = 0;
  while (n && n <= now && guard++ < 5000) n = nextRepeat(n, repeat);
  return n;
}
const FOLLOW_MIN = 30;

export async function tick(now = Date.now()) {
  const out = { reminders: 0, prompted: false };
  const settings = { ...DEFAULTS, ...(await getJSON('hub:settings', {})) };
  // Collect everything due this minute, then send ONE LINE message and ONE push for the lot.
  const items = [];
  for (const r of await hgetall('hub:reminders')) {
    if (r.done) continue;
    const lead = Number(r.lead) || 0;
    if (!r.sent && r.at > now && lead && !r.earlySent && r.at - lead * 60000 <= now) {
      if (await claim(`hub:c:${r.id}:${r.at}:e`)) { items.push({ kind: 'early', r }); await hset('hub:reminders', r.id, { ...r, earlySent: now }); out.early = (out.early || 0) + 1; }
    } else if (!r.sent && r.at <= now) {
      if (!(await claim(`hub:c:${r.id}:${r.at}`))) continue;
      items.push({ kind: 'due', r });
      const next = rollForward(r.at, r.repeat, now);
      // One-off reminders are marked sent; repeating ones jump straight to their next future occurrence.
      await hset('hub:reminders', r.id, next ? { ...r, at: next, lastSent: now, earlySent: 0 } : { ...r, sent: now, sentAt: r.at });
      out.reminders++;
    } else if (r.sent && !r.followed && settings.followUp && now - r.sent >= FOLLOW_MIN * 60000 && now - r.sent < 12 * 3600e3) {
      if (await claim(`hub:c:${r.id}:${r.sentAt || r.at}:f`)) { items.push({ kind: 'follow', r }); await hset('hub:reminders', r.id, { ...r, followed: now }); out.followUps = (out.followUps || 0) + 1; }
    }
  }
  if (items.length) {
    const label = { early: x => `In ${Math.max(1, Math.round((x.r.at - now) / 60000))} min: ${x.r.title}`, due: x => x.r.title, follow: x => `Still pending: ${x.r.title}` };
    const cards = items.slice(0, 10).map(x => reminderCard({ ...x.r, title: label[x.kind](x) }, settings.tz).contents);
    const alt = items.length === 1 ? `⏰ ${label[items[0].kind](items[0])}` : `⏰ ${items.length} reminders`;
    const line = await sendLine({ type: 'flex', altText: alt, contents: cards.length === 1 ? cards[0] : { type: 'carousel', contents: cards } });
    const lone = items.length === 1;
    out.pushed = await pushAll({ title: lone ? `⏰ ${label[items[0].kind](items[0])}` : `⏰ ${items.length} reminders`, body: lone ? (items[0].r.detail || 'Reminder') : items.map(x => x.r.title).join(' · ').slice(0, 180), tag: 'reminders', url: '/#/reminders', vibrate: [300, 150, 300, 150, 600] });
    out.line = line.ok;
  }
  if (settings.workPromptOn) {
    const { date, hm } = partsInTz(now, settings.tz);
    if (hm >= settings.workPromptTime && settings.lastPrompt !== date) {
      const has = (await hgetall('hub:work')).some(e => e.date === date);
      if (!has) {
        await sendLine(workPromptCard(date));
        await pushAll({ title: '📝 Log today\'s working hours', body: 'Tap to add school, class and hours.', tag: 'work-' + date, url: '/#/work?add=1', vibrate: [200, 100, 200] });
        out.prompted = true;
      }
      await setJSON('hub:settings', { ...settings, lastPrompt: date });
    }
  }
  if (settings.weeklyOn) {
    const { date, hm } = partsInTz(now, settings.tz);
    const dow = new Date(date + 'T12:00:00Z').getUTCDay();
    if (dow === 0 && hm >= settings.weeklyTime && settings.lastWeekly !== date) {
      const from = new Date(date + 'T12:00:00Z'); from.setUTCDate(from.getUTCDate() - 6);
      const rep = buildReport(await hgetall('hub:work'), from.toISOString().slice(0, 10), date, settings.rates, settings.currency);
      if (rep.sessions) { await sendLine(reportCard(rep)); out.weekly = true; }
      const cur = { ...(await getJSON('hub:settings', {})) };
      await setJSON('hub:settings', { ...settings, ...cur, lastWeekly: date });
    }
  }
  return out;
}

export default async function handler(req, res) {
  try {
    const q = req.query || {};
    const body = typeof req.body === 'string' ? (req.body ? JSON.parse(req.body) : {}) : (req.body || {});
    const op = q.op || body.op;

    // Public: configuration + idempotent scheduler (only sends things that are already due).
    if (op === 'config') {
      return send(res, 200, { storage: storageReady(), pinSet: storageReady() ? await pinIsSet() : false, line: lineReady(), vapid: process.env.VAPID_PUBLIC_KEY || null });
    }
    if (op === 'tick') return send(res, 200, storageReady() ? await tick() : { error: 'storage not connected' });
    if (!storageReady()) return send(res, 503, { error: 'Storage is not connected yet. Add Upstash Redis to the this Vercel project project in Vercel.' });

    if (op === 'setup-pin') {
      const pin = clean(body.pin, 64);
      if (pin.length < 4) return send(res, 400, { error: 'PIN must be at least 4 characters' });
      return (await setPin(pin)) ? send(res, 200, { ok: true }) : send(res, 409, { error: 'PIN already set' });
    }

    const auth = await checkPin(req.headers['x-hub-key']);
    if (auth === 'locked') return send(res, 429, { error: 'Too many wrong PINs. Try again in an hour.' });
    if (!auth) return send(res, 401, { error: 'Wrong PIN' });

    const settings = () => getJSON('hub:settings', {}).then(s => ({ ...DEFAULTS, ...s }));

    switch (op) {
      case 'state':
        return send(res, 200, { reminders: (await hgetall('hub:reminders')).sort((a, b) => a.at - b.at), work: await hgetall('hub:work'), settings: await settings(), line: lineReady(), now: Date.now() });

      case 'reminder-save': {
        const at = Number(body.at), title = clean(body.title, 120);
        if (!title || !Number.isFinite(at)) return send(res, 400, { error: 'Title and date/time are required' });
        const old = body.id ? (await hgetall('hub:reminders')).find(r => r.id === body.id) : null;
        const r = { id: old?.id || uid(), title, detail: clean(body.detail, 1000), at, repeat: ['daily', 'weekly'].includes(body.repeat) ? body.repeat : 'none', lead: [0, 5, 10, 15, 30, 60, 120, 1440].includes(Number(body.lead)) ? Number(body.lead) : 0, created: old?.created || Date.now() };
        await hset('hub:reminders', r.id, r);
        return send(res, 200, { ok: true, reminder: r });
      }
      case 'reminder-done': {
        const r = (await hgetall('hub:reminders')).find(x => x.id === body.id);
        if (r) await hset('hub:reminders', r.id, { ...r, done: !r.done });
        return send(res, 200, { ok: true });
      }
      case 'reminder-snooze': {
        const r = (await hgetall('hub:reminders')).find(x => x.id === body.id);
        if (!r) return send(res, 404, { error: 'Reminder not found' });
        const m = Math.min(Math.max(Number(body.minutes) || 10, 1), 1440);
        await hset('hub:reminders', r.id, { ...r, at: Date.now() + m * 60000, sent: 0, done: false, earlySent: 0, followed: 0 });
        return send(res, 200, { ok: true });
      }
      case 'reminder-delete': await hdel('hub:reminders', clean(body.id, 40)); return send(res, 200, { ok: true });

      case 'work-save': {
        const s = clean(body.school, 80), c = clean(body.class, 80);
        if (!s || !c || !isDate(body.date) || !isHM(body.start) || !isHM(body.end)) return send(res, 400, { error: 'Date, school, class, start and end time are required' });
        const set = await settings(), upd = { ...set };
        if (!set.schools.includes(s)) upd.schools = [...set.schools, s];
        if (!set.classes.includes(c)) upd.classes = [...set.classes, c];
        if (upd !== set && (upd.schools.length !== set.schools.length || upd.classes.length !== set.classes.length)) await setJSON('hub:settings', upd);
        const e = { id: body.id || uid(), date: body.date, school: s, class: c, classKey: `${s} · ${c}`, start: body.start, end: body.end, minutes: durationMin(body.start, body.end), note: clean(body.note, 300), created: Date.now() };
        await hset('hub:work', e.id, e);
        return send(res, 200, { ok: true, entry: e });
      }
      case 'work-delete': await hdel('hub:work', clean(body.id, 40)); return send(res, 200, { ok: true });
      case 'work-report': {
        if (!isDate(body.from) || !isDate(body.to) || body.from > body.to) return send(res, 400, { error: 'Pick a valid date range' });
        const set = await settings(), rep = buildReport(await hgetall('hub:work'), body.from, body.to, set.rates, set.currency);
        if (body.line) { const r = await sendLine(reportCard(rep)); return send(res, 200, { ok: r.ok, error: r.error }); }
        return send(res, 200, rep);
      }

      case 'settings-save': {
        const cur = await settings();
        const next = { ...cur };
        if (isHM(body.workPromptTime)) next.workPromptTime = body.workPromptTime;
        if (typeof body.workPromptOn === 'boolean') next.workPromptOn = body.workPromptOn;
        if (body.tz) { try { Intl.DateTimeFormat('en', { timeZone: body.tz }); next.tz = body.tz; } catch { /* keep old */ } }
        if (Array.isArray(body.schools)) next.schools = [...new Set(body.schools.map(x => clean(x, 80)).filter(Boolean))];
        if (Array.isArray(body.classes)) next.classes = [...new Set(body.classes.map(x => clean(x, 80)).filter(Boolean))];
        if (body.rates && typeof body.rates === 'object') next.rates = Object.fromEntries(Object.entries(body.rates).map(([k, v]) => [clean(k, 80), Math.min(Math.max(Number(v) || 0, 0), 1e6)]).filter(([k, v]) => k && v > 0));
        if (typeof body.currency === 'string') next.currency = clean(body.currency, 6);
        if (typeof body.weeklyOn === 'boolean') next.weeklyOn = body.weeklyOn;
        if (typeof body.followUp === 'boolean') next.followUp = body.followUp;
        if (isHM(body.weeklyTime)) next.weeklyTime = body.weeklyTime;
        await setJSON('hub:settings', next);
        return send(res, 200, { ok: true, settings: next });
      }

      case 'import': {
        const rs = Array.isArray(body.reminders) ? body.reminders.slice(0, 2000) : [], ws = Array.isArray(body.work) ? body.work.slice(0, 20000) : [];
        let n = 0;
        for (const r of rs) if (r && r.id && r.title && Number.isFinite(Number(r.at))) { await hset('hub:reminders', clean(r.id, 40), { ...r, id: clean(r.id, 40), title: clean(r.title, 120), detail: clean(r.detail, 1000), at: Number(r.at) }); n++; }
        for (const e of ws) if (e && e.id && isDate(e.date) && isHM(e.start) && isHM(e.end) && e.school && e.class) { const sc = clean(e.school, 80), cl = clean(e.class, 80); await hset('hub:work', clean(e.id, 40), { id: clean(e.id, 40), date: e.date, school: sc, class: cl, classKey: `${sc} · ${cl}`, start: e.start, end: e.end, minutes: durationMin(e.start, e.end), note: clean(e.note, 300), created: Date.now() }); n++; }
        return send(res, 200, { ok: true, imported: n });
      }
      case 'push-subscribe': {
        const sub = body.subscription;
        if (!sub?.endpoint) return send(res, 400, { error: 'Invalid subscription' });
        await hset('hub:push', subId(sub.endpoint), sub);
        return send(res, 200, { ok: true });
      }
      case 'test': {
        const set = await settings();
        const line = await sendLine(reminderCard({ id: 't', title: 'Test reminder', detail: 'If you can read this card, LINE is connected correctly.', at: Date.now(), repeat: 'none' }, set.tz));
        const pushed = await pushAll({ title: '🔔 Test notification', body: 'Notifications work on this device.', tag: 'test', url: '/#/settings', vibrate: [200, 100, 200] });
        return send(res, 200, { line, pushed });
      }
      default: return send(res, 400, { error: 'Unknown operation' });
    }
  } catch (e) {
    return send(res, 500, { error: e.message || 'Server error' });
  }
}
