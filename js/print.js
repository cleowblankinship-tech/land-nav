// Exact-scale (1:25,000) printable map geometry. Pure maths: proj4 is passed in
// so this runs in the browser (global proj4) and under Node tests.
//
// Paper space is millimetres with the origin at the top-left of the map frame and
// the UTM/MGRS grid axis-aligned with the paper, so 1 km of grid is exactly 40 mm
// and a 1:25,000 military protractor reads true. Web-mercator tiles are placed
// with an affine fit (this absorbs grid convergence and mercator scale).

export const SCALE = 25000;
export const M_PER_MM = SCALE / 1000; // 25 m of ground per millimetre of paper
export const PX_PER_MM = 96 / 25.4; // CSS pixels per millimetre

export const PAPER = {
  letter: { w: 215.9, h: 279.4, label: 'Letter' },
  a4: { w: 210, h: 297, label: 'A4' },
};

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** UTM helper bound to the zone of (lat, lon). */
export function makeUtm(proj4, lat, lon) {
  const zone = Math.floor((lon + 180) / 6) + 1;
  const south = lat < 0;
  const def = `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
  return {
    zone, south, def,
    fwd: (la, lo) => proj4('EPSG:4326', def, [lo, la]), // -> [E, N]
    inv: (E, N) => { const [lo, la] = proj4(def, 'EPSG:4326', [E, N]); return { lat: la, lon: lo }; },
  };
}

/** Web-mercator global pixel at zoom z (256 px tiles) <-> lat/lon. */
export function llToPx(lat, lon, z) {
  const n = 256 * 2 ** z;
  const s = Math.sin(rad(lat));
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}
export function pxToLl(x, y, z) {
  const n = 256 * 2 ** z;
  return { lat: deg(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))), lon: (x / n) * 360 - 180 };
}

/** Frame size in mm for a paper size/orientation. Multiples of 4 mm (= 100 m of ground). */
export function frameSize(paper, orientation, { margin = 8, gutter = 7, header = 12, footer = 26 } = {}) {
  let { w, h } = paper;
  if (orientation === 'landscape') [w, h] = [h, w];
  const fw = Math.floor((w - 2 * margin - 2 * gutter) / 4) * 4;
  const fh = Math.floor((h - 2 * margin - 2 * gutter - header - footer) / 4) * 4;
  return { paperW: w, paperH: h, fw, fh, margin, gutter, header, footer };
}

/**
 * Cover a lat/lon bbox [s,w,n,e] with sheets of (fw x fh) mm at 1:25,000, with
 * `overlap` metres between neighbours. Sheet corners snap to whole kilometres
 * so grid lines land on tidy paper positions. Reading order: north to south, west to east.
 */
export function planSheets(utm, bbox, fw, fh, overlap = 1000) {
  const [s, w, n, e] = bbox;
  const pts = [utm.fwd(s, w), utm.fwd(s, e), utm.fwd(n, w), utm.fwd(n, e)];
  const minE = Math.floor(Math.min(...pts.map((p) => p[0])) / 1000) * 1000;
  const maxE = Math.max(...pts.map((p) => p[0]));
  const minN = Math.floor(Math.min(...pts.map((p) => p[1])) / 1000) * 1000;
  const maxN = Math.max(...pts.map((p) => p[1]));
  const Wm = fw * M_PER_MM, Hm = fh * M_PER_MM;
  const stepE = Wm - overlap, stepN = Hm - overlap;
  const cols = Math.max(1, Math.ceil((maxE - minE - overlap) / stepE));
  const rows = Math.max(1, Math.ceil((maxN - minN - overlap) / stepN));
  // centre the block of sheets on the area so margins are even
  const padE = (cols * stepE + overlap - (maxE - minE)) / 2;
  const padN = (rows * stepN + overlap - (maxN - minN)) / 2;
  const baseE = Math.round((minE - padE) / 1000) * 1000;
  const baseN = Math.round((minN - padN) / 1000) * 1000;
  const sheets = [];
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = 0; c < cols; c++) {
      sheets.push({ col: c, row: rows - 1 - r, e0: baseE + c * stepE, n0: baseN + r * stepN, Wm, Hm });
    }
  }
  return { sheets, cols, rows, Wm, Hm };
}

/** Ground (E,N) -> paper mm inside a sheet (exact, no tile approximation). */
export const enToMm = (sheet, E, N) => [(E - sheet.e0) / M_PER_MM, (sheet.n0 + sheet.Hm - N) / M_PER_MM];

/**
 * Affine placing web-mercator tiles on the sheet. Tile pixel coords are taken
 * relative to the integer origin (X0, Y0) to keep CSS numbers small.
 * Returns the CSS matrix(a,b,c,d,e,f) plus the tile range to load.
 */
export function tileLayer(utm, sheet, z) {
  const centre = utm.inv(sheet.e0 + sheet.Wm / 2, sheet.n0 + sheet.Hm / 2);
  const [xc, yc] = llToPx(centre.lat, centre.lon, z);
  const toEN = (x, y) => { const p = pxToLl(x, y, z); return utm.fwd(p.lat, p.lon); };
  const d = 400;
  const E0 = toEN(xc, yc), Ex = toEN(xc + d, yc), Ey = toEN(xc, yc + d);
  const dudx = (Ex[0] - E0[0]) / d / M_PER_MM, dudy = (Ey[0] - E0[0]) / d / M_PER_MM;
  const dvdx = -(Ex[1] - E0[1]) / d / M_PER_MM, dvdy = -(Ey[1] - E0[1]) / d / M_PER_MM;
  const [u0, v0] = enToMm(sheet, E0[0], E0[1]);

  // tile range covering the four sheet corners
  const corners = [[0, 0], [sheet.Wm, 0], [0, sheet.Hm], [sheet.Wm, sheet.Hm]].map(([dx, dy]) => {
    const ll = utm.inv(sheet.e0 + dx, sheet.n0 + dy);
    return llToPx(ll.lat, ll.lon, z);
  });
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const tx0 = Math.floor(Math.min(...xs) / 256) - 1, tx1 = Math.floor(Math.max(...xs) / 256) + 1;
  const ty0 = Math.floor(Math.min(...ys) / 256) - 1, ty1 = Math.floor(Math.max(...ys) / 256) + 1;
  const X0 = tx0 * 256, Y0 = ty0 * 256;
  const K = PX_PER_MM;
  const e = (u0 + dudx * (X0 - xc) + dudy * (Y0 - yc)) * K;
  const f = (v0 + dvdx * (X0 - xc) + dvdy * (Y0 - yc)) * K;
  return {
    matrix: [dudx * K, dvdx * K, dudy * K, dvdy * K, e, f],
    tiles: { tx0, tx1, ty0, ty1, X0, Y0 },
    z,
    // paper mm of an arbitrary tile pixel (for tests)
    pxToMm: (x, y) => [u0 + dudx * (x - xc) + dudy * (y - yc), v0 + dvdx * (x - xc) + dvdy * (y - yc)],
  };
}

/** Grid convergence (degrees, east of the central meridian is positive) at a point. */
export function convergence(utm, lat, lon) {
  const [E, N] = utm.fwd(lat, lon);
  const p = utm.inv(E, N + 1000); // 1 km along grid north
  const dLon = rad(p.lon - lon), l1 = rad(lat), l2 = rad(p.lat);
  const y = Math.sin(dLon) * Math.cos(l2);
  const x = Math.cos(l1) * Math.sin(l2) - Math.sin(l1) * Math.cos(l2) * Math.cos(dLon);
  return deg(Math.atan2(y, x)); // true bearing of grid north; positive = grid north is east of true north
}

/** Gridline positions: [{value (m), mm}] for easting (x) or northing (y) every `step` metres. */
export function gridLines(sheet, axis, step = 1000) {
  const out = [];
  const lo = axis === 'E' ? sheet.e0 : sheet.n0;
  const hi = lo + (axis === 'E' ? sheet.Wm : sheet.Hm);
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-6; v += step) {
    out.push({ value: v, mm: axis === 'E' ? (v - sheet.e0) / M_PER_MM : (sheet.n0 + sheet.Hm - v) / M_PER_MM });
  }
  return out;
}
