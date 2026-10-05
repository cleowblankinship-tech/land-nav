// Course point generation. Pure functions (no DOM, no network) so it can be
// unit-tested. Works in a local metre grid around the start point.
import {
  makeProjection, pointInRing, distToSegment, ringBBox, snapToMGRS, pathLength,
} from './geo.js';

/** Small seeded PRNG so a course can be reproduced from a seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform-grid spatial hash. Items are inserted by bbox, queried by point/radius. */
class GridIndex {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
  }
  _key(i, j) {
    return i * 73856093 ^ j * 19349663;
  }
  insert(bbox, item) {
    const c = this.cell;
    const i0 = Math.floor(bbox[0] / c), i1 = Math.floor(bbox[2] / c);
    const j0 = Math.floor(bbox[1] / c), j1 = Math.floor(bbox[3] / c);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = i + ',' + j;
        let arr = this.map.get(k);
        if (!arr) this.map.set(k, (arr = []));
        arr.push(item);
      }
    }
  }
  /** Distinct items whose cells overlap the square of half-width r about (x,y). */
  query(x, y, r = 0) {
    const c = this.cell;
    const out = new Set();
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((y - r) / c); j <= Math.floor((y + r) / c); j++) {
        const arr = this.map.get(i + ',' + j);
        if (arr) for (const it of arr) out.add(it);
      }
    }
    return out;
  }
}

/** Indexes polylines (arrays of [x,y]) so "distance to nearest line" is fast. */
class LineIndex {
  constructor(cell = 200) {
    this.grid = new GridIndex(cell);
    this.count = 0;
  }
  /** `pad` expands each segment's bbox so queries within `pad` still find it. */
  addLine(pts, meta, pad = 0) {
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      this.grid.insert(
        [Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.max(ax, bx) + pad, Math.max(ay, by) + pad],
        { ax, ay, bx, by, meta },
      );
      this.count++;
    }
  }
  /** Nearest segment within r metres: {dist, meta} or null. */
  nearest(x, y, r) {
    let best = null;
    for (const s of this.grid.query(x, y, 0)) {
      const { dist } = distToSegment(x, y, s.ax, s.ay, s.bx, s.by);
      if (dist <= r && (!best || dist < best.dist)) best = { dist, meta: s.meta };
    }
    return best;
  }
  /** Is any segment within its own `meta.buffer` of the point? */
  violates(x, y, slack = 0) {
    for (const s of this.grid.query(x, y, 0)) {
      const { dist } = distToSegment(x, y, s.ax, s.ay, s.bx, s.by);
      if (dist <= s.meta.buffer - slack) return s.meta;
    }
    return null;
  }
}

/**
 * Constraints (all lat/lon):
 *  boundary: { rings: [[{lat,lon}...]...] }  point must be inside ANY ring
 *  avoidAreas: [{ ring:[{lat,lon}], buffer, kind }]
 *  avoidLines: [{ pts:[{lat,lon}], buffer, kind }]
 *  trails:     [{ pts:[{lat,lon}] }]           reachable ground
 *
 * opts: { edgeBuffer=30, maxTrailDist=null, minTrailDist=0, step=null, rng,
 *         maxSlope=null (deg), slopeFn(lat,lon)->deg|null }
 * Returns { proj, pool:[{x,y}], step, stats }
 */
export function buildPool({ boundary, start, constraints = {}, opts = {} }) {
  const { edgeBuffer = 30, maxTrailDist = null, minTrailDist = 0, maxSlope = null, slopeFn = null } = opts;
  const rng = opts.rng ?? Math.random;
  const proj = makeProjection(start);
  const P = (ll) => proj.toXY(ll.lat, ll.lon);

  const rings = boundary.rings.map((r) => r.map(P));
  const bboxes = rings.map(ringBBox);
  const minX = Math.min(...bboxes.map((b) => b[0])), minY = Math.min(...bboxes.map((b) => b[1]));
  const maxX = Math.max(...bboxes.map((b) => b[2])), maxY = Math.max(...bboxes.map((b) => b[3]));
  const area = (maxX - minX) * (maxY - minY);
  const step = opts.step ?? Math.max(20, Math.sqrt(area / 40000));

  // boundary edges
  const edgeIdx = new LineIndex(Math.max(100, edgeBuffer * 2));
  for (const r of rings) edgeIdx.addLine([...r, r[0]], { buffer: edgeBuffer }, edgeBuffer);

  // avoid areas: polygon containment + buffered edges
  const areaIdx = new GridIndex(150);
  const areaEdges = new LineIndex(150);
  const areaRings = [];
  for (const a of constraints.avoidAreas ?? []) {
    const ring = a.ring.map(P);
    if (ring.length < 3) continue;
    const bb = ringBBox(ring);
    const id = areaRings.length;
    areaRings.push({ ring, bb, kind: a.kind });
    areaIdx.insert(bb, id);
    areaEdges.addLine([...ring, ring[0]], { buffer: a.buffer ?? 0, kind: a.kind }, a.buffer ?? 0);
  }
  const lineIdx = new LineIndex(150);
  for (const l of constraints.avoidLines ?? []) {
    lineIdx.addLine(l.pts.map(P), { buffer: l.buffer ?? 0, kind: l.kind }, l.buffer ?? 0);
  }
  // padded so a point's own cell finds every trail segment within reach
  const trailReach = Math.max(maxTrailDist ?? 0, minTrailDist) + 10; // +10 covers check() slack
  const trailPadIdx = new LineIndex(Math.max(100, trailReach));
  for (const t of constraints.trails ?? []) trailPadIdx.addLine(t.pts.map(P), {}, trailReach);
  const haveTrails = trailPadIdx.count > 0;

  /** null if (x,y) is usable ground, else the reason it is rejected. */
  function test(x, y, slack = 0) {
    if (!rings.some((r, i) => {
      const b = bboxes[i];
      return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && pointInRing(x, y, r);
    })) return 'outside';
    if (edgeIdx.violates(x, y, slack)) return 'edge';
    for (const id of areaIdx.query(x, y, 0)) {
      const a = areaRings[id];
      if (x >= a.bb[0] && x <= a.bb[2] && y >= a.bb[1] && y <= a.bb[3] && pointInRing(x, y, a.ring)) return a.kind;
    }
    const near = areaEdges.violates(x, y, slack);
    if (near) return near.kind;
    const ln = lineIdx.violates(x, y, slack);
    if (ln) return ln.kind;
    if (haveTrails) {
      const t = trailPadIdx.nearest(x, y, trailReach);
      const d = t ? t.dist : Infinity;
      if (maxTrailDist != null && d > maxTrailDist + slack) return 'far from any trail';
      if (minTrailDist > 0 && d < minTrailDist - slack) return 'on/too near a trail';
    }
    if (maxSlope != null && slopeFn) {
      const ll = proj.toLL(x, y);
      const sl = slopeFn(ll.lat, ll.lon);
      if (sl != null && sl > maxSlope + (slack ? 3 : 0)) return 'steep ground';
    }
    return null;
  }

  const stats = { grid: 0, kept: 0, rejected: {} };
  const pool = [];
  for (let gx = minX; gx <= maxX; gx += step) {
    for (let gy = minY; gy <= maxY; gy += step) {
      const x = gx + (rng() - 0.5) * step;
      const y = gy + (rng() - 0.5) * step;
      stats.grid++;
      const why = test(x, y);
      if (why) stats.rejected[why] = (stats.rejected[why] ?? 0) + 1;
      else pool.push({ x, y });
    }
  }
  stats.kept = pool.length;
  // Used on already-placed points: a point snapped to its 10 m MGRS cell can
  // move ~7 m, so buffer/trail rules are checked with that much slack.
  const check = (lat, lon) => {
    const [x, y] = proj.toXY(lat, lon);
    return test(x, y, 7.5);
  };
  return { proj, pool, step, stats, haveTrails, check };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Total straight-line length (m) of start -> pts [-> start], using true haversine. */
export function courseLength(start, pts, endAtStart) {
  const seq = [start, ...pts];
  if (endAtStart) seq.push(start);
  return pathLength(seq);
}

function spacingOK(c, others, minSpacing) {
  for (const o of others) if (dist(c, o) < minSpacing) return false;
  return true;
}

/**
 * Pick `n` points from the pool so that the route length is close to targetM
 * and every pair (including the start) is at least minSpacing apart.
 * Returns { points:[{lat,lon}], total, error, ok, tries }
 */
export function generateCourse({
  pool, proj, start, n = 5, targetM, minSpacing = 400, endAtStart = true,
  rng = Math.random, tolerance = 0.04, tries = 4000, samplePerStep = 120,
}) {
  if (!pool.length) return { points: [], total: 0, error: Infinity, ok: false, tries: 0, reason: 'No valid ground found in the boundary.' };
  const origin = { x: 0, y: 0 };
  const legs = n + (endAtStart ? 1 : 0);
  let best = null;
  let t;
  for (t = 0; t < tries; t++) {
    const pts = [];
    let prev = origin;
    let sofar = 0;
    let fail = false;
    for (let i = 0; i < n; i++) {
      const legsLeft = legs - i;
      // aim for an even share of the remaining distance, with some variety
      const want = ((targetM - sofar) / legsLeft) * (0.7 + rng() * 0.6);
      let pick = null;
      let pickErr = Infinity;
      for (let s = 0; s < samplePerStep; s++) {
        const c = pool[Math.floor(rng() * pool.length)];
        if (dist(c, origin) < minSpacing || !spacingOK(c, pts, minSpacing)) continue;
        const err = Math.abs(dist(c, prev) - want);
        if (err < pickErr) { pickErr = err; pick = c; }
      }
      if (!pick) { fail = true; break; }
      pts.push(pick);
      sofar += dist(pick, prev);
      prev = pick;
    }
    if (fail) continue;
    const ll = pts.map((p) => proj.toLL(p.x, p.y));
    const total = courseLength(start, ll, endAtStart);
    const error = Math.abs(total - targetM) / targetM;
    if (!best || error < best.error) best = { points: ll, total, error };
    if (error <= tolerance) break;
  }
  if (!best) return { points: [], total: 0, error: Infinity, ok: false, tries: t, reason: 'Could not fit that many points at that spacing. Lower the spacing or point count, or use a bigger boundary.' };
  const points = best.points.map((p) => snapToMGRS(p));
  const total = courseLength(start, points, endAtStart);
  return { points, total, error: Math.abs(total - targetM) / targetM, ok: best.error <= 0.15, tries: t };
}

/**
 * Re-roll just point `index` (or add one when index === points.length),
 * holding the others fixed. Prefers positions that
 * keep the total near the target while still moving the point somewhere new.
 */
export function regeneratePoint({
  pool, proj, start, points, index, targetM, minSpacing = 400, endAtStart = true,
  rng = Math.random, samples = 600,
}) {
  const others = points.filter((_, i) => i !== index);
  const oth = others.map((p) => { const [x, y] = proj.toXY(p.lat, p.lon); return { x, y }; });
  const adding = index >= points.length;
  const old = adding ? null : proj.toXY(points[index].lat, points[index].lon);
  const cands = [];
  for (let s = 0; s < samples; s++) {
    const c = pool[Math.floor(rng() * pool.length)];
    if (!c) break;
    if (dist(c, { x: 0, y: 0 }) < minSpacing || !spacingOK(c, oth, minSpacing)) continue;
    if (old && Math.hypot(c.x - old[0], c.y - old[1]) < minSpacing / 2) continue;
    const ll = proj.toLL(c.x, c.y);
    const trial = adding ? [...points, ll] : points.map((p, i) => (i === index ? ll : p));
    cands.push({ ll, err: Math.abs(courseLength(start, trial, endAtStart) - targetM) });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.err - b.err);
  const top = cands.slice(0, Math.min(6, cands.length));
  return snapToMGRS(top[Math.floor(rng() * top.length)].ll);
}
