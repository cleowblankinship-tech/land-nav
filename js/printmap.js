// Builds exact-scale 1:25,000 sheets: grid, tiles, scale bar, calibration line.
// Course points are never drawn here.
import { toMGRS } from './geo.js';
import { store } from './store.js';
import {
  PAPER, M_PER_MM, makeUtm, frameSize, planSheets, tileLayer, enToMm, gridLines, convergence,
} from './print.js';

const $ = (id) => document.getElementById(id);
const ZOOM = 16;
const BASES = {
  otm: (z, x, y) => `https://a.tile.opentopomap.org/${z}/${x}/${y}.png`,
  usgs: (z, x, y) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/${z}/${y}/${x}`,
  img: (z, x, y) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`,
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const req = store.get('ln.printreq');
const saved = store.get('ln.printopts', {});
$('paper').value = saved.paper ?? 'letter';
$('orient').value = saved.orient ?? 'portrait';
$('base').value = saved.base ?? 'otm';
$('decl').value = saved.decl ?? store.get('ln.decl', 7);
$('outline').checked = saved.outline ?? false;

function render() {
  const opts = { paper: $('paper').value, orient: $('orient').value, base: $('base').value, decl: parseFloat($('decl').value) || 0, outline: $('outline').checked };
  store.set('ln.printopts', opts);
  store.set('ln.decl', opts.decl);
  const root = $('sheets');
  if (!req) {
    $('msg').innerHTML = '<div class="banner warn">Open this from Build a course, after you pick an area or a start point.</div>';
    root.innerHTML = '';
    $('printBtn').disabled = true;
    return;
  }
  const f = frameSize(PAPER[opts.paper], opts.orient);
  const c = { lat: (req.bbox[0] + req.bbox[2]) / 2, lon: (req.bbox[1] + req.bbox[3]) / 2 };
  const utm = makeUtm(window.proj4, c.lat, c.lon);
  const plan = planSheets(utm, req.bbox, f.fw, f.fh);
  $('pageRule').textContent = `@page { size: ${f.paperW}mm ${f.paperH}mm; margin: 0; }`;
  $('info').innerHTML = `<b>${plan.sheets.length} ${plan.sheets.length === 1 ? 'sheet' : 'sheets'}</b>, each ${(plan.Wm / 1000).toFixed(1)} by ${(plan.Hm / 1000).toFixed(1)} km. Neighbouring sheets overlap by 1 km.`;
  $('printBtn').disabled = false;
  const gamma = convergence(utm, c.lat, c.lon);
  root.innerHTML = plan.sheets.map((s, i) => sheetHtml(s, i, plan.sheets.length, f, utm, opts, gamma)).join('');
}

function sheetHtml(s, idx, total, f, utm, opts, gamma) {
  const left = f.margin + f.gutter;
  const top = f.margin + f.header + f.gutter;
  const L = tileLayer(utm, s, ZOOM);
  const t = L.tiles;
  const url = BASES[opts.base];
  let imgs = '';
  for (let ty = t.ty0; ty <= t.ty1; ty++) {
    for (let tx = t.tx0; tx <= t.tx1; tx++) {
      imgs += `<img alt="" loading="eager" src="${url(ZOOM, tx, ty)}" style="left:${tx * 256 - t.X0}px;top:${ty * 256 - t.Y0}px">`;
    }
  }
  const W = f.fw, H = f.fh;
  const es = gridLines(s, 'E'), ns = gridLines(s, 'N');
  const km2 = (v) => String(Math.floor(v / 1000) % 100).padStart(2, '0');
  const gl = [];
  for (const e of es) {
    gl.push(`<line x1="${e.mm}" y1="0" x2="${e.mm}" y2="${H}" class="g"/>`);
    gl.push(`<text x="${e.mm}" y="-1.6" text-anchor="middle" font-size="3.2" font-weight="700">${km2(e.value)}</text>`);
    gl.push(`<text x="${e.mm}" y="${H + 4.2}" text-anchor="middle" font-size="3.2" font-weight="700">${km2(e.value)}</text>`);
  }
  for (const n of ns) {
    gl.push(`<line x1="0" y1="${n.mm}" x2="${W}" y2="${n.mm}" class="g"/>`);
    gl.push(`<text x="-1.6" y="${n.mm + 1.1}" text-anchor="end" font-size="3.2" font-weight="700">${km2(n.value)}</text>`);
    gl.push(`<text x="${W + 1.6}" y="${n.mm + 1.1}" text-anchor="start" font-size="3.2" font-weight="700">${km2(n.value)}</text>`);
  }
  // 100 m ticks along all four frame edges
  const tick = [];
  for (let m = 0; m <= W; m += 4) {
    const long = Math.abs((m % 40) ) < 1e-9;
    if (!long) tick.push(`<line x1="${m}" y1="0" x2="${m}" y2="2" class="t"/><line x1="${m}" y1="${H}" x2="${m}" y2="${H - 2}" class="t"/>`);
  }
  for (let m = 0; m <= H; m += 4) {
    if (m % 40) tick.push(`<line x1="0" y1="${m}" x2="2" y2="${m}" class="t"/><line x1="${W}" y1="${m}" x2="${W - 2}" y2="${m}" class="t"/>`);
  }
  // 100 km square letters for the four corners
  const corner = (E, N) => { const p = utm.inv(E, N); return toMGRS(p.lat, p.lon, 0); };
  const squares = [...new Set([corner(s.e0 + 1, s.n0 + 1), corner(s.e0 + s.Wm - 1, s.n0 + 1), corner(s.e0 + 1, s.n0 + s.Hm - 1), corner(s.e0 + s.Wm - 1, s.n0 + s.Hm - 1)])];
  let outline = '';
  if (opts.outline && req.rings) {
    outline = req.rings.map((ring) => {
      const d = ring.map((p, i) => { const [E, N] = utm.fwd(p.lat, p.lon); const [x, y] = enToMm(s, E, N); return `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`; }).join(' ') + 'Z';
      return `<path d="${d}" fill="none" stroke="#1f6b2e" stroke-width="0.5" stroke-dasharray="2 1.2"/>`;
    }).join('');
  }
  // footer: scale bar (1 km = 40 mm, 100 m steps), 100 mm calibration line, declination diagram
  const fy = H + 16; // footer baseline relative to frame top
  let bar = `<text x="0" y="${fy - 1.5}" font-size="2.6">Scale 1:25 000. Grid squares are 1 km. 1 km = 40 mm.</text>`;
  for (let i = 0; i < 10; i++) bar += `<rect x="${i * 4}" y="${fy}" width="4" height="1.6" fill="${i % 2 ? '#fff' : '#000'}" stroke="#000" stroke-width="0.2"/>`;
  bar += `<text x="0" y="${fy + 5}" font-size="2.4" text-anchor="middle">0</text><text x="40" y="${fy + 5}" font-size="2.4" text-anchor="middle">1 km</text>`;
  const cal = `<line x1="50" y1="${fy + 0.8}" x2="150" y2="${fy + 0.8}" stroke="#000" stroke-width="0.35"/><line x1="50" y1="${fy - 1}" x2="50" y2="${fy + 2.6}" stroke="#000" stroke-width="0.35"/><line x1="150" y1="${fy - 1}" x2="150" y2="${fy + 2.6}" stroke="#000" stroke-width="0.35"/>
    <text x="100" y="${fy + 5}" font-size="2.4" text-anchor="middle">Calibration. This line must measure 100 mm.</text>`;
  const gm = opts.decl - gamma; // magnetic north relative to grid north, degrees east
  const dx = W - 24;
  const ar = (len, angle, label, dash) => {
    const a = (angle * Math.PI) / 180;
    return `<line x1="${dx}" y1="${fy + 12}" x2="${dx + Math.sin(a) * len}" y2="${fy + 12 - Math.cos(a) * len}" stroke="#000" stroke-width="0.35" ${dash ? 'stroke-dasharray="1 0.8"' : ''}/>
      <text x="${dx + Math.sin(a) * len + (label === 'GN' ? -1 : 1)}" y="${fy + 12 - Math.cos(a) * len - 0.6}" font-size="2.2" text-anchor="${label === 'GN' ? 'end' : 'start'}">${label}</text>`;
  };
  const decl = ar(10, 0, 'GN', false) + ar(10, gm, 'MN', true) +
    `<text x="${dx - 3}" y="${fy + 8}" font-size="2.4" text-anchor="end">G-M angle ${gm.toFixed(1)}° east</text>`;
  const title = `<text x="0" y="-9" font-size="4.2" font-weight="700">${esc(req.name || 'Course area')}</text>
    <text x="${W}" y="-9" font-size="3" text-anchor="end">Sheet ${idx + 1} of ${total}</text>
    <text x="0" y="${H + 10}" font-size="2.4">MGRS grid ${esc(squares.join(' / '))}. WGS84. Declination ${opts.decl}° east.</text>`;
  return `<section class="sheet" style="width:${f.paperW}mm;height:${f.paperH - 1}mm">
    <div class="frame" style="left:${left}mm;top:${top}mm;width:${W}mm;height:${H}mm">
      <div class="tiles" style="transform:matrix(${L.matrix.map((v) => v.toFixed(8)).join(',')})">${imgs}</div>
    </div>
    <svg class="overlay" style="left:${left}mm;top:${top}mm" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" overflow="visible">
      <style>.g{stroke:#8b1a1a;stroke-width:0.25}.t{stroke:#8b1a1a;stroke-width:0.25}</style>
      <clipPath id="c${idx}"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>
      <g clip-path="url(#c${idx})">${gl.filter((x) => x.startsWith('<line')).join('')}${tick.join('')}${outline}</g>
      ${gl.filter((x) => x.startsWith('<text')).join('')}
      <rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#000" stroke-width="0.4"/>
      ${title}${bar}${cal}${decl}
    </svg>
  </section>`;
}

for (const id of ['paper', 'orient', 'base', 'decl', 'outline']) $(id).addEventListener('change', render);
$('printBtn').onclick = () => window.print();
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
