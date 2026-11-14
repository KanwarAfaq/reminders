import crypto from 'node:crypto';

export const HUB_URL = process.env.HUB_URL || 'https://kanwar-reminders.vercel.app';
const REDIS_URL = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
export const storageReady = () => !!(REDIS_URL() && REDIS_TOKEN());

/* ---------- Upstash Redis (REST) ---------- */
export async function redis(...cmd) {
  if (!storageReady()) throw Object.assign(new Error('Storage not connected'), { code: 'NO_STORAGE' });
  const res = await fetch(REDIS_URL(), { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN() }, body: JSON.stringify(cmd) });
  const j = await res.json();
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}
export async function hgetall(key) {
  const flat = (await redis('HGETALL', key)) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) { try { out.push(JSON.parse(flat[i + 1])); } catch { /* skip corrupt */ } }
  return out;
}
export const hset = (key, id, obj) => redis('HSET', key, id, JSON.stringify(obj));
export const hdel = (key, id) => redis('HDEL', key, id);
export async function getJSON(key, fallback) { const v = await redis('GET', key); try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
export const setJSON = (key, obj) => redis('SET', key, JSON.stringify(obj));

/* ---------- PIN auth (single owner) ---------- */
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
export async function pinIsSet() { return !!(await redis('GET', 'hub:pin')); }
export async function setPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const ok = await redis('SETNX', 'hub:pin', JSON.stringify({ salt, hash: hashPin(pin, salt) }));
  return ok === 1;
}
export async function checkPin(pin) {
  const fails = Number((await redis('GET', 'hub:fails')) || 0);
  if (fails >= 10) return 'locked';
  const rec = await getJSON('hub:pin', null);
  if (!rec || !pin) return false;
  const a = Buffer.from(hashPin(pin, rec.salt)), b = Buffer.from(rec.hash);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) { await redis('INCR', 'hub:fails'); await redis('EXPIRE', 'hub:fails', 3600); } else if (fails) await redis('DEL', 'hub:fails');
  return ok;
}

/* ---------- time helpers (timezone aware) ---------- */
export function partsInTz(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${hour}:${p.minute}` };
}
export function fmtWhen(ms, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}
export const minutes = hm => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
export const durationMin = (s, e) => { let d = minutes(e) - minutes(s); if (d <= 0) d += 1440; return d; };
export const fmtHours = min => { const h = Math.floor(min / 60), m = min % 60; return m ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`; };
export function nextRepeat(at, repeat) {
  const d = new Date(at);
  if (repeat === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (repeat === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else return null;
  return d.getTime();
}

/* ---------- LINE ---------- */
export const lineReady = () => !!(process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_USER_ID);
export async function sendLine(messages) {
  if (!lineReady()) return { ok: false, error: 'LINE not configured' };
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.LINE_CHANNEL_ACCESS_TOKEN },
    body: JSON.stringify({ to: process.env.LINE_USER_ID, messages: Array.isArray(messages) ? messages : [messages] }),
  });
  if (!res.ok) return { ok: false, error: `LINE ${res.status}: ${(await res.text()).slice(0, 200)}` };
  return { ok: true };
}

const txt = (text, o = {}) => ({ type: 'text', text: String(text).slice(0, 2000), wrap: true, ...o });
const btn = (label, uri, primary = true, color = '#6366f1') => ({ type: 'button', style: primary ? 'primary' : 'secondary', color: primary ? color : undefined, height: 'sm', action: { type: 'uri', label, uri } });
function bubble({ emoji, kicker, title, c1, c2, body, footer }) {
  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', paddingAll: '20px', spacing: 'sm',
      background: { type: 'linearGradient', angle: '135deg', startColor: c1, endColor: c2 },
      contents: [txt(`${emoji}  ${kicker}`, { size: 'xs', color: '#ffffffcc', weight: 'bold' }), txt(title, { size: 'xl', weight: 'bold', color: '#ffffff' })],
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '20px', spacing: 'md', contents: body },
    footer: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm', contents: footer },
  };
}
const row = (label, value, strong = false) => ({ type: 'box', layout: 'baseline', spacing: 'sm', contents: [txt(label, { size: 'sm', color: '#8a94ad', flex: 3 }), txt(value, { size: 'sm', color: '#1f2937', flex: 7, weight: strong ? 'bold' : 'regular' })] });

export function reminderCard(r, tz) {
  const body = [row('When', fmtWhen(r.at, tz), true)];
  if (r.detail) body.unshift(txt(r.detail, { size: 'md', color: '#374151' }));
  if (r.repeat && r.repeat !== 'none') body.push(row('Repeats', r.repeat));
  return { type: 'flex', altText: `⏰ Reminder: ${r.title}`, contents: bubble({ emoji: '⏰', kicker: 'REMINDER', title: r.title, c1: '#6366f1', c2: '#22d3ee', body, footer: [btn('Open Reminders', `${HUB_URL}/#/reminders`)] }) };
}
export function workPromptCard(date) {
  return { type: 'flex', altText: '📝 Fill in today\'s working hours', contents: bubble({ emoji: '📝', kicker: 'DAILY CHECK-IN', title: 'Log today\'s working hours', c1: '#f59e0b', c2: '#ef4444',
    body: [txt('Which school and class did you teach today, and for how long?', { color: '#374151' }), row('Date', date, true)],
    footer: [btn('Fill now', `${HUB_URL}/#/work?add=1`, true, '#f59e0b')] }) };
}
export function reportCard(rep) {
  const body = [
    { type: 'box', layout: 'baseline', spacing: 'md', contents: [txt(rep.totalLabel, { size: '3xl', weight: 'bold', color: '#111827', flex: 0 }), txt(`${rep.sessions} sessions · ${rep.days} days`, { size: 'sm', color: '#8a94ad' })] },
    { type: 'separator' },
    ...rep.bySchool.slice(0, 8).map(s => row(s.name, `${s.label} (${s.pct}%)`)),
  ];
  return { type: 'flex', altText: `📊 Working hours ${rep.from} → ${rep.to}: ${rep.totalLabel}`, contents: bubble({ emoji: '📊', kicker: 'WORKING HOURS REPORT', title: `${rep.from} → ${rep.to}`, c1: '#10b981', c2: '#0ea5e9', body, footer: [btn('See full details', `${HUB_URL}/#/work`, true, '#10b981')] }) };
}

/* ---------- Web Push ---------- */
let wp;
export async function pushAll(payload) {
  if (!process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_PUBLIC_KEY) return 0;
  wp ||= (await import('web-push')).default;
  wp.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@kmafaq.online', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const subs = await hgetall('hub:push');
  let n = 0;
  await Promise.all(subs.map(async s => {
    try { await wp.sendNotification(s, JSON.stringify(payload)); n++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await hdel('hub:push', subId(s.endpoint)); }
  }));
  return n;
}
export const subId = endpoint => crypto.createHash('sha1').update(endpoint).digest('hex');

export const uid = () => crypto.randomBytes(6).toString('hex');
