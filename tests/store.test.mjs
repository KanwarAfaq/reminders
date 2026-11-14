import test from 'node:test';
import assert from 'node:assert/strict';
import { report, durationMin, fmtHours, rangePreset, toCSV, rel } from '../src/store.js';

test('duration and labels', () => {
  assert.equal(durationMin('16:30', '18:30'), 120); assert.equal(durationMin('22:00', '01:00'), 180);
  assert.equal(fmtHours(150), '2h 30m'); assert.equal(fmtHours(120), '2h');
});
test('report totals, grouping and range filter', () => {
  const e = (date, school, cls, minutes) => ({ date, school, class: cls, classKey: `${school} · ${cls}`, start: '09:00', end: '10:00', minutes });
  const r = report([e('2026-11-10', 'A', '5', 120), e('2026-11-10', 'B', '6', 90), e('2026-11-12', 'A', '5', 60), e('2026-12-01', 'A', '5', 600)], '2026-11-10', '2026-11-30');
  assert.equal(r.total, 270); assert.equal(r.label, '4h 30m'); assert.equal(r.sessions, 3); assert.equal(r.byDay.length, 2);
  assert.equal(r.bySchool[0].name, 'A'); assert.equal(r.bySchool[0].pct, 67);
});
test('presets and csv and relative time', () => {
  const [a, b] = rangePreset('week'); assert.ok(a <= b);
  assert.match(toCSV([{ date: '2026-11-10', school: 'A "x"', class: '5', start: '09:00', end: '10:00', minutes: 60 }]), /"A ""x"""/);
  assert.equal(rel(Date.now() + 3600e3 * 2), 'in 2 h');
});
