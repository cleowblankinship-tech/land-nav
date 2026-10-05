// GPX parse / build and track scoring against course points.
import { makeProjection } from './geo.js';

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attr = (s, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(s);
  return m ? parseFloat(m[1] ?? m[2]) : NaN;
};

/** -> { name, points:[{lat,lon,t(ms|null),seg}] }. Regex-based so it also runs under Node. */
export function parseGPX(text) {
  const name = /<trk>[\s\S]*?<name>([\s\S]*?)<\/name>/.exec(text)?.[1] ?? /<name>([\s\S]*?)<\/name>/.exec(text)?.[1] ?? '';
  const points = [];
  let segIdx = 0;
  const re = /<trkseg\b[^>]*>|<\/trkseg>|<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;
  let m;
  let sawSeg = false;
  while ((m = re.exec(text))) {
    if (m[0].startsWith('<trkseg')) { if (sawSeg) segIdx++; sawSeg = true; continue; }
    if (m[0].startsWith('</trkseg')) continue;
    const lat = attr(m[1], 'lat'), lon = attr(m[1], 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const tm = m[2] && /<time>\s*([^<\s]+)\s*<\/time>/.exec(m[2]);
    const t = tm ? Date.parse(tm[1]) : NaN;
    points.push({ lat, lon, t: Number.isFinite(t) ? t : null, seg: segIdx });
  }
  return { name: decode(name.trim()), points };
}

/** Build a GPX 1.1 document from [{lat,lon,t(ms),acc?}]. */
export function buildGPX(track, name = 'Land Nav track') {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const pts = track
    .map((p) => `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><time>${new Date(p.t).toISOString()}</time></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Land Nav" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

/**
 * Where does segment a->b first come within r of the origin?
 * a, b in metres relative to the point. Returns s in [0,1] or null.
 */
function entryParam(ax, ay, bx, by, r) {
  if (ax * ax + ay * ay <= r * r) return 0;
  const dx = bx - ax, dy = by - ay;
  const A = dx * dx + dy * dy;
  if (A === 0) return null;
  const B = 2 * (ax * dx + ay * dy);
  const C = ax * ax + ay * ay - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const s = (-B - Math.sqrt(disc)) / (2 * A);
  return s >= 0 && s <= 1 ? s : null;
}

/**
 * Score a parsed track against course points.
 * -> [{ id, hit, minDist, t (ms|null: first time within radius) }]
 * Uses segment geometry, so sparse samples (e.g. one fix per 30 s) still count
 * when the straight line between them crosses the circle.
 */
export function scoreTrack(points, pts, radius) {
  return pts.map((p) => {
    const proj = makeProjection(p);
    let minDist = Infinity;
    let hitT = null;
    let hit = false;
    let prev = null;
    for (const q of points) {
      const [x, y] = proj.toXY(q.lat, q.lon);
      const cur = { x, y, t: q.t, seg: q.seg };
      const d = Math.hypot(x, y);
      if (d < minDist) minDist = d;
      if (prev && prev.seg === cur.seg) {
        // closest approach on the segment
        const dx = cur.x - prev.x, dy = cur.y - prev.y;
        const len2 = dx * dx + dy * dy;
        let u = len2 ? -(prev.x * dx + prev.y * dy) / len2 : 0;
        u = Math.max(0, Math.min(1, u));
        const dd = Math.hypot(prev.x + u * dx, prev.y + u * dy);
        if (dd < minDist) minDist = dd;
        if (!hit) {
          const s = entryParam(prev.x, prev.y, cur.x, cur.y, radius);
          if (s != null) {
            hit = true;
            hitT = prev.t != null && cur.t != null ? prev.t + s * (cur.t - prev.t) : cur.t ?? prev.t;
          }
        }
      } else if (!hit && d <= radius) {
        hit = true;
        hitT = q.t;
      }
      prev = cur;
    }
    return { id: p.id, hit, minDist, t: hitT };
  });
}
