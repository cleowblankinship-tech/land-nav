// Check-in maths: average several GPS fixes, then compare to the unfound points.
// IMPORTANT: nothing user-visible may leak distance or direction to a point.
import { haversine, makeProjection } from './geo.js';

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * fixes: [{lat, lon, acc}] -> {lat, lon, acc, n}
 * Inverse-variance weighted mean; fixes far worse than the median are dropped.
 * `acc` is the honest estimate: the larger of the statistical error of the mean
 * and the spread of the fixes themselves (which catches a wandering fix).
 */
export function averageFixes(fixes) {
  const good = fixes.filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon));
  if (!good.length) return null;
  const accs = good.map((f) => Math.max(f.acc ?? 50, 1));
  const lim = Math.max(3 * median(accs), 10);
  const kept = good.filter((f, i) => accs[i] <= lim);
  const use = kept.length ? kept : good;
  const w = use.map((f) => 1 / Math.max(f.acc ?? 50, 1) ** 2);
  const W = w.reduce((a, b) => a + b, 0);
  const lat = use.reduce((s, f, i) => s + f.lat * w[i], 0) / W;
  const lon = use.reduce((s, f, i) => s + f.lon * w[i], 0) / W;
  const proj = makeProjection({ lat, lon });
  const spread = Math.sqrt(
    use.reduce((s, f) => {
      const [x, y] = proj.toXY(f.lat, f.lon);
      return s + x * x + y * y;
    }, 0) / use.length,
  );
  const acc = Math.max(Math.sqrt(1 / W), spread, Math.min(...use.map((f) => Math.max(f.acc ?? 50, 1))) * 0.9);
  return { lat, lon, acc, n: use.length };
}

/**
 * pos: {lat, lon, acc}; pts: [{id, lat, lon}]; found: {id: ...}
 * -> { status: 'hit'|'already'|'miss'|'poor', pt?, nearestM }
 *  hit      within radius of an unfound point (counts even if accuracy is poor)
 *  already  within radius of a point you already found
 *  poor     no point here, but GPS accuracy is worse than the radius, so it's
 *           inconclusive (not counted as a miss)
 *  miss     no point here
 * nearestM is for the post-run review only; never show it during the run.
 */
export function evaluateCheckin(pos, pts, found, radius) {
  let hit = null, hitD = Infinity, done = null, nearest = Infinity;
  for (const p of pts) {
    const d = haversine(pos, p);
    if (d < nearest) nearest = d;
    if (d > radius) continue;
    if (found[p.id]) {
      if (!done) done = p;
    } else if (d < hitD) {
      hit = p;
      hitD = d;
    }
  }
  if (hit) return { status: 'hit', pt: hit, nearestM: hitD };
  if (done) return { status: 'already', pt: done, nearestM: nearest };
  if (pos.acc > radius) return { status: 'poor', nearestM: nearest };
  return { status: 'miss', nearestM: nearest };
}
