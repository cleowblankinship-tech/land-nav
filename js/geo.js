// Geodesy helpers: MGRS (via the vendored `mgrs` library), haversine, a local
// flat-earth projection for fast geometry, and basic planar geometry.
import { forward, toPoint } from '../vendor/mgrs.js';

export const EARTH_R = 6371008.8; // mean Earth radius, metres
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export const M_PER_MILE = 1609.344;
export const mToMiles = (m) => m / M_PER_MILE;
export const milesToM = (mi) => mi * M_PER_MILE;

/** Great-circle distance in metres between {lat,lon} points. */
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing a -> b in degrees [0,360). */
export function bearing(a, b) {
  const p1 = rad(a.lat);
  const p2 = rad(b.lat);
  const dl = rad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Point `dist` metres from `a` along `brg` degrees. */
export function destination(a, brg, dist) {
  const d = dist / EARTH_R;
  const t = rad(brg);
  const p1 = rad(a.lat);
  const l1 = rad(a.lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 =
    l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: deg(p2), lon: ((deg(l2) + 540) % 360) - 180 };
}

/** Total length of a polyline of {lat,lon}. */
export function pathLength(pts) {
  let t = 0;
  for (let i = 1; i < pts.length; i++) t += haversine(pts[i - 1], pts[i]);
  return t;
}

// ---------------------------------------------------------------- MGRS ----

const MGRS_RE = /^(\d{1,2}[C-HJ-NP-X])([A-HJ-NP-Z]{2})(\d*)$/;

/** Split a raw/spaced MGRS string into parts, or throw. */
export function parseMGRSParts(str) {
  const clean = String(str).toUpperCase().replace(/[\s,.-]+/g, '');
  const m = MGRS_RE.exec(clean);
  if (!m || m[3].length % 2) throw new Error(`Invalid MGRS: "${str}"`);
  const half = m[3].length / 2;
  return { gzd: m[1], square: m[2], easting: m[3].slice(0, half), northing: m[3].slice(half) };
}

/**
 * Lat/lon -> MGRS string. `digits` is digits PER AXIS (4 => "8-digit" grid,
 * 10 m precision; 5 => 1 m). Output like "13S ED 2153 0221".
 * MGRS truncates (never rounds), which the library does for us.
 */
export function toMGRS(lat, lon, digits = 4) {
  const raw = forward([lon, lat], digits);
  const p = parseMGRSParts(raw);
  return [p.gzd, p.square, p.easting, p.northing].filter(Boolean).join(' ');
}

/** MGRS string -> {lat, lon} of the CENTRE of the grid square it names. */
export function fromMGRS(str) {
  const p = parseMGRSParts(str);
  const [lon, lat] = toPoint(p.gzd + p.square + p.easting + p.northing);
  return { lat, lon };
}

/**
 * Snap a point to the centre of the MGRS cell a navigator would plot, so the
 * coordinate on the lane card and the real target location agree exactly.
 */
export function snapToMGRS(p, digits = 4) {
  return fromMGRS(toMGRS(p.lat, p.lon, digits));
}

// --------------------------------------------------------- projections ----

/** Equirectangular projection about `origin`; fine for areas < ~50 km. */
export function makeProjection(origin) {
  const mPerLat = (Math.PI / 180) * EARTH_R;
  const mPerLon = mPerLat * Math.cos(rad(origin.lat));
  return {
    origin,
    toXY: (lat, lon) => [(lon - origin.lon) * mPerLon, (lat - origin.lat) * mPerLat],
    toLL: (x, y) => ({ lat: origin.lat + y / mPerLat, lon: origin.lon + x / mPerLon }),
  };
}

// ------------------------------------------------------ planar geometry ----

/** Ray-casting point-in-ring. ring: [[x,y],...] (open or closed). */
export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from (px,py) to segment (ax,ay)-(bx,by); also returns t in [0,1]. */
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), t };
}

/** Distance in metres from lat/lon point p to the segment a-b (lat/lon). */
export function pointSegmentMeters(p, a, b) {
  const proj = makeProjection(p);
  const [ax, ay] = proj.toXY(a.lat, a.lon);
  const [bx, by] = proj.toXY(b.lat, b.lon);
  return distToSegment(0, 0, ax, ay, bx, by);
}

export function ringBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** Polygon area in m² (shoelace) for a ring in metre coordinates. */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a / 2);
}
