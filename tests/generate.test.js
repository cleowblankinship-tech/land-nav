import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPool, generateCourse, regeneratePoint, courseLength, mulberry32 } from '../js/generate.js';
import { makeProjection, destination, haversine, toMGRS } from '../js/geo.js';

const start = { lat: 38.8685, lon: -104.7518 };
const proj = makeProjection(start);
// a ~4 km x 3 km box around the start
const box = (w, h, cx = 0, cy = 0) =>
  [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => proj.toLL(x + cx, y + cy));
const boundary = { rings: [box(4000, 3000)] };

test('pool respects boundary, edge buffer and avoid areas', () => {
  const lake = box(600, 600, 500, 300); // lake square
  const rng = mulberry32(1);
  const { pool, proj: p } = buildPool({
    boundary, start,
    constraints: { avoidAreas: [{ ring: lake, buffer: 10, kind: 'water' }] },
    opts: { edgeBuffer: 30, rng },
  });
  assert.ok(pool.length > 1000);
  for (const c of pool) {
    assert.ok(Math.abs(c.x) <= 2000 - 29 && Math.abs(c.y) <= 1500 - 29, 'inside edge buffer');
    const inLake = c.x > 500 - 300 - 9 && c.x < 500 + 300 + 9 && c.y > 300 - 300 - 9 && c.y < 300 + 300 + 9;
    assert.ok(!inLake, 'not in the lake');
  }
});

test('trail constraints: stays within max and outside min distance of trails', () => {
  const trail = [{ pts: [proj.toLL(-1800, 0), proj.toLL(1800, 0)] }];
  const { pool } = buildPool({
    boundary, start, constraints: { trails: trail },
    opts: { maxTrailDist: 200, minTrailDist: 25, rng: mulberry32(2) },
  });
  assert.ok(pool.length > 100);
  for (const c of pool) {
    if (Math.abs(c.x) > 1800) continue; // beyond the trail's ends distance is to the endpoint
    const d = Math.abs(c.y);
    assert.ok(d <= 200 + 1e-6 && d >= 25 - 1e-6, `trail dist ${d}`);
  }
});

test('generateCourse: hits the target distance, spacing and MGRS-snapped points', () => {
  const rng = mulberry32(42);
  const built = buildPool({ boundary, start, constraints: {}, opts: { rng } });
  const targetM = 8047;
  const r = generateCourse({ ...built, start, n: 5, targetM, minSpacing: 400, endAtStart: true, rng });
  assert.equal(r.points.length, 5);
  assert.ok(r.error < 0.1, `error ${r.error}`);
  const all = [start, ...r.points];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) assert.ok(haversine(all[i], all[j]) >= 399, 'spacing');
  }
  // snapped to the centre of an 8-digit cell: re-encoding is stable
  for (const p of r.points) {
    assert.equal(toMGRS(p.lat, p.lon, 4), toMGRS(p.lat, p.lon, 4));
  }
  assert.ok(Math.abs(courseLength(start, r.points, true) - r.total) < 1e-6);
});

test('generateCourse: open-ended course reports a shorter route when not returning', () => {
  const rng = mulberry32(7);
  const built = buildPool({ boundary, start, constraints: {}, opts: { rng } });
  const r = generateCourse({ ...built, start, n: 4, targetM: 5000, minSpacing: 300, endAtStart: false, rng });
  assert.equal(r.points.length, 4);
  assert.ok(r.error < 0.12);
});

test('generateCourse: impossible request is reported, not hidden', () => {
  const tiny = { rings: [box(300, 300)] };
  const rng = mulberry32(3);
  const built = buildPool({ boundary: tiny, start, constraints: {}, opts: { rng, edgeBuffer: 10 } });
  const r = generateCourse({ ...built, start, n: 5, targetM: 8000, minSpacing: 400, endAtStart: true, rng, tries: 200 });
  assert.equal(r.ok, false);
});

test('regeneratePoint: moves only the chosen point and respects spacing', () => {
  const rng = mulberry32(11);
  const built = buildPool({ boundary, start, constraints: {}, opts: { rng } });
  const r = generateCourse({ ...built, start, n: 5, targetM: 8047, minSpacing: 400, rng });
  const np = regeneratePoint({ ...built, start, points: r.points, index: 2, targetM: 8047, minSpacing: 400, rng });
  assert.ok(np);
  assert.ok(haversine(np, r.points[2]) >= 200);
  for (const [i, p] of r.points.entries()) if (i !== 2) assert.ok(haversine(np, p) >= 399);
  assert.ok(haversine(np, start) >= 399);
});

test('same seed gives the same course', () => {
  const run = () => {
    const rng = mulberry32(99);
    const built = buildPool({ boundary, start, constraints: {}, opts: { rng } });
    return generateCourse({ ...built, start, n: 5, targetM: 8047, minSpacing: 400, rng }).points;
  };
  assert.deepEqual(run(), run());
});

test('check() explains why a spot is rejected; regeneratePoint can add a point', () => {
  const lake = box(600, 600, 500, 300);
  const rng = mulberry32(21);
  const built = buildPool({
    boundary, start,
    constraints: { avoidAreas: [{ ring: lake, buffer: 10, kind: 'water' }] },
    opts: { rng },
  });
  const inLake = proj.toLL(500, 300);
  assert.equal(built.check(inLake.lat, inLake.lon), 'water');
  const outside = proj.toLL(5000, 0);
  assert.equal(built.check(outside.lat, outside.lon), 'outside');
  const ok = proj.toLL(-1000, -800);
  assert.equal(built.check(ok.lat, ok.lon), null);

  const r = generateCourse({ ...built, start, n: 4, targetM: 7000, minSpacing: 400, rng });
  const added = regeneratePoint({ ...built, start, points: r.points, index: 4, targetM: 8000, minSpacing: 400, rng });
  assert.ok(added);
  assert.equal(built.check(added.lat, added.lon), null);
});

test('slope filter removes steep ground', () => {
  // everything east of x=0 is "steep"
  const slopeFn = (lat, lon) => (proj.toXY(lat, lon)[0] > 0 ? 40 : 5);
  const { pool, stats } = buildPool({ boundary, start, constraints: {}, opts: { rng: mulberry32(8), maxSlope: 25, slopeFn } });
  assert.ok(pool.length > 500);
  assert.ok(pool.every((c) => c.x <= 0));
  assert.ok(stats.rejected['steep ground'] > 500);
});
