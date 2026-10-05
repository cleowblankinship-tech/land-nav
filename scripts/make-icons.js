// Generates the PNG app icons (no dependencies): a compass rose on olive drab.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [75, 83, 32], TAN = [214, 220, 190], ORANGE = [255, 255, 255]; // olive drab, light olive, white

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 3x3 supersampling for smooth edges
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const c = pixel((x + (sx + 0.5) / 3) / size, (y + (sy + 0.5) / 3) / size);
        r += c[0]; g += c[1]; b += c[2];
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r / 9; raw[o + 1] = g / 9; raw[o + 2] = b / 9;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// scale = how big the compass is relative to the canvas (maskable icons need a safe zone)
const compass = (scale) => (u, v) => {
  const x = (u - 0.5) / scale, y = (v - 0.5) / scale; // -0.5..0.5 in compass space
  const r = Math.hypot(x, y);
  if (r > 0.34 && r < 0.42) return TAN;
  // needle: north half orange, south half tan; diamond with half-width 0.09
  const ax = Math.abs(x);
  if (r < 0.3 && ax < 0.09 * (1 - Math.abs(y) / 0.3)) return y < 0 ? ORANGE : TAN;
  // cardinal ticks
  if (r >= 0.42 && r < 0.48 && (ax < 0.025 || Math.abs(y) < 0.025)) return TAN;
  return BG;
};

mkdirSync('icons', { recursive: true });
writeFileSync('icons/icon-180.png', png(180, compass(1)));
writeFileSync('icons/icon-192.png', png(192, compass(1)));
writeFileSync('icons/icon-512.png', png(512, compass(1)));
writeFileSync('icons/icon-maskable-512.png', png(512, compass(0.78)));
writeFileSync('icons/icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#4b5320"/><circle cx="50" cy="50" r="38" fill="none" stroke="#d6dcbe" stroke-width="8"/><path d="M50 22 L59 50 L41 50 Z" fill="#ffffff"/><path d="M50 78 L59 50 L41 50 Z" fill="#d6dcbe"/></svg>\n`);
console.log('icons written');
