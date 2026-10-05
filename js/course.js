// Course model + shareable code. The code is deliberately only *lightly*
// obfuscated (XOR + base64url, kept in the URL #fragment): enough that the
// coordinates aren't readable or pasteable into a map app, not anti-cheat.
import { toMGRS } from './geo.js';

export const DEFAULTS = {
  n: 5,
  targetMiles: 5,
  minSpacing: 400, // m
  radius: 30, // m
  limitMin: 240, // minutes
  endAtStart: true,
  need: 4, // points required to pass
  edgeBuffer: 30, // m inside boundary
  offTrailMin: 25, // m from any trail
  trailMax: 250, // m from reachable ground
  maxSlope: 25, // degrees; steeper ground is avoided
};

const KEY = 'LANDNAV-RANGER';
const r6 = (x) => Math.round(x * 1e6) / 1e6;

const ID_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Random-looking point IDs such as "KT47" — no relation to visit order. */
export function makePointIds(n, rng = Math.random) {
  const ids = new Set();
  while (ids.size < n) {
    ids.add(
      ID_LETTERS[Math.floor(rng() * ID_LETTERS.length)] +
        ID_LETTERS[Math.floor(rng() * ID_LETTERS.length)] +
        String(10 + Math.floor(rng() * 90)),
    );
  }
  return [...ids];
}

/** Build the course object that gets encoded. `pts` are {lat,lon}. */
export function makeCourse({ name, start, pts, ids, radius, limitMin, endAtStart, need }) {
  return {
    v: 1,
    name: name || 'Course',
    start: { lat: r6(start.lat), lon: r6(start.lon) },
    pts: pts.map((p, i) => ({ id: ids[i], lat: r6(p.lat), lon: r6(p.lon) })),
    radius,
    limitMin,
    endAtStart: !!endAtStart,
    need: Math.min(need, pts.length),
  };
}

function xor(bytes) {
  const k = new TextEncoder().encode(KEY);
  return bytes.map((b, i) => b ^ k[i % k.length] ^ ((i * 31) & 0xff));
}

function toB64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64Url(str) {
  const b = str.replace(/-/g, '+').replace(/_/g, '/');
  const s = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function encodeCourse(c) {
  const compact = {
    v: c.v, n: c.name, s: [c.start.lat, c.start.lon],
    p: c.pts.map((p) => [p.id, p.lat, p.lon]),
    r: c.radius, t: c.limitMin, e: c.endAtStart ? 1 : 0, k: c.need,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(compact));
  return toB64Url(xor(bytes));
}

/** Accepts a bare code, or a full URL containing "#code" (or "#c=code"). */
export function decodeCourse(input) {
  let code = String(input).trim();
  const hash = code.indexOf('#');
  if (hash >= 0) code = code.slice(hash + 1);
  code = code.replace(/^c=/, '').replace(/\s+/g, '');
  let o;
  try {
    o = JSON.parse(new TextDecoder().decode(xor(fromB64Url(code))));
  } catch {
    throw new Error('That course code is not valid.');
  }
  if (o.v !== 1 || !Array.isArray(o.p) || !Array.isArray(o.s)) throw new Error('Unrecognised course code.');
  return {
    v: 1,
    name: o.n,
    start: { lat: o.s[0], lon: o.s[1] },
    pts: o.p.map(([id, lat, lon]) => ({ id, lat, lon })),
    radius: o.r,
    limitMin: o.t,
    endAtStart: !!o.e,
    need: o.k,
    code,
  };
}

/** MGRS strings (8-digit) for display. */
export const mgrs8 = (p) => toMGRS(p.lat, p.lon, 4);

export function fmtLatLon(p) {
  return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
}

export function fmtDuration(totalSec) {
  const neg = totalSec < 0;
  const s = Math.abs(Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return (neg ? '-' : '') + (h ? `${h}:${mm}:${ss}` : `${m}:${ss}`);
}
