import test from 'node:test';
import assert from 'node:assert/strict';
import { Dem, decodeTerrarium, encodeTerrarium, lonLatToPixel, metersPerPixel } from '../js/dem.js';

test('terrarium encode/decode round-trips', () => {
  for (const m of [0, 1, 1234.5, 1900.25, 4301.75, -50.5]) {
    const [r, g, b] = encodeTerrarium(m);
    assert.ok(Math.abs(decodeTerrarium(r, g, b) - m) < 0.01, `${m}`);
  }
});

test('web mercator pixel / resolution sanity', () => {
  const [x, y] = lonLatToPixel(0, 0, 0);
  assert.ok(Math.abs(x - 128) < 1e-9 && Math.abs(y - 128) < 1e-9);
  assert.ok(Math.abs(metersPerPixel(0, 0) - 156543.03392) < 1e-3);
  assert.ok(Math.abs(metersPerPixel(38.87, 14) - 7.44) < 0.05);
});

// synthetic terrain: plane rising to the north at `deg` degrees
function planeTiles(deg, lat0) {
  const tan = Math.tan((deg * Math.PI) / 180);
  return async (z, tx, ty) => {
    const data = new Uint8ClampedArray(256 * 256 * 4);
    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        const gy = ty * 256 + py + 0.5;
        // metres north of lat0 from mercator pixel row
        const n = 256 * 2 ** z;
        const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / n))) * 180) / Math.PI;
        const elev = 2000 + (lat - lat0) * 111195 * tan;
        const [r, g, b] = encodeTerrarium(elev);
        const o = (py * 256 + px) * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
    }
    return { data, width: 256, height: 256 };
  };
}

test('Dem recovers the slope of a tilted plane', async () => {
  const lat0 = 38.87;
  const dem = await Dem.load([38.86, -104.76, 38.88, -104.74], { fetchTile: planeTiles(20, lat0) });
  const s = dem.slope(38.87, -104.75);
  assert.ok(Math.abs(s - 20) < 0.7, `slope ${s}`);
  assert.ok(Math.abs(dem.maxSlope(38.87, -104.75) - 20) < 1);
  assert.ok(Math.abs(dem.elevation(lat0, -104.75) - 2000) < 5, `elev ${dem.elevation(lat0, -104.75)}`);
});

test('flat terrain is ~0°, and outside loaded tiles is unknown (null)', async () => {
  const dem = await Dem.load([38.86, -104.76, 38.88, -104.74], { fetchTile: planeTiles(0, 38.87) });
  assert.ok(dem.slope(38.87, -104.75) < 0.3);
  assert.equal(dem.slope(10, 10), null);
});

test('Dem.load fails clearly when no tiles load', async () => {
  await assert.rejects(Dem.load([38.86, -104.76, 38.88, -104.74], { fetchTile: async () => null }), /No elevation tiles/);
});

test('large areas drop to a coarser zoom to bound tile count', async () => {
  let calls = 0;
  const f = async () => { calls++; return { data: new Uint8ClampedArray(256 * 256 * 4), width: 256, height: 256 }; };
  await Dem.load([38.5, -105.5, 39.2, -104.5], { fetchTile: f, maxTiles: 20 });
  assert.ok(calls <= 20, `tiles ${calls}`);
});
