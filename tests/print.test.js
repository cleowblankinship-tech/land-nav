import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { SCALE, M_PER_MM, PAPER, makeUtm, llToPx, pxToLl, frameSize, planSheets, enToMm, tileLayer, convergence, gridLines } from '../js/print.js';

const utm = makeUtm(proj4, 38.8685, -104.7518);
const near = (a, b, tol, m = '') => assert.ok(Math.abs(a - b) <= tol, `${m} ${a} vs ${b}`);

test('scale constants: 1:25,000 means 25 m per mm and 1 km = 40 mm', () => {
  assert.equal(SCALE, 25000);
  assert.equal(M_PER_MM, 25);
  assert.equal(1000 / M_PER_MM, 40);
});

test('Palmer Park is UTM zone 13 north', () => {
  assert.equal(utm.zone, 13);
  assert.equal(utm.south, false);
});

test('mercator pixel conversions round-trip', () => {
  const [x, y] = llToPx(38.8685, -104.7518, 16);
  const p = pxToLl(x, y, 16);
  near(p.lat, 38.8685, 1e-9);
  near(p.lon, -104.7518, 1e-9);
});

test('frame sizes are multiples of 4 mm and fit the paper', () => {
  for (const paper of [PAPER.letter, PAPER.a4]) {
    for (const o of ['portrait', 'landscape']) {
      const f = frameSize(paper, o);
      assert.equal(f.fw % 4, 0);
      assert.equal(f.fh % 4, 0);
      assert.ok(f.fw + 2 * f.margin + 2 * f.gutter <= f.paperW);
      assert.ok(f.fh + 2 * f.margin + 2 * f.gutter + f.header + f.footer <= f.paperH);
    }
  }
  const f = frameSize(PAPER.letter, 'portrait');
  assert.ok(f.fw >= 180 && f.fh >= 200, `${f.fw}x${f.fh}`);
});

test('gridlines are exactly 40 mm apart and sit on whole kilometres', () => {
  const sheet = { e0: 520000, n0: 4300000, Wm: 4600, Hm: 5300 };
  const e = gridLines(sheet, 'E');
  assert.equal(e.length, 5);
  for (let i = 1; i < e.length; i++) near(e[i].mm - e[i - 1].mm, 40, 1e-9);
  const n = gridLines(sheet, 'N');
  for (let i = 1; i < n.length; i++) near(n[i - 1].mm - n[i].mm, 40, 1e-9); // northing grows upward
  assert.equal(e[0].value % 1000, 0);
});

test('a sheet covers a small area with one page, a big one with overlapping pages', () => {
  const f = frameSize(PAPER.letter, 'portrait');
  const small = planSheets(utm, [38.855, -104.77, 38.88, -104.74], f.fw, f.fh);
  assert.equal(small.sheets.length, 1);
  const big = planSheets(utm, [38.80, -104.90, 38.95, -104.60], f.fw, f.fh);
  assert.ok(big.sheets.length > 1);
  // every corner of the bbox lies inside at least one sheet
  for (const [la, lo] of [[38.80, -104.90], [38.95, -104.60], [38.80, -104.60], [38.95, -104.90]]) {
    const [E, N] = utm.fwd(la, lo);
    assert.ok(big.sheets.some((s) => E >= s.e0 && E <= s.e0 + s.Wm && N >= s.n0 && N <= s.n0 + s.Hm), `corner ${la},${lo}`);
  }
  // neighbours overlap by 1 km
  const a = big.sheets.find((s) => s.col === 0 && s.row === 0), b = big.sheets.find((s) => s.col === 1 && s.row === 0);
  near(a.e0 + a.Wm - b.e0, 1000, 1e-6);
  // reading order: north row first
  assert.equal(big.sheets[0].row, 0);
  assert.ok(big.sheets[0].n0 >= big.sheets.at(-1).n0);
});

test('tile affine reproduces UTM positions to well under a millimetre of paper', () => {
  const f = frameSize(PAPER.letter, 'portrait');
  const { sheets } = planSheets(utm, [38.855, -104.77, 38.88, -104.74], f.fw, f.fh);
  const sheet = sheets[0];
  const layer = tileLayer(utm, sheet, 16);
  // sample points across the sheet: lat/lon -> tile pixel -> mm  must equal exact E,N -> mm
  let worst = 0;
  for (const fx of [0.05, 0.5, 0.95]) {
    for (const fy of [0.05, 0.5, 0.95]) {
      const E = sheet.e0 + sheet.Wm * fx, N = sheet.n0 + sheet.Hm * fy;
      const ll = utm.inv(E, N);
      const [px, py] = llToPx(ll.lat, ll.lon, 16);
      const got = layer.pxToMm(px, py);
      const want = enToMm(sheet, E, N);
      worst = Math.max(worst, Math.hypot(got[0] - want[0], got[1] - want[1]));
    }
  }
  assert.ok(worst < 0.1, `worst paper error ${worst} mm (= ${(worst * 25).toFixed(1)} m on the ground)`);
});

test('tile matrix is mostly scale with a tiny rotation for grid convergence', () => {
  const f = frameSize(PAPER.letter, 'portrait');
  const sheet = planSheets(utm, [38.855, -104.77, 38.88, -104.74], f.fw, f.fh).sheets[0];
  const [a, b, c, d] = tileLayer(utm, sheet, 16).matrix;
  // mm per tile pixel: z16 at 38.9 N is ~1.86 m/px => 0.0744 mm/px => ~0.281 CSS px per tile px
  near(Math.hypot(a, b), 0.281, 0.005);
  near(Math.hypot(c, d), 0.281, 0.005);
  const rot = (Math.atan2(b, a) * 180) / Math.PI;
  assert.ok(Math.abs(rot) < 1.7, `rotation ${rot}`);
});

test('convergence is small and has the right sign either side of the central meridian', () => {
  const east = convergence(utm, 38.87, -104.0), west = convergence(utm, 38.87, -106.0);
  assert.ok(east > 0 && west < 0, `${east} ${west}`);
  near(convergence(utm, 38.87, -105.0), 0, 0.01);
  near(Math.abs(east), 1 * Math.sin((38.87 * Math.PI) / 180) , 0.05); // gamma ~ dLon * sin(lat)
});
