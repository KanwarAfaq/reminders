import test from 'node:test';
import assert from 'node:assert/strict';

// In-memory fake of Upstash REST + LINE.
const store = new Map(); const lineSent = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('line.me')) { lineSent.push(JSON.parse(opts.body)); return { ok: true, text: async () => '' }; }
  const [cmd, k, ...a] = JSON.parse(opts.body); const C = cmd.toUpperCase(); let result = null;
  if (C === 'GET') result = store.get(k) ?? null;
  else if (C === 'SET') { store.set(k, a[0]); result = 'OK'; }
  else if (C === 'SETNX') { if (store.has(k)) result = 0; else { store.set(k, a[0]); result = 1; } }
  else if (C === 'HSET') { const h = store.get(k) || {}; h[a[0]] = a[1]; store.set(k, h); result = 1; }
  else if (C === 'HDEL') { const h = store.get(k) || {}; delete h[a[0]]; result = 1; }
  else if (C === 'HGETALL') result = Object.entries(store.get(k) || {}).flat();
  else if (C === 'INCR') { store.set(k, String(Number(store.get(k) || 0) + 1)); result = Number(store.get(k)); }
  else if (['EXPIRE', 'DEL'].includes(C)) { if (C === 'DEL') store.delete(k); result = 1; }
  return { json: async () => ({ result }) };
};
process.env.UPSTASH_REDIS_REST_URL = 'http://x'; process.env.UPSTASH_REDIS_REST_TOKEN = 't';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok'; process.env.LINE_USER_ID = 'U1';

const { default: handler, tick, buildReport } = await import('../api/hub.js');
const call = async (op, body = {}, key = '1234', method = 'POST') => {
  let code, json; const res = { setHeader() {}, status(c) { code = c; return this; }, json(j) { json = j; } };
  await handler({ method, query: method === 'GET' ? { op } : {}, body: { op, ...body }, headers: { 'x-hub-key': key } }, res); return { code, json };
};

test('PIN setup, auth and lockout-safe wrong pin', async () => {
  assert.equal((await call('state')).code, 401);
  assert.equal((await call('setup-pin', { pin: '12' })).code, 400);
  assert.equal((await call('setup-pin', { pin: '1234' })).code, 200);
  assert.equal((await call('setup-pin', { pin: '9999' })).code, 409);
  assert.equal((await call('state', {}, 'bad')).code, 401);
  assert.equal((await call('state')).code, 200);
});

test('reminder fires once, sends LINE flex card, repeating rolls forward', async () => {
  lineSent.length = 0; await call('settings-save', { workPromptOn: false }); // keep this test independent of time of day
  const at = Date.now() - 1000;
  const one = (await call('reminder-save', { title: 'Parent meeting', detail: 'Room 3', at })).json.reminder;
  const rep = (await call('reminder-save', { title: 'Daily standup', at, repeat: 'daily' })).json.reminder;
  const r1 = await tick(); assert.equal(r1.reminders, 2);
  assert.equal(lineSent.length, 1, 'two due reminders must arrive as ONE LINE message'); assert.equal(lineSent[0].messages[0].type, 'flex'); assert.equal(lineSent[0].messages[0].contents.type, 'carousel'); assert.equal(lineSent[0].to, 'U1');
  const r2 = await tick(); assert.equal(r2.reminders, 0, 'must not fire twice');
  const st = (await call('state')).json.reminders;
  assert.ok(st.find(r => r.id === one.id).sent);
  assert.ok(st.find(r => r.id === rep.id).at > Date.now() + 3600e3, 'daily moves to tomorrow');
});

test('work log: duration, report totals and grouping', async () => {
  const add = (date, school, cls, start, end) => call('work-save', { date, school, class: cls, start, end });
  assert.equal((await add('2026-11-10', 'Oak School', 'Grade 5', '16:30', '18:30')).json.entry.minutes, 120);
  await add('2026-11-10', 'Oak School', 'Grade 6', '10:00', '11:30');
  await add('2026-11-11', 'Pine Academy', 'Grade 5', '09:00', '10:00');
  await add('2026-11-20', 'Pine Academy', 'Grade 5', '09:00', '10:00');
  assert.equal((await add('2026-11-10', '', 'x', '10:00', '11:00')).code, 400);
  const rep = (await call('work-report', { from: '2026-11-10', to: '2026-11-11' })).json;
  assert.equal(rep.totalMinutes, 270); assert.equal(rep.totalLabel, '4h 30m'); assert.equal(rep.sessions, 3); assert.equal(rep.days, 2);
  assert.equal(rep.bySchool[0].name, 'Oak School'); assert.equal(rep.bySchool[0].minutes, 210);
  const s = (await call('state')).json.settings; assert.deepEqual(s.schools.sort(), ['Oak School', 'Pine Academy']);
  lineSent.length = 0; assert.equal((await call('work-report', { from: '2026-11-10', to: '2026-11-11', line: true })).json.ok, true);
  assert.match(lineSent[0].messages[0].altText, /4h 30m/);
});

test('overnight sessions wrap past midnight', async () => {
  const { durationMin } = await import('../api/_lib.js'); assert.equal(durationMin('22:00', '01:00'), 180); assert.equal(durationMin('16:30', '18:30'), 120);
});

test('evening prompt sent once per day when nothing logged', async () => {
  store.delete('hub:work'); lineSent.length = 0;
  await call('settings-save', { workPromptOn: true, workPromptTime: '00:00', tz: 'Asia/Taipei' });
  const a = await tick(); assert.equal(a.prompted, true);
  const b = await tick(); assert.equal(b.prompted, false);
  assert.match(lineSent.at(-1).messages[0].altText, /working hours/i);
});

test('early alert, snooze, earnings and import', async () => {
  const now = Date.now(); lineSent.length = 0;
  const saved = (await call('reminder-save', { title: 'Lead test', at: now + 20 * 60000, lead: 30, repeat: 'none' })).json.reminder;
  assert.equal(saved.lead, 30);
  const t1 = await tick(now); assert.equal(t1.early, 1);
  assert.ok(lineSent.some(m => m.messages[0].altText.includes('In 20 min')));
  const t2 = await tick(now + 1000); assert.equal(t2.early || 0, 0); // not repeated
  await call('reminder-snooze', { id: saved.id, minutes: 15 });
  const st = (await call('state')).json.reminders.find(r => r.id === saved.id);
  assert.ok(st.at > now + 14 * 60000 && !st.sent);
  await call('settings-save', { rates: { Alpha: 500 }, currency: 'NT$' });
  await call('work-save', { date: '2026-01-05', school: 'Alpha', class: 'A1', start: '10:00', end: '12:00' });
  const rep = (await call('work-report', { from: '2026-01-01', to: '2026-01-31' })).json;
  assert.equal(rep.earnings, 1000); assert.equal(rep.bySchool[0].earn, 1000);
  const imp = await call('import', { reminders: [{ id: 'imp1', title: 'Imported', at: now + 1e7 }], work: [{ id: 'w9', date: '2026-01-06', school: 'Alpha', class: 'A1', start: '09:00', end: '10:30' }] });
  assert.equal(imp.json.imported, 2);
});

test('weekly report goes out on Sunday evening once', async () => {
  lineSent.length = 0;
  const sun = Date.parse('2026-01-11T13:00:00Z'); // Sunday 21:00 in Asia/Taipei
  const a = await tick(sun); assert.equal(a.weekly, true);
  const b = await tick(sun + 60000); assert.ok(!b.weekly);
});

test('missed repeating reminder does not flood: rolls to next future time, one message, no double-send race', async () => {
  lineSent.length = 0; store.delete('hub:reminders'); await call('settings-save', { workPromptOn: false });
  const now = Date.now();
  const rep = (await call('reminder-save', { title: 'Old daily', at: now - 5 * 86400e3, repeat: 'daily' })).json.reminder;
  const [a, b] = await Promise.all([tick(now), tick(now)]); // cron + app at the same moment
  assert.equal(a.reminders + b.reminders, 1);
  assert.equal(lineSent.length, 1);
  const st = (await call('state')).json.reminders.find(r => r.id === rep.id);
  assert.ok(st.at > now && st.at <= now + 86400e3, 'next occurrence is within the next day');
  for (let i = 1; i <= 5; i++) await tick(now + i * 60000);
  assert.equal(lineSent.length, 1, 'no repeats on later minutes');
});

test('one follow-up only, 30 min after an unacknowledged reminder', async () => {
  lineSent.length = 0; store.delete('hub:reminders'); const now = Date.now();
  const r = (await call('reminder-save', { title: 'Follow me', at: now - 1000 })).json.reminder;
  await tick(now); assert.equal(lineSent.length, 1);
  assert.equal((await tick(now + 10 * 60000)).followUps || 0, 0);
  assert.equal((await tick(now + 31 * 60000)).followUps, 1); assert.equal(lineSent.length, 2);
  assert.equal((await tick(now + 40 * 60000)).followUps || 0, 0); assert.equal(lineSent.length, 2, 'never more than two messages');
  await call('reminder-delete', { id: r.id });
});
