import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import {
  haversine, bearing, destination, toMGRS, fromMGRS, snapToMGRS, parseMGRSParts,
  makeProjection, compassPoint, pointInRing, distToSegment, pointSegmentMeters, pathLength,
} from '../js/geo.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);

// ---- MGRS ------------------------------------------------------------------

test('MGRS: published reference vector (0°N 0°E)', () => {
  // GeoTrans/NGA reference: lat 0, lon 0 -> 31N AA 66021 00000
  assert.equal(toMGRS(0, 0, 5), '31N AA 66021 00000');
});

test('MGRS: Norway exception zone (60°N 5°E is zone 32V, not 31V)', () => {
  assert.match(toMGRS(60, 5, 4), /^32V /);
});

test('MGRS: Palmer Park, Colorado Springs is in 13S', () => {
  const s = toMGRS(38.8685, -104.7518, 4);
  assert.match(s, /^13S [A-Z]{2} \d{4} \d{4}$/);
});

test('MGRS: 8-digit output is 4+4 digits, and formats with spaces', () => {
  const p = parseMGRSParts(toMGRS(38.8685, -104.7518, 4));
  assert.equal(p.easting.length, 4);
  assert.equal(p.northing.length, 4);
});

test('MGRS: digits agree with an independent UTM calc (proj4) — N and S hemisphere', () => {
  const cases = [
    { lat: 38.8685, lon: -104.7518, zone: 13, south: false },
    { lat: 38.7312, lon: -105.1544, zone: 13, south: false }, // Cripple Creek area
    { lat: 38.7081, lon: -105.2, zone: 13, south: false },
    { lat: -33.8568, lon: 151.2153, zone: 56, south: true }, // Sydney
    { lat: 47.6, lon: -122.3, zone: 10, south: false },
  ];
  for (const c of cases) {
    const def = `+proj=utm +zone=${c.zone}${c.south ? ' +south' : ''} +datum=WGS84 +units=m`;
    const [e, n] = proj4('EPSG:4326', def, [c.lon, c.lat]);
    const p = parseMGRSParts(toMGRS(c.lat, c.lon, 4));
    const e4 = String(Math.floor((e % 100000) / 10)).padStart(4, '0');
    const n4 = String(Math.floor((n % 100000) / 10)).padStart(4, '0');
    assert.equal(p.easting, e4, `easting for ${c.lat},${c.lon}`);
    assert.equal(p.northing, n4, `northing for ${c.lat},${c.lon}`);
    assert.equal(parseInt(p.gzd, 10), c.zone);
  }
});

test('MGRS: fromMGRS(toMGRS(p)) lands within half a cell diagonal (≈7.1 m @ 8-digit)', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let i = 0; i < 500; i++) {
    const p = { lat: 37 + rnd() * 3, lon: -108 + rnd() * 6 }; // all of 12S/13S/CO-ish
    const back = fromMGRS(toMGRS(p.lat, p.lon, 4));
    assert.ok(haversine(p, back) < 7.2, `roundtrip ${JSON.stringify(p)} -> ${haversine(p, back)}`);
  }
});

test('MGRS: 1 m precision round trip is within ~0.8 m', () => {
  const p = { lat: 38.8685, lon: -104.7518 };
  assert.ok(haversine(p, fromMGRS(toMGRS(p.lat, p.lon, 5))) < 0.8);
});

test('MGRS: known string -> coordinates -> same string', () => {
  const s = '13S ED 2153 0221';
  const p = fromMGRS(s);
  assert.equal(toMGRS(p.lat, p.lon, 4), s);
});

test('MGRS: parser tolerates case, spacing, and rejects junk', () => {
  assert.deepEqual(fromMGRS('13s ed 2153 0221'), fromMGRS('13SED21530221'));
  assert.throws(() => fromMGRS('hello'));
  assert.throws(() => fromMGRS('13S ED 215 0221')); // odd digit count
  assert.throws(() => fromMGRS('13S II 2153 0221')); // I is not a valid 100 km letter
});

test('MGRS: snapToMGRS is idempotent and keeps plotted == true location', () => {
  const p = { lat: 38.8701234, lon: -104.7490123 };
  const s1 = snapToMGRS(p);
  const s2 = snapToMGRS(s1);
  assert.ok(haversine(s1, s2) < 0.01);
  assert.equal(toMGRS(s1.lat, s1.lon, 4), toMGRS(p.lat, p.lon, 4));
  assert.ok(haversine(p, s1) < 7.2);
});

// ---- distance ----------------------------------------------------------------

test('haversine: zero, symmetry, one degree of latitude', () => {
  const a = { lat: 38.8, lon: -104.8 };
  assert.equal(haversine(a, a), 0);
  const b = { lat: 38.9, lon: -104.7 };
  near(haversine(a, b), haversine(b, a), 1e-6);
  near(haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 111195, 5);
});

test('haversine: known city pairs', () => {
  near(haversine({ lat: 48.8566, lon: 2.3522 }, { lat: 51.5074, lon: -0.1278 }), 343_500, 1500); // Paris–London
  near(haversine({ lat: 40.7128, lon: -74.006 }, { lat: 34.0522, lon: -118.2437 }), 3_936_000, 5000); // NYC–LA
});

test('destination/bearing are consistent with haversine', () => {
  const a = { lat: 38.8685, lon: -104.7518 };
  for (const brg of [0, 45, 90, 181, 270, 333]) {
    const b = destination(a, brg, 1234);
    near(haversine(a, b), 1234, 0.01);
    near(((bearing(a, b) - brg + 540) % 360) - 180, 0, 0.01);
  }
});

test('pathLength sums legs', () => {
  const a = { lat: 38.8, lon: -104.8 };
  const b = destination(a, 90, 1000);
  const c = destination(b, 0, 500);
  near(pathLength([a, b, c]), 1500, 0.01);
});

// ---- planar geometry --------------------------------------------------------

test('projection round-trips and preserves short distances', () => {
  const o = { lat: 38.87, lon: -104.75 };
  const pr = makeProjection(o);
  const q = destination(o, 37, 3000);
  const [x, y] = pr.toXY(q.lat, q.lon);
  near(Math.hypot(x, y), 3000, 5);
  const back = pr.toLL(x, y);
  near(back.lat, q.lat, 1e-9);
  near(back.lon, q.lon, 1e-9);
});

test('pointInRing and distToSegment', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInRing(5, 5, sq), true);
  assert.equal(pointInRing(11, 5, sq), false);
  assert.equal(pointInRing(-1, -1, sq), false);
  near(distToSegment(5, 5, 0, 0, 10, 0).dist, 5, 1e-9);
  near(distToSegment(-3, 4, 0, 0, 10, 0).dist, 5, 1e-9); // clamps to the endpoint
  near(distToSegment(5, 5, 0, 0, 10, 0).t, 0.5, 1e-9);
});

test('pointSegmentMeters ~ perpendicular distance in metres', () => {
  const a = { lat: 38.87, lon: -104.76 };
  const b = destination(a, 90, 2000);
  const mid = destination(a, 90, 1000);
  const p = destination(mid, 0, 40);
  near(pointSegmentMeters(p, a, b).dist, 40, 0.1);
});

test('compassPoint names bearings', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(47), 'NE');
  assert.equal(compassPoint(90), 'E');
  assert.equal(compassPoint(181), 'S');
  assert.equal(compassPoint(275), 'W');
  assert.equal(compassPoint(-10), 'N');
});
