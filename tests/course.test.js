import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCourse, encodeCourse, decodeCourse, makePointIds, fmtDuration, mgrs8 } from '../js/course.js';
import { mulberry32 } from '../js/generate.js';

const sample = () =>
  makeCourse({
    name: 'Palmer Park test',
    start: { lat: 38.868512345, lon: -104.751812345 },
    pts: [{ lat: 38.87, lon: -104.74 }, { lat: 38.86, lon: -104.76 }],
    ids: ['KT47', 'BM12'], radius: 30, limitMin: 240, endAtStart: true, need: 4,
  });

test('course code round-trips and hides plain coordinates', () => {
  const c = sample();
  const code = encodeCourse(c);
  assert.doesNotMatch(code, /38\.8|104\.7/);
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  const d = decodeCourse(code);
  assert.deepEqual(d.pts, c.pts);
  assert.deepEqual(d.start, c.start);
  assert.equal(d.radius, 30);
  assert.equal(d.need, 2); // clamped to the number of points
  assert.equal(d.endAtStart, true);
});

test('decodeCourse accepts full URLs and rejects garbage', () => {
  const code = encodeCourse(sample());
  assert.equal(decodeCourse('https://x.github.io/land-nav/run.html#' + code).pts.length, 2);
  assert.equal(decodeCourse('#c=' + code).pts.length, 2);
  assert.throws(() => decodeCourse('not-a-code'));
  assert.throws(() => decodeCourse(''));
});

test('point IDs are unique, random-looking, and seedable', () => {
  const ids = makePointIds(5, mulberry32(5));
  assert.equal(new Set(ids).size, 5);
  for (const id of ids) assert.match(id, /^[A-Z]{2}\d{2}$/);
  assert.deepEqual(makePointIds(5, mulberry32(5)), ids);
});

test('formatting helpers', () => {
  assert.equal(fmtDuration(65), '1:05');
  assert.equal(fmtDuration(3725), '1:02:05');
  assert.equal(fmtDuration(-30), '-0:30');
  assert.match(mgrs8({ lat: 38.8685, lon: -104.7518 }), /^13S [A-Z]{2} \d{4} \d{4}$/);
});
