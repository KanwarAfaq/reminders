import { api, getKey, setKey } from './api.js';
import { S, esc, ymd, hm, toLocalInput, durationMin, fmtHours, fmtWhen, rel, report, rangePreset, toCSV } from './store.js';

const $ = (s, r = document) => r.querySelector(s);
let cfg = null, ui = { tab: 'log', range: 'month', from: '', to: '', editing: null };
export const toast = t => { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.append(d); setTimeout(() => d.remove(), 2600); };
const isNative = () => !!window.Capacitor?.isNativePlatform?.();

/* ---------- data ---------- */
export async function loadState() {
  const j = await api('state');
  S.reminders = j.reminders; S.work = j.work; S.settings = j.settings; S.line = j.line; S.loaded = true;
  syncNative();
  return j;
}
export const hasKey = () => !!getKey();

async function syncNative() {
  if (!isNative()) return;
  try {
    const { LocalNotifications: L } = await import('@capacitor/local-notifications');
    if ((await L.requestPermissions()).display !== 'granted') return;
    const pend = await L.getPending(); if (pend.notifications.length) await L.cancel({ notifications: pend.notifications });
    const hash = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7) & 0x7fffffff;
    const items = S.reminders.filter(r => !r.done && !r.sent && r.at > Date.now()).slice(0, 60)
      .map(r => ({ id: hash(r.id), title: '⏰ ' + r.title, body: r.detail || 'Reminder', schedule: { at: new Date(r.at), allowWhileIdle: true }, extra: { id: r.id } }));
    if (items.length) await L.schedule({ notifications: items });
  } catch { /* plugin unavailable */ }
}

/* ---------- unlock gate ---------- */
async function gate(el) {
  try { cfg ||= await api('config'); } catch { el.innerHTML = box('Offline', '<p>Can\'t reach the server. Check your connection.</p>'); return false; }
  if (!cfg.storage) {
    el.innerHTML = box('One-time setup needed', `<p>Reminders and work hours need a small database.</p><ol><li>Vercel → project <b>this Vercel project</b> → <b>Storage</b> → add <b>Upstash Redis</b> and connect it.</li><li>Redeploy, then reopen this page.</li></ol>`);
    return false;
  }
  if (!cfg.pinSet) { pinForm(el, true); return false; }
  if (!getKey()) { pinForm(el, false); return false; }
  try { await loadState(); return true; } catch (e) {
    if (e.status === 401 || e.status === 429) { setKey(''); pinForm(el, false, e.message); return false; }
    el.innerHTML = box('Error', `<p>${esc(e.message)}</p>`); return false;
  }
}
const box = (t, b) => `<div class="wrap narrow"><div class="panel"><h2>${t}</h2>${b}</div></div>`;
function pinForm(el, create, msg = '') {
  el.innerHTML = box(create ? 'Create your PIN' : 'Enter your PIN', `<p class="mut">${create ? 'This PIN protects your reminders and hours. Choose at least 4 characters.' : 'Enter the PIN to unlock.'}</p>
  ${msg ? `<p class="err">${esc(msg)}</p>` : ''}<form id="pf"><input class="in" id="pin" type="password" autocomplete="${create ? 'new-password' : 'current-password'}" placeholder="PIN" minlength="4" required autofocus><button class="btn pri" style="margin-top:12px;width:100%;justify-content:center">${create ? 'Save PIN' : 'Unlock'}</button></form>`);
  $('#pf').onsubmit = async e => {
    e.preventDefault(); const pin = $('#pin').value;
    try { if (create) { await api('setup-pin', { pin }); cfg.pinSet = true; } setKey(pin); await mount(el, location.hash); }
    catch (err) { pinForm(el, create, err.message); }
  };
}

/* ---------- reminders ---------- */
function reminderRow(r) {
  const state = r.done ? 'Done' : r.sent ? 'Sent' : r.at < Date.now() ? 'Due' : 'Upcoming';
  return `<li class="item ${r.done ? 'dim' : ''}"><div class="grow"><b>${esc(r.title)}</b>${r.detail ? `<div class="mut">${esc(r.detail)}</div>` : ''}
    <div class="mut sm">${fmtWhen(r.at)} · ${rel(r.at)}${r.repeat !== 'none' ? ` · repeats ${r.repeat}` : ''} · <span class="st ${state}">${state}</span></div></div>
    <div class="acts"><button class="mini" data-act="r-done" data-id="${r.id}" title="Mark done">✓</button><button class="mini" data-act="r-edit" data-id="${r.id}" title="Edit">✎</button><button class="mini" data-act="r-del" data-id="${r.id}" title="Delete">🗑</button></div></li>`;
}
function remindersPage() {
  const e = ui.editing ? S.reminders.find(r => r.id === ui.editing) : null;
  const def = e?.at ?? (Math.ceil((Date.now() + 3600e3) / 900e3) * 900e3);
  const up = S.reminders.filter(r => !r.done && !r.sent), past = S.reminders.filter(r => r.done || r.sent).reverse();
  return `<div class="wrap narrow"><h1 class="pg">⏰ Reminders</h1>
  <form class="panel" id="rf"><h2>${e ? 'Edit reminder' : 'New reminder'}</h2>
    <label>Title<input class="in" name="title" maxlength="120" required value="${esc(e?.title)}" placeholder="e.g. Parent meeting"></label>
    <label>Details<textarea class="in" name="detail" rows="3" maxlength="1000" placeholder="Optional notes">${esc(e?.detail)}</textarea></label>
    <div class="two"><label>Date &amp; time<input class="in" type="datetime-local" name="at" required value="${toLocalInput(def)}"></label>
    <label>Repeat<select class="in" name="repeat">${['none', 'daily', 'weekly'].map(v => `<option value="${v}" ${e?.repeat === v ? 'selected' : ''}>${v === 'none' ? 'Does not repeat' : v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></label></div>
    <p class="mut sm">You'll get an in-app alert with vibration, a phone notification${S.line ? ' and a LINE card' : ''} at that time.</p>
    <div class="row"><button class="btn pri">${e ? 'Save changes' : 'Add reminder'}</button>${e ? '<button type="button" class="btn" data-act="r-cancel">Cancel</button>' : ''}</div></form>
  <h2 class="sec">Upcoming (${up.length})</h2><ul class="list">${up.map(reminderRow).join('') || '<li class="empty">Nothing scheduled.</li>'}</ul>
  ${past.length ? `<h2 class="sec">Past</h2><ul class="list">${past.slice(0, 20).map(reminderRow).join('')}</ul>` : ''}</div>`;
}

/* ---------- work hours ---------- */
const opts = (list, sel) => list.map(x => `<option ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('') + '<option value="__new">＋ Add new…</option>';
function entryRow(e, del = true) {
  return `<li class="item"><div class="grow"><b>${esc(e.school)}</b> · ${esc(e.class)}<div class="mut sm">${e.date} · ${e.start}–${e.end}${e.note ? ' · ' + esc(e.note) : ''}</div></div><b class="hrs">${fmtHours(e.minutes)}</b>${del ? `<div class="acts"><button class="mini" data-act="w-del" data-id="${e.id}" title="Delete">🗑</button></div>` : ''}</li>`;
}
function logTab(prefill = {}) {
  const today = ymd(new Date()), set = S.settings, todays = S.work.filter(w => w.date === today).sort((a, b) => a.start.localeCompare(b.start));
  const sum = todays.reduce((a, e) => a + e.minutes, 0);
  return `<form class="panel" id="wf"><h2>Log working hours</h2>
    <label>Date<input class="in" type="date" name="date" value="${prefill.date || today}" required></label>
    <div class="two"><label>School<select class="in" name="school" id="sch">${opts(set.schools, prefill.school)}</select><input class="in ${set.schools.length || prefill.school ? 'hide' : ''}" id="schNew" placeholder="Type school name" maxlength="80" ${set.schools.length ? '' : 'required'} style="margin-top:8px"></label>
    <label>Class<select class="in" name="class" id="cls">${opts(set.classes, prefill.class)}</select><input class="in ${set.classes.length || prefill.class ? 'hide' : ''}" id="clsNew" placeholder="Type class name" maxlength="80" ${set.classes.length ? '' : 'required'} style="margin-top:8px"></label></div>
    <div class="two"><label>From<input class="in" type="time" name="start" value="${prefill.start || '16:30'}" required></label><label>To<input class="in" type="time" name="end" value="${prefill.end || '18:30'}" required></label></div>
    <div class="dur">Duration: <b id="dur">–</b></div>
    <label>Note (optional)<input class="in" name="note" maxlength="300"></label>
    <button class="btn pri">Save</button></form>
  <h2 class="sec">Today · ${fmtHours(sum)}</h2><ul class="list">${todays.map(e => entryRow(e)).join('') || '<li class="empty">Nothing logged today yet.</li>'}</ul>`;
}
function detailTab() {
  if (!ui.from) [ui.from, ui.to] = rangePreset(ui.range);
  const r = report(S.work, ui.from, ui.to);
  const bars = (arr, n = 8) => arr.slice(0, n).map(x => `<div class="bar"><div class="bl"><span>${esc(x.name)}</span><b>${x.label}</b></div><div class="bt"><i style="width:${Math.max(x.pct, 3)}%"></i></div></div>`).join('') || '<div class="empty">No data</div>';
  return `<div class="panel"><h2>Details</h2>
    <div class="chips">${[['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['last', 'Last month'], ['all', 'All time']].map(([k, l]) => `<button class="chip ${ui.range === k ? 'on' : ''}" data-act="range" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="two" style="margin-top:12px"><label>From<input class="in" type="date" id="from" value="${ui.from}"></label><label>To<input class="in" type="date" id="to" value="${ui.to}"></label></div></div>
  <div class="stats"><div class="stat big"><b>${r.label}</b><span>${r.hours} hours total · ${r.from} → ${r.to}</span></div><div class="stat"><b>${r.sessions}</b><span>Sessions</span></div><div class="stat"><b>${r.byDay.length}</b><span>Days worked</span></div></div>
  <div class="panel"><h2>By school</h2>${bars(r.bySchool)}</div><div class="panel"><h2>By class</h2>${bars(r.byClass)}</div>
  <div class="panel"><h2>By day</h2>${bars(r.byDay, 31)}</div>
  <div class="row"><button class="btn pri" data-act="w-line">Send to LINE</button><button class="btn" data-act="w-csv">Copy CSV</button></div>
  <h2 class="sec">All entries (${r.sessions})</h2><ul class="list">${r.entries.map(e => entryRow(e)).join('') || '<li class="empty">No entries in this range.</li>'}</ul>`;
}
function workPage() {
  const q = new URLSearchParams((location.hash.split('?')[1]) || '');
  if (q.get('add')) ui.tab = 'log';
  return `<div class="wrap narrow"><h1 class="pg">📝 Work Hours</h1><div class="seg"><button class="${ui.tab === 'log' ? 'on' : ''}" data-act="tab" data-v="log">Log hours</button><button class="${ui.tab === 'detail' ? 'on' : ''}" data-act="tab" data-v="detail">Details</button></div>${ui.tab === 'log' ? logTab() : detailTab()}</div>`;
}

/* ---------- settings ---------- */
const chipList = (arr, kind) => arr.map(x => `<span class="tagx">${esc(x)}<button data-act="rm-${kind}" data-v="${esc(x)}" aria-label="Remove">×</button></span>`).join('') || '<span class="mut sm">None yet — they are added when you log hours.</span>';
function settingsPage() {
  const s = S.settings, perm = 'Notification' in window ? Notification.permission : 'unsupported';
  return `<div class="wrap narrow"><h1 class="pg">⚙️ Settings</h1>
  <div class="panel"><h2>Evening check-in</h2><label class="sw"><input type="checkbox" id="pOn" ${s.workPromptOn ? 'checked' : ''}> Ask me to log working hours every evening</label>
    <label>Time<input class="in" type="time" id="pTime" value="${s.workPromptTime}"></label><label>Time zone<input class="in" id="tz" value="${esc(s.tz)}"></label>
    <button class="btn pri" data-act="save-set">Save</button></div>
  <div class="panel"><h2>Notifications</h2><p class="mut">Status: <b>${perm === 'granted' ? 'enabled' : perm === 'denied' ? 'blocked in browser settings' : perm === 'unsupported' ? 'not supported here' : 'not enabled'}</b>. LINE: <b>${S.line ? 'connected' : 'not connected'}</b>.</p>
    ${isNative() ? '<p class="mut sm">The Android app schedules reminders on your phone, so they ring even when it\'s closed.</p>' : '<p class="mut sm">On iPhone, first Add this app to your Home Screen, then enable notifications.</p>'}
    <div class="row"><button class="btn pri" data-act="enable-push">Enable notifications</button><button class="btn" data-act="test">Send test (phone + LINE)</button></div>
    ${S.line ? '' : '<p class="mut sm" style="margin-top:12px">To connect LINE, add <code>LINE_CHANNEL_ACCESS_TOKEN</code> and <code>LINE_USER_ID</code> in Vercel → this Vercel project → Settings → Environment Variables, then redeploy.</p>'}</div>
  <div class="panel"><h2>Schools</h2><div class="tagrow">${chipList(s.schools, 'school')}</div><h2 style="margin-top:18px">Classes</h2><div class="tagrow">${chipList(s.classes, 'class')}</div></div>
  <div class="panel"><button class="btn" data-act="lock">Lock (forget PIN on this device)</button></div></div>`;
}

/* ---------- push ---------- */
const b64 = s => { const p = '='.repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); };
async function enablePush() {
  if (isNative()) { await syncNative(); toast('Phone alarms enabled'); return; }
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return toast('Notifications are not supported on this browser');
  if (await Notification.requestPermission() !== 'granted') return toast('Permission was not granted');
  cfg ||= await api('config');
  if (!cfg.vapid) return toast('Server push key missing');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(cfg.vapid) });
  await api('push-subscribe', { subscription: sub.toJSON() }); toast('Notifications enabled');
}

/* ---------- events ---------- */
const refresh = () => mount($('#view'), location.hash);
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]'); if (!t) return; const a = t.dataset.act, id = t.dataset.id;
  try {
    if (a === 'r-del' && confirm('Delete this reminder?')) { await api('reminder-delete', { id }); await loadState(); refresh(); }
    else if (a === 'r-done') { await api('reminder-done', { id }); await loadState(); refresh(); }
    else if (a === 'r-edit') { ui.editing = id; refresh(); scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (a === 'r-cancel') { ui.editing = null; refresh(); }
    else if (a === 'tab') { ui.tab = t.dataset.v; history.replaceState(null, '', '#/work'); refresh(); }
    else if (a === 'range') { ui.range = t.dataset.v; [ui.from, ui.to] = rangePreset(ui.range); refresh(); }
    else if (a === 'w-del' && confirm('Delete this entry?')) { await api('work-delete', { id }); await loadState(); refresh(); }
    else if (a === 'w-line') { const r = await api('work-report', { from: ui.from, to: ui.to, line: true }); toast(r.ok ? 'Sent to LINE' : (r.error || 'LINE not connected')); }
    else if (a === 'w-csv') { await navigator.clipboard.writeText(toCSV(report(S.work, ui.from, ui.to).entries)); toast('CSV copied'); }
    else if (a === 'save-set') {
      const j = await api('settings-save', { workPromptOn: $('#pOn').checked, workPromptTime: $('#pTime').value, tz: $('#tz').value.trim() }); S.settings = j.settings; toast('Saved');
    }
    else if (a === 'rm-school' || a === 'rm-class') {
      const k = a === 'rm-school' ? 'schools' : 'classes', j = await api('settings-save', { [k]: S.settings[k].filter(x => x !== t.dataset.v) }); S.settings = j.settings; refresh();
    }
    else if (a === 'enable-push') await enablePush();
    else if (a === 'test') { const r = await api('test'); toast(`Phone: ${r.pushed} · LINE: ${r.line.ok ? 'sent' : r.line.error}`); }
    else if (a === 'lock') { setKey(''); location.hash = '#/'; }
  } catch (err) { toast(err.message); }
});
document.addEventListener('submit', async e => {
  if (e.target.id === 'rf') {
    e.preventDefault(); const f = new FormData(e.target);
    try {
      await api('reminder-save', { id: ui.editing || undefined, title: f.get('title'), detail: f.get('detail'), at: new Date(f.get('at')).getTime(), repeat: f.get('repeat') });
      ui.editing = null; await loadState(); toast('Reminder saved'); refresh();
    } catch (err) { toast(err.message); }
  } else if (e.target.id === 'wf') {
    e.preventDefault(); const f = new FormData(e.target);
    const school = f.get('school') === '__new' ? $('#schNew').value : f.get('school'), cls = f.get('class') === '__new' ? $('#clsNew').value : f.get('class');
    try {
      await api('work-save', { date: f.get('date'), school, class: cls, start: f.get('start'), end: f.get('end'), note: f.get('note') });
      await loadState(); toast(`Saved · ${fmtHours(durationMin(f.get('start'), f.get('end')))}`); history.replaceState(null, '', '#/work'); refresh();
    } catch (err) { toast(err.message); }
  }
});
document.addEventListener('change', e => {
  if (e.target.id === 'sch' || e.target.id === 'cls') { const n = $(e.target.id === 'sch' ? '#schNew' : '#clsNew'); n.classList.toggle('hide', e.target.value !== '__new'); n.required = e.target.value === '__new'; }
  if (e.target.id === 'from' || e.target.id === 'to') { ui.from = $('#from').value; ui.to = $('#to').value; ui.range = ''; if (ui.from && ui.to && ui.from <= ui.to) refresh(); }
  durUpdate();
});
document.addEventListener('input', durUpdate);
function durUpdate() {
  const f = $('#wf'); if (!f || !$('#dur')) return;
  const s = f.start.value, en = f.end.value; $('#dur').textContent = s && en ? fmtHours(durationMin(s, en)) + ` (${(durationMin(s, en) / 60).toFixed(2)} h)` : '–';
}

/* ---------- mount ---------- */
export async function mount(root, hash) {
  const page = (hash.match(/^#\/(reminders|work|settings)/) || [])[1];
  root.innerHTML = '<div class="wrap narrow"><div class="empty">Loading…</div></div>';
  root.id = 'view';
  if (!(await gate(root))) return;
  root.innerHTML = page === 'reminders' ? remindersPage() : page === 'work' ? workPage() : settingsPage();
  durUpdate();
}

/* ---------- in-app alarms (while the app is open) ---------- */
const alerted = new Set(JSON.parse(sessionStorage.getItem('hub.alerted') || '[]'));
export function startWatcher() {
  const check = async () => {
    if (!getKey() || document.hidden && false) return;
    try {
      if (!S.loaded || Date.now() - (S._t || 0) > 60000) { await loadState(); S._t = Date.now(); api('tick').catch(() => {}); }
    } catch { return; }
    const now = Date.now();
    for (const r of S.reminders) if (!r.done && !r.sent && r.at <= now && now - r.at < 6 * 3600e3 && !alerted.has(r.id + r.at)) { alerted.add(r.id + r.at); sessionStorage.setItem('hub.alerted', JSON.stringify([...alerted])); alarm(r); }
    const { workPromptOn, workPromptTime } = S.settings, today = ymd(new Date());
    if (workPromptOn && hm(new Date()) >= workPromptTime && localStorage.getItem('hub.promptDay') !== today) {
      localStorage.setItem('hub.promptDay', today);
      if (!S.work.some(w => w.date === today)) promptWork();
    }
  };
  check(); setInterval(check, 15000);
}
function ring() { try { navigator.vibrate?.([300, 150, 300, 150, 600]); } catch { /* unsupported */ } }
function alarm(r) {
  ring();
  const d = document.createElement('dialog'); d.className = 'alarm';
  d.innerHTML = `<h3>⏰ ${esc(r.title)}</h3>${r.detail ? `<p>${esc(r.detail)}</p>` : ''}<p class="mut">${fmtWhen(r.at)}</p><div class="row"><button class="btn pri" data-x="done">Mark done</button><button class="btn" data-x="close">Dismiss</button></div>`;
  document.body.append(d); d.showModal();
  d.onclick = async ev => { const x = ev.target.dataset.x; if (!x) return; if (x === 'done') { try { await api('reminder-done', { id: r.id }); await loadState(); } catch { /* ignore */ } } d.close(); d.remove(); };
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) navigator.serviceWorker?.ready.then(reg => reg.showNotification('⏰ ' + r.title, { body: r.detail || '', vibrate: [300, 150, 300], tag: r.id }));
}
function promptWork() {
  ring();
  const d = document.createElement('dialog'); d.className = 'alarm';
  d.innerHTML = '<h3>📝 Log today\'s working hours</h3><p>Which school and class did you teach, and for how long?</p><div class="row"><button class="btn pri" data-x="go">Fill now</button><button class="btn" data-x="close">Later</button></div>';
  document.body.append(d); d.showModal();
  d.onclick = ev => { const x = ev.target.dataset.x; if (!x) return; if (x === 'go') location.hash = '#/work?add=1'; d.close(); d.remove(); };
}
