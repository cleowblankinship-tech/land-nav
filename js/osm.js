// OpenStreetMap access via the Overpass API (and Nominatim for place search),
// plus pure parsing helpers that turn Overpass JSON into the constraint
// structures generate.js uses.

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export async function overpass(query, { signal } = {}) {
  const errors = [];
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.remark && /error|timed out/i.test(json.remark) && !json.elements?.length) throw new Error(json.remark);
      return json;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      errors.push(`${new URL(url).host}: ${e.message}`);
    }
  }
  throw new Error('Overpass unreachable (' + errors.join('; ') + ')');
}

/** Nominatim place search -> [{name, lat, lon, bbox:[s,n,w,e]}] (for jumping the map). */
export async function searchPlace(q, { signal } = {}) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=' + encodeURIComponent(q);
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Place search failed (HTTP ${res.status})`);
  return (await res.json()).map((r) => ({
    name: r.display_name,
    lat: +r.lat,
    lon: +r.lon,
    bbox: r.boundingbox?.map(Number),
  }));
}

// ------------------------------------------------------------- geometry ----

const same = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Join open polylines ([[lat,lon]...]) end-to-end into closed rings. */
export function stitchRings(lines) {
  const pool = lines.filter((l) => l.length > 1).map((l) => l.slice());
  const rings = [];
  while (pool.length) {
    let cur = pool.shift();
    for (;;) {
      if (cur.length > 3 && same(cur[0], cur[cur.length - 1])) break;
      let joined = false;
      for (let i = 0; i < pool.length; i++) {
        const w = pool[i];
        const end = cur[cur.length - 1];
        if (same(end, w[0])) cur = cur.concat(w.slice(1));
        else if (same(end, w[w.length - 1])) cur = cur.concat(w.slice(0, -1).reverse());
        else if (same(cur[0], w[w.length - 1])) cur = w.concat(cur.slice(1));
        else if (same(cur[0], w[0])) cur = w.slice(1).reverse().concat(cur);
        else continue;
        pool.splice(i, 1);
        joined = true;
        break;
      }
      if (!joined) break;
    }
    if (cur.length > 3 && same(cur[0], cur[cur.length - 1])) rings.push(cur.slice(0, -1));
    else if (cur.length >= 3) rings.push(cur); // broken/clipped data: close it implicitly
  }
  return rings;
}

const toLL = (g) => g.map((p) => [p.lat, p.lon]);
const toObj = (ring) => ring.map(([lat, lon]) => ({ lat, lon }));

/** An Overpass element -> {outers:[ring], inners:[ring]} (rings of {lat,lon}); lines excluded. */
export function elementRings(el) {
  if (el.type === 'way' && el.geometry) {
    const g = toLL(el.geometry);
    if (g.length > 3 && same(g[0], g[g.length - 1])) return { outers: [toObj(g.slice(0, -1))], inners: [] };
    return { outers: [], inners: [] };
  }
  if (el.type === 'relation' && el.members) {
    const outer = [], inner = [];
    for (const m of el.members) {
      if (m.type !== 'way' || !m.geometry) continue;
      (m.role === 'inner' ? inner : outer).push(toLL(m.geometry));
    }
    return { outers: stitchRings(outer).map(toObj), inners: stitchRings(inner).map(toObj) };
  }
  return { outers: [], inners: [] };
}

export function bboxOfLL(points, pad = 0) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const p of points) {
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
    if (p.lon < w) w = p.lon;
    if (p.lon > e) e = p.lon;
  }
  return [s - pad, w - pad, n + pad, e + pad];
}
const bb = (b) => b.map((x) => x.toFixed(6)).join(',');

// ------------------------------------------------------------ boundaries ----

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');

/** Named parks / reserves / public land overlapping a bbox [s,w,n,e]. */
export async function findBoundaries(bbox, name = '', opts) {
  const nm = name.trim() ? `["name"~"${escRe(name.trim())}",i]` : '["name"]';
  const b = bb(bbox);
  const q = `[out:json][timeout:60];(
    nwr["leisure"~"^(park|nature_reserve)$"]${nm}(${b});
    nwr["boundary"~"^(protected_area|national_park)$"]${nm}(${b});
    nwr["landuse"~"^(recreation_ground|forest)$"]${nm}(${b});
  );out geom;`;
  return parseBoundaries(await overpass(q, opts));
}

export function parseBoundaries(json) {
  const out = [];
  for (const el of json.elements ?? []) {
    if (!el.tags?.name) continue;
    const { outers, inners } = elementRings(el);
    if (!outers.length) continue;
    out.push({
      id: `${el.type}/${el.id}`,
      name: el.tags.name,
      kind: el.tags.leisure || el.tags.boundary || el.tags.landuse || '',
      operator: el.tags.operator || '',
      rings: outers,
      holes: inners,
    });
  }
  // biggest first (bbox area is enough for ordering)
  const size = (c) => {
    const [s, w, n, e] = bboxOfLL(c.rings.flat());
    return (n - s) * (e - w);
  };
  return out.sort((a, b) => size(b) - size(a));
}

// ----------------------------------------------------------- constraints ----

const WATER_AREAS = new Set(['water', 'wetland', 'bay']);
const ROCK_AREAS = new Set(['bare_rock', 'scree']);
const DEV_LANDUSE = new Set([
  'residential', 'commercial', 'industrial', 'retail', 'construction', 'quarry',
  'landfill', 'cemetery', 'farmland', 'farmyard', 'military', 'railway',
]);
const DEV_LEISURE = new Set([
  'golf_course', 'pitch', 'swimming_pool', 'stadium', 'track', 'playground', 'garden', 'sports_centre', 'marina',
]);
const TRAIL_HW = new Set([
  'path', 'track', 'footway', 'bridleway', 'cycleway', 'steps', 'pedestrian', 'living_street',
]);
const NOT_REAL_HW = new Set(['proposed', 'construction', 'abandoned', 'razed', 'platform', 'corridor', 'elevator']);

/** -> {kind, buffer} if this tag set is an AREA we must stay out of. */
export function areaRule(t) {
  if (t.building && t.building !== 'no') return { kind: 'building', buffer: 20 };
  if (WATER_AREAS.has(t.natural) || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin')
    return { kind: 'water', buffer: 10 };
  if (ROCK_AREAS.has(t.natural)) return { kind: 'rock', buffer: 10 };
  if (DEV_LANDUSE.has(t.landuse)) return { kind: 'developed', buffer: 25 };
  if (DEV_LEISURE.has(t.leisure)) return { kind: 'developed', buffer: 10 };
  if (t.amenity === 'parking') return { kind: 'parking', buffer: 10 };
  if (t.access === 'private' || t.access === 'no') return { kind: 'private', buffer: 10 };
  return null;
}

/** -> {kind, buffer, trail} for LINEAR features. */
export function lineRule(t) {
  if (t.highway) {
    if (NOT_REAL_HW.has(t.highway)) return null;
    if (t.access === 'private' || t.access === 'no') return { kind: 'private road', buffer: 15, trail: false };
    if (TRAIL_HW.has(t.highway)) return { kind: 'trail', buffer: 0, trail: true };
    return { kind: 'road', buffer: 20, trail: true };
  }
  if (t.waterway) {
    if (t.waterway === 'riverbank') return null;
    const big = ['river', 'canal'].includes(t.waterway);
    return { kind: 'water', buffer: big ? 20 : 8, trail: false };
  }
  if (t.natural === 'cliff') return { kind: 'cliff', buffer: 20, trail: false };
  if (['fence', 'wall', 'retaining_wall', 'hedge'].includes(t.barrier)) return { kind: 'fence', buffer: 10, trail: false };
  if (['rail', 'light_rail', 'tram', 'narrow_gauge'].includes(t.railway)) return { kind: 'railway', buffer: 25, trail: false };
  return null;
}

export function parseConstraints(json) {
  const avoidAreas = [], avoidLines = [], trails = [];
  const counts = {};
  const bump = (k) => (counts[k] = (counts[k] ?? 0) + 1);
  for (const el of json.elements ?? []) {
    const t = el.tags;
    if (!t || el.type === 'node') continue;
    const area = areaRule(t);
    if (area) {
      const { outers } = elementRings(el);
      for (const ring of outers) avoidAreas.push({ ring, ...area });
      if (outers.length) bump(area.kind);
      // a closed way that is ALSO a linear feature (e.g. fence loop) falls through
      if (outers.length) continue;
    }
    if (el.type === 'way' && el.geometry) {
      const rule = lineRule(t);
      if (!rule) continue;
      const pts = el.geometry.map((p) => ({ lat: p.lat, lon: p.lon }));
      if (rule.buffer > 0) avoidLines.push({ pts, buffer: rule.buffer, kind: rule.kind });
      if (rule.trail) trails.push({ pts });
      bump(rule.kind);
    }
  }
  return { avoidAreas, avoidLines, trails, counts };
}

/** Fetch OSM constraint data for a bbox [s,w,n,e]. */
export async function fetchConstraints(bbox, opts) {
  const b = bb(bbox);
  const q = `[out:json][timeout:90][maxsize:268435456];(
    nwr["natural"~"^(water|wetland|bay|bare_rock|scree|cliff)$"](${b});
    nwr["landuse"~"^(reservoir|basin|residential|commercial|industrial|retail|construction|quarry|landfill|cemetery|farmland|farmyard|military|railway)$"](${b});
    nwr["leisure"~"^(golf_course|pitch|swimming_pool|stadium|track|playground|garden|sports_centre|marina)$"](${b});
    nwr["amenity"="parking"](${b});
    nwr["access"~"^(private|no)$"](${b});
    way["building"](${b});
    way["waterway"](${b});
    way["barrier"~"^(fence|wall|retaining_wall|hedge)$"](${b});
    way["railway"~"^(rail|light_rail|tram|narrow_gauge)$"](${b});
    way["highway"](${b});
  );out geom;`;
  return parseConstraints(await overpass(q, opts));
}
