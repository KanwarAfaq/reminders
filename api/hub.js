import {
  storageReady, pinIsSet, setPin, checkPin, hgetall, hset, hdel, getJSON, setJSON, redis, uid, subId,
  partsInTz, minutes, durationMin, fmtHours, nextRepeat, lineReady, sendLine, reminderCard, workPromptCard, reportCard, pushAll, HUB_URL,
} from './_lib.js';

const DEFAULTS = { tz: 'Asia/Taipei', workPromptTime: '19:00', workPromptOn: true, schools: [], classes: [] };
const send = (res, code, body) => { res.setHeader('Cache-Control', 'no-store'); res.status(code).json(body); };
const clean = (s, n) => String(s ?? '').trim().slice(0, n);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isHM = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function buildReport(entries, from, to) {
  const list = entries.filter(e => e.date >= from && e.date <= to);
  const total = list.reduce((a, e) => a + e.minutes, 0);
  const group = key => {
    const m = new Map();
    for (const e of list) m.set(e[key], (m.get(e[key]) || 0) + e.minutes);
    return [...m].map(([name, min]) => ({ name, minutes: min, label: fmtHours(min), pct: total ? Math.round(min * 100 / total) : 0 })).sort((a, b) => b.minutes - a.minutes);
  };
  const byDay = group('date').sort((a, b) => a.name.localeCompare(b.name));
  return { from, to, totalMinutes: total, totalLabel: fmtHours(total), hours: +(total / 60).toFixed(2), sessions: list.length, days: byDay.length,
    bySchool: group('school'), byClass: group('classKey'), byDay, entries: list.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)) };
}

export async function tick(now = Date.now()) {
  const out = { reminders: 0, prompted: false };
  const settings = { ...DEFAULTS, ...(await getJSON('hub:settings', {})) };
  for (const r of await hgetall('hub:reminders')) {
    if (r.done || r.sent || r.at > now) continue;
    const line = await sendLine(reminderCard(r, settings.tz));
    const pushed = await pushAll({ title: `⏰ ${r.title}`, body: r.detail || 'Reminder', tag: r.id, url: '/#/reminders', vibrate: [300, 150, 300, 150, 600] });
    const next = nextRepeat(r.at, r.repeat);
    // Repeating reminders roll forward; one-off reminders are marked sent so they never fire twice.
    await hset('hub:reminders', r.id, next ? { ...r, at: Math.max(next, now + 60000), lastSent: now } : { ...r, sent: now, lineOk: line.ok, lineError: line.error, pushed });
    out.reminders++;
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
        const r = { id: old?.id || uid(), title, detail: clean(body.detail, 1000), at, repeat: ['daily', 'weekly'].includes(body.repeat) ? body.repeat : 'none', created: old?.created || Date.now() };
        await hset('hub:reminders', r.id, r);
        return send(res, 200, { ok: true, reminder: r });
      }
      case 'reminder-done': {
        const r = (await hgetall('hub:reminders')).find(x => x.id === body.id);
        if (r) await hset('hub:reminders', r.id, { ...r, done: !r.done });
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
        const rep = buildReport(await hgetall('hub:work'), body.from, body.to);
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
        await setJSON('hub:settings', next);
        return send(res, 200, { ok: true, settings: next });
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
