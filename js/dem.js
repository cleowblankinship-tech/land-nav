// Elevation / slope from "Terrarium" terrain tiles (free, CORS-enabled, PNG where
// elevation_m = R*256 + G + B/256 - 32768). Pure maths + an injectable tile
// fetcher so it can be tested without a network or a canvas.

const TILE_URL = (z, x, y) => `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;
const rad = (d) => (d * Math.PI) / 180;

export const decodeTerrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;
export const encodeTerrarium = (m) => {
  const v = m + 32768;
  const r = Math.floor(v / 256);
  const g = Math.floor(v % 256);
  const b = Math.round((v - Math.floor(v)) * 256) % 256;
  return [r, g, b];
};

/** Global web-mercator pixel coords at zoom z (256 px tiles). */
export function lonLatToPixel(lat, lon, z) {
  const n = 256 * 2 ** z;
  const s = Math.sin(rad(lat));
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}
export const metersPerPixel = (lat, z) => (156543.03392 * Math.cos(rad(lat))) / 2 ** z;

/** Browser tile fetcher -> {data:Uint8ClampedArray(RGBA), width, height} (or null). */
export async function fetchTileBrowser(z, x, y) {
  const res = await fetch(TILE_URL(z, x, y));
  if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob());
  const cv = document.createElement('canvas');
  cv.width = bmp.width;
  cv.height = bmp.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return { data: ctx.getImageData(0, 0, bmp.width, bmp.height).data, width: bmp.width, height: bmp.height };
}

export class Dem {
  constructor(z, tiles) {
    this.z = z;
    this.tiles = tiles; // Map "x,y" -> Float32Array(256*256)
  }

  /**
   * Load every tile covering bbox [s,w,n,e]. Picks the finest zoom (<= maxZoom)
   * that keeps the tile count modest.
   */
  static async load(bbox, { fetchTile = fetchTileBrowser, maxZoom = 14, maxTiles = 30 } = {}) {
    const [s, w, n, e] = bbox;
    let z = maxZoom;
    const range = (zz) => {
      const [x0, y0] = lonLatToPixel(n, w, zz);
      const [x1, y1] = lonLatToPixel(s, e, zz);
      return [Math.floor(x0 / 256), Math.floor(y0 / 256), Math.floor(x1 / 256), Math.floor(y1 / 256)];
    };
    let r = range(z);
    while (z > 8 && (r[2] - r[0] + 1) * (r[3] - r[1] + 1) > maxTiles) r = range(--z);
    const jobs = [];
    for (let ty = r[1]; ty <= r[3]; ty++) for (let tx = r[0]; tx <= r[2]; tx++) jobs.push([tx, ty]);
    const tiles = new Map();
    await Promise.all(jobs.map(async ([tx, ty]) => {
      const t = await fetchTile(z, tx, ty);
      if (!t) return;
      const el = new Float32Array(t.width * t.height);
      for (let i = 0; i < el.length; i++) el[i] = decodeTerrarium(t.data[i * 4], t.data[i * 4 + 1], t.data[i * 4 + 2]);
      tiles.set(`${tx},${ty}`, el);
    }));
    if (!tiles.size) throw new Error('No elevation tiles could be loaded');
    return new Dem(z, tiles);
  }

  _px(gx, gy) {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const t = this.tiles.get(`${tx},${ty}`);
    return t ? t[(gy - ty * 256) * 256 + (gx - tx * 256)] : NaN;
  }

  /** Bilinear elevation in metres, or NaN outside loaded tiles. */
  elevation(lat, lon) {
    const [px, py] = lonLatToPixel(lat, lon, this.z);
    const x = px - 0.5, y = py - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const a = this._px(x0, y0), b = this._px(x0 + 1, y0), c = this._px(x0, y0 + 1), d = this._px(x0 + 1, y0 + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  /** Slope in degrees from central differences over a >= 20 m baseline; null if unknown. */
  slope(lat, lon) {
    const d = Math.max(15, 1.5 * metersPerPixel(lat, this.z)); // metres either side
    const dLat = d / 111195;
    const dLon = d / (111195 * Math.cos(rad(lat)));
    const zn = this.elevation(lat + dLat, lon), zs = this.elevation(lat - dLat, lon);
    const ze = this.elevation(lat, lon + dLon), zw = this.elevation(lat, lon - dLon);
    if ([zn, zs, ze, zw].some(Number.isNaN)) return null;
    return (Math.atan(Math.hypot((ze - zw) / (2 * d), (zn - zs) / (2 * d))) * 180) / Math.PI;
  }

  /** Steepest slope at the point and four spots `r` metres around it (conservative). */
  maxSlope(lat, lon, r = 15) {
    const dLat = r / 111195, dLon = r / (111195 * Math.cos(rad(lat)));
    let worst = null;
    for (const [a, b] of [[0, 0], [dLat, 0], [-dLat, 0], [0, dLon], [0, -dLon]]) {
      const s = this.slope(lat + a, lon + b);
      if (s != null && (worst == null || s > worst)) worst = s;
    }
    return worst;
  }
}
