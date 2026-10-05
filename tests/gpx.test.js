import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGPX, buildGPX, scoreTrack } from '../js/gpx.js';
import { destination } from '../js/geo.js';

const P = { lat: 38.8685, lon: -104.7518 };
const T0 = Date.parse('2026-10-10T14:00:00Z');

test('parseGPX reads Strava/Garmin style files (attr order, times, segments)', () => {
  const xml = `<?xml version="1.0"?><gpx><trk><name>Morning &amp; Run</name><trkseg>
    <trkpt lon="-104.75" lat="38.86"><ele>1900</ele><time>2026-10-10T14:00:00Z</time></trkpt>
    <trkpt lat="38.861" lon="-104.751"><time>2026-10-10T14:00:10Z</time></trkpt>
    </trkseg><trkseg><trkpt lat="38.9" lon="-104.8"/></trkseg></trk></gpx>`;
  const g = parseGPX(xml);
  assert.equal(g.name, 'Morning & Run');
  assert.equal(g.points.length, 3);
  assert.equal(g.points[0].lat, 38.86);
  assert.equal(g.points[0].t, T0);
  assert.equal(g.points[2].t, null);
  assert.equal(g.points[2].seg, 1);
});

test('buildGPX output parses back', () => {
  const track = [{ ...P, t: T0 }, { ...destination(P, 90, 100), t: T0 + 60000 }];
  const g = parseGPX(buildGPX(track, 'x'));
  assert.equal(g.points.length, 2);
  assert.ok(Math.abs(g.points[1].t - (T0 + 60000)) < 1);
  assert.ok(Math.abs(g.points[0].lat - P.lat) < 1e-6);
});

test('scoreTrack: pass-by within radius, miss outside, interpolated time', () => {
  const pt = { id: 'AA11', ...P };
  const far = { id: 'BB22', ...destination(P, 0, 400) };
  // walk west -> east, passing 15 m south of pt; sparse samples 200 m apart
  const a = destination(destination(P, 270, 100), 180, 15);
  const b = destination(destination(P, 90, 100), 180, 15);
  const track = [{ ...a, t: T0, seg: 0 }, { ...b, t: T0 + 100000, seg: 0 }];
  const [r1, r2] = scoreTrack(track, [pt, far], 30);
  assert.equal(r1.hit, true);
  assert.ok(Math.abs(r1.minDist - 15) < 0.5, `minDist ${r1.minDist}`);
  // enters the 30 m circle ~ 26 m before closest approach => ~ 100 - 26 m of 200 m => ~37 s
  assert.ok(Math.abs(r1.t - (T0 + 37000)) < 3000, `t ${(r1.t - T0) / 1000}`);
  assert.equal(r2.hit, false);
  assert.ok(r2.minDist > 300);
});

test('scoreTrack: does not bridge gaps between separate segments', () => {
  const pt = { id: 'AA11', ...P };
  const a = destination(P, 270, 200), b = destination(P, 90, 200);
  const track = [{ ...a, t: null, seg: 0 }, { ...b, t: null, seg: 1 }];
  assert.equal(scoreTrack(track, [pt], 30)[0].hit, false);
});

test('scoreTrack: a single fix inside the radius counts', () => {
  const pt = { id: 'AA11', ...P };
  const track = [{ ...destination(P, 0, 10), t: T0, seg: 0 }];
  const r = scoreTrack(track, [pt], 30)[0];
  assert.equal(r.hit, true);
  assert.equal(r.t, T0);
});
