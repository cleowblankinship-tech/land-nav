import { haversine, toMGRS, snapToMGRS, makeProjection, pointInRing, milesToM, mToMiles } from './geo.js';
import { buildPool, generateCourse, regeneratePoint, courseLength, mulberry32 } from './generate.js';
import { findBoundaries, fetchConstraints, searchPlace, bboxOfLL } from './osm.js';
import { DEFAULTS, makeCourse, encodeCourse, makePointIds, mgrs8, fmtLatLon } from './course.js';
import { createGridLayer } from './grid.js';
import { store } from './store.js';

const $ = (id) => document.getElementById(id);
const DRAFT_KEY = 'ln.setup.draft.v1';

// ------------------------------------------------------------------ state ---
const S = {
  name: '',
  boundary: null, // { rings:[[{lat,lon}]], holes:[[{lat,lon}]], label }
  start: null,
  points: [], // [{id,lat,lon}]
  settings: {
    n: DEFAULTS.n, miles: DEFAULTS.targetMiles, spacing: DEFAULTS.minSpacing, radius: DEFAULTS.radius,
    limit: DEFAULTS.limitMin, need: DEFAULTS.need, endAtStart: DEFAULTS.endAtStart,
    useTrails: true, trailMax: DEFAULTS.trailMax, offTrail: DEFAULTS.offTrailMin, edge: DEFAULTS.edgeBuffer,
  },
  constraints: null, // parsed OSM data for the current boundary
  constraintsKey: '',
  built: null, // last buildPool result
  warnings: {}, // point id -> text
};

const num = (id) => parseFloat($(id).value);
function readSettings() {
  const s = S.settings;
  s.n = Math.max(1, Math.min(12, Math.round(num('n')) || DEFAULTS.n));
  s.miles = Math.max(0.5, num('miles') || DEFAULTS.targetMiles);
  s.spacing = Math.max(50, num('spacing') || DEFAULTS.minSpacing);
  s.radius = Math.max(10, Math.min(100, num('radius') || DEFAULTS.radius));
  s.limit = Math.max(15, num('limit') || DEFAULTS.limitMin);
  s.need = Math.max(1, Math.min(s.n, Math.round(num('need')) || DEFAULTS.need));
  s.endAtStart = $('endAtStart').checked;
  s.useTrails = $('useTrails').checked;
  s.trailMax = Math.max(50, num('trailMax') || DEFAULTS.trailMax);
  s.offTrail = Math.max(0, isNaN(num('offTrail')) ? DEFAULTS.offTrailMin : num('offTrail'));
  s.edge = Math.max(0, isNaN(num('edge')) ? DEFAULTS.edgeBuffer : num('edge'));
  S.name = $('name').value.trim();
}
function writeSettings() {
  const s = S.settings;
  $('n').value = s.n; $('miles').value = s.miles; $('spacing').value = s.spacing; $('radius').value = s.radius;
  $('limit').value = s.limit; $('need').value = s.need; $('endAtStart').checked = s.endAtStart;
  $('useTrails').checked = s.useTrails; $('trailMax').value = s.trailMax; $('offTrail').value = s.offTrail; $('edge').value = s.edge;
  $('name').value = S.name;
}

function saveDraft() {
  readSettings();
  store.set(DRAFT_KEY, { name: S.name, boundary: S.boundary, start: S.start, points: S.points, settings: S.settings });
}
function loadDraft() {
  const d = store.get(DRAFT_KEY);
  if (!d) return;
  S.name = d.name || '';
  S.boundary = d.boundary || null;
  S.start = d.start || null;
  S.points = d.points || [];
  Object.assign(S.settings, d.settings || {});
}

// -------------------------------------------------------------------- map ---
const map = L.map('map', { zoomControl: true }).setView([38.8685, -104.7518], 14);
const bases = {
  'OpenTopoMap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)' }),
  'USGS Topo': L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: 'USGS The National Map' }),
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }),
  'USGS Imagery': L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: 'USGS The National Map' }),
};
bases['OpenTopoMap'].addTo(map);
const gridLayer = createGridLayer(map);
const boundaryLayer = L.layerGroup().addTo(map);
const exclLayer = L.layerGroup();
const trailLayer = L.layerGroup();
const courseLayer = L.layerGroup().addTo(map);
const drawLayer = L.layerGroup().addTo(map);
L.control.layers(bases, { 'MGRS grid': gridLayer, 'Course points': courseLayer }, { collapsed: true }).addTo(map);
L.control.scale({ imperial: true, metric: true }).addTo(map);

// ----------------------------------------------------------- helpers/UI ---
function status(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status small ' + kind;
}
let hintTimer;
function hint(msg) {
  const h = $('hint');
  clearTimeout(hintTimer);
  if (!msg) return h.classList.add('hidden');
  h.textContent = msg;
  h.classList.remove('hidden');
}
const ringXY = (ring, proj) => ring.map((p) => proj.toXY(p.lat, p.lon));
function boundaryContains(lat, lon) {
  if (!S.boundary) return true;
  const proj = makeProjection(S.boundary.rings[0][0]);
  const [x, y] = proj.toXY(lat, lon);
  return S.boundary.rings.some((r) => pointInRing(x, y, ringXY(r, proj)));
}

// ------------------------------------------------------------- boundary ---
function setBoundary(b, { fit = true } = {}) {
  S.boundary = b;
  S.constraints = null;
  S.constraintsKey = '';
  S.built = null;
  renderBoundary(fit);
  saveDraft();
}
function renderBoundary(fit) {
  boundaryLayer.clearLayers();
  const info = $('boundaryInfo');
  if (!S.boundary) {
    info.textContent = 'No boundary yet.';
    return;
  }
  const style = { color: '#1f6b2e', weight: 3, fillColor: '#3f4a1f', fillOpacity: 0.06, interactive: false };
  for (const r of S.boundary.rings) L.polygon(r.map((p) => [p.lat, p.lon]), style).addTo(boundaryLayer);
  for (const h of S.boundary.holes ?? []) L.polygon(h.map((p) => [p.lat, p.lon]), { ...style, color: '#a4161a', dashArray: '4 4', fillOpacity: 0.15 }).addTo(boundaryLayer);
  const bb = bboxOfLL(S.boundary.rings.flat());
  const proj = makeProjection({ lat: (bb[0] + bb[2]) / 2, lon: (bb[1] + bb[3]) / 2 });
  const w = Math.abs(proj.toXY(bb[0], bb[3])[0] - proj.toXY(bb[0], bb[1])[0]);
  const h = Math.abs(proj.toXY(bb[2], bb[1])[1] - proj.toXY(bb[0], bb[1])[1]);
  info.textContent = `${S.boundary.label || 'Custom boundary'} — about ${(w / 1000).toFixed(1)} × ${(h / 1000).toFixed(1)} km`;
  if (fit) map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: [20, 20] });
}

let drawing = null; // {pts:[], markers:[]}
let tapMode = null; // 'start' | 'draw'
function setMode(mode) {
  tapMode = mode;
  $('startBtn').classList.toggle('on', mode === 'start');
  $('drawBtn').classList.toggle('on', mode === 'draw');
  $('drawBtn').textContent = mode === 'draw' ? 'Finish polygon' : 'Draw polygon';
  map.getContainer().style.cursor = mode ? 'crosshair' : '';
  hint(mode === 'start' ? 'Tap the map to place the start point' : mode === 'draw' ? 'Tap to add corners, then “Finish polygon”' : '');
}
function finishDraw() {
  if (drawing && drawing.pts.length >= 3) {
    setBoundary({ rings: [drawing.pts.slice()], holes: [], label: 'Hand-drawn boundary' }, { fit: false });
  } else if (drawing && drawing.pts.length) {
    status('Need at least 3 corners.', 'warn');
  }
  drawLayer.clearLayers();
  drawing = null;
  setMode(null);
}
$('drawBtn').onclick = () => {
  if (tapMode === 'draw') return finishDraw();
  setMode('draw');
  drawing = { pts: [] };
  drawLayer.clearLayers();
};
$('startBtn').onclick = () => setMode(tapMode === 'start' ? null : 'start');
$('clearBoundary').onclick = () => { drawLayer.clearLayers(); drawing = null; setMode(null); setBoundary(null); };
$('viewBoxBtn').onclick = () => {
  const b = map.getBounds().pad(-0.1);
  const ring = [b.getSouthWest(), b.getSouthEast(), b.getNorthEast(), b.getNorthWest()].map((p) => ({ lat: p.lat, lon: p.lng }));
  setBoundary({ rings: [ring], holes: [], label: 'Map-view box' }, { fit: false });
};

map.on('click', (e) => {
  if (tapMode === 'start') {
    S.start = snapToMGRS({ lat: e.latlng.lat, lon: e.latlng.lng });
    setMode(null);
    S.built = null;
    renderAll();
    saveDraft();
  } else if (tapMode === 'draw') {
    drawing.pts.push({ lat: e.latlng.lat, lon: e.latlng.lng });
    drawLayer.clearLayers();
    L.polyline(drawing.pts.map((p) => [p.lat, p.lon]), { color: '#c2410c', weight: 3 }).addTo(drawLayer);
    drawing.pts.forEach((p) => L.circleMarker([p.lat, p.lon], { radius: 5, color: '#c2410c', fillOpacity: 1 }).addTo(drawLayer));
  }
});

// place search
$('placeGo').onclick = async () => {
  const q = $('placeQ').value.trim();
  if (!q) return;
  const box = $('placeRes');
  box.textContent = 'Searching…';
  try {
    const res = await searchPlace(q);
    box.innerHTML = '';
    if (!res.length) box.textContent = 'No matches.';
    for (const r of res) {
      const b = document.createElement('button');
      b.className = 'small';
      b.style.justifyContent = 'flex-start';
      b.textContent = r.name;
      b.onclick = () => {
        if (r.bbox) map.fitBounds([[r.bbox[0], r.bbox[2]], [r.bbox[1], r.bbox[3]]]);
        else map.setView([r.lat, r.lon], 14);
        box.innerHTML = '';
      };
      box.append(b);
    }
  } catch (e) {
    box.textContent = e.message;
  }
};
$('placeQ').addEventListener('keydown', (e) => e.key === 'Enter' && $('placeGo').click());

// boundaries from OSM
$('findParks').onclick = async () => {
  const box = $('boundaryRes');
  box.textContent = 'Asking OpenStreetMap…';
  const name = $('placeQ').value.trim();
  const b = map.getBounds();
  try {
    let res = await findBoundaries([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], name);
    if (!res.length && name) res = await findBoundaries([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], '');
    box.innerHTML = '';
    if (!res.length) {
      box.textContent = 'Nothing found in view. Zoom out a little, or draw a polygon.';
      return;
    }
    for (const c of res.slice(0, 12)) {
      const btn = document.createElement('button');
      btn.className = 'small';
      btn.style.justifyContent = 'flex-start';
      btn.style.textAlign = 'left';
      btn.textContent = `${c.name} (${c.kind}${c.operator ? ', ' + c.operator : ''})`;
      btn.onclick = () => {
        setBoundary({ rings: c.rings, holes: c.holes, label: c.name });
        if (!$('name').value) $('name').value = c.name;
        box.innerHTML = '';
      };
      box.append(btn);
    }
  } catch (e) {
    box.textContent = e.message;
  }
};

// --------------------------------------------------------------- course ---
function markerIcon(label, cls = '') {
  return L.divIcon({ className: '', html: `<div class="mk ${cls}">${label}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
}
function renderAll() {
  courseLayer.clearLayers();
  renderBoundary(false);
  if (S.start) {
    L.marker([S.start.lat, S.start.lon], { icon: markerIcon('S', 'start'), interactive: false }).addTo(courseLayer);
    $('startInfo').innerHTML = `<span class="coord">${mgrs8(S.start)}</span> · ${fmtLatLon(S.start)}`;
  } else $('startInfo').textContent = 'Not set (parking lot / trailhead).';
  if (S.start && S.points.length) {
    const seq = [S.start, ...S.points, ...(S.settings.endAtStart ? [S.start] : [])];
    L.polyline(seq.map((p) => [p.lat, p.lon]), { color: '#c2410c', weight: 2, dashArray: '6 6', interactive: false }).addTo(courseLayer);
  }
  S.points.forEach((p, i) => {
    const m = L.marker([p.lat, p.lon], { icon: markerIcon('P' + (i + 1), S.warnings[p.id] ? 'bad' : ''), draggable: true, title: p.id }).addTo(courseLayer);
    m.bindTooltip(`${p.id} · ${mgrs8(p)}`, { direction: 'top', offset: [0, -14] });
    m.on('dragend', () => onDrag(i, m.getLatLng()));
  });
  renderPointList();
  renderTotal();
  const fillTrails = $('showTrails').checked, fillExcl = $('showExcl').checked;
  exclLayer.clearLayers(); trailLayer.clearLayers();
  if (S.constraints) {
    if (fillExcl) {
      for (const a of S.constraints.avoidAreas) L.polygon(a.ring.map((p) => [p.lat, p.lon]), { color: '#a4161a', weight: 1, fillOpacity: 0.3, interactive: false }).addTo(exclLayer);
      for (const l of S.constraints.avoidLines) L.polyline(l.pts.map((p) => [p.lat, p.lon]), { color: '#a4161a', weight: 2, opacity: 0.7, interactive: false }).addTo(exclLayer);
    }
    if (fillTrails) for (const t of S.constraints.trails) L.polyline(t.pts.map((p) => [p.lat, p.lon]), { color: '#0b5d8a', weight: 2, opacity: 0.8, interactive: false }).addTo(trailLayer);
  }
  if (fillExcl) exclLayer.addTo(map); else exclLayer.remove();
  if (fillTrails) trailLayer.addTo(map); else trailLayer.remove();
}
$('showExcl').onchange = $('showTrails').onchange = renderAll;

function renderTotal() {
  const el = $('total');
  if (!S.start || !S.points.length) return el.classList.add('hidden');
  const total = courseLength(S.start, S.points, S.settings.endAtStart);
  const target = milesToM(S.settings.miles);
  const diff = ((total - target) / target) * 100;
  el.classList.remove('hidden', 'warn', 'ok');
  el.classList.add(Math.abs(diff) <= 10 ? 'ok' : 'warn');
  el.innerHTML = `<b>Straight-line: ${mToMiles(total).toFixed(2)} mi</b> (${(total / 1000).toFixed(2)} km) · target ${S.settings.miles} mi (${diff >= 0 ? '+' : ''}${diff.toFixed(0)}%)<br>
    <span class="small">Real walking is usually 1.2–1.5× straight-line ≈ ${(mToMiles(total) * 1.3).toFixed(1)} mi.</span>`;
}

function renderPointList() {
  const box = $('pts');
  box.innerHTML = '';
  S.points.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pt-row' + (S.warnings[p.id] ? ' warn' : '');
    row.innerHTML = `<div class="pt-badge">P${i + 1}</div>
      <div class="pt-main"><div class="m coord">${mgrs8(p)}</div>
      <div class="small muted">${p.id} · ${fmtLatLon(p)}</div>
      ${S.warnings[p.id] ? `<div class="small" style="color:var(--warn);font-weight:700">⚠ ${S.warnings[p.id]}</div>` : ''}</div>
      <div class="pt-actions"><button class="small icon" title="Regenerate this point" data-act="regen">↻</button><button class="small icon danger" title="Delete this point" data-act="del">✕</button></div>`;
    row.querySelector('[data-act=regen]').onclick = () => regen(i);
    row.querySelector('[data-act=del]').onclick = () => del(i);
    row.querySelector('.pt-main').onclick = () => map.panTo([p.lat, p.lon]);
    box.append(row);
  });
}

function validatePoints() {
  S.warnings = {};
  const sp = S.settings.spacing;
  S.points.forEach((p, i) => {
    const why = [];
    if (S.built) {
      const r = S.built.check(p.lat, p.lon);
      if (r) why.push(r === 'outside' ? 'outside the boundary' : r === 'edge' ? 'too close to the boundary edge' : `on/near excluded ground (${r})`);
    } else if (!boundaryContains(p.lat, p.lon)) why.push('outside the boundary');
    if (S.start && haversine(p, S.start) < sp) why.push('closer than min spacing to start');
    S.points.forEach((q, j) => { if (j !== i && haversine(p, q) < sp) why.push(`closer than min spacing to P${j + 1}`); });
    if (why.length) S.warnings[p.id] = [...new Set(why)].join('; ');
  });
}

function onDrag(i, ll) {
  S.points[i] = { ...S.points[i], ...snapToMGRS({ lat: ll.lat, lon: ll.lng }) };
  readSettings();
  ensureBuilt();
  validatePoints();
  renderAll();
  saveDraft();
  updateLink();
}
function del(i) {
  S.points.splice(i, 1);
  S.settings.n = S.points.length;
  $('n').value = S.points.length;
  S.settings.need = Math.min(S.settings.need, Math.max(1, S.points.length));
  $('need').value = S.settings.need;
  validatePoints();
  renderAll();
  saveDraft();
  updateLink();
}

// Fetch (and cache) OSM data for the boundary; build the sampling pool.
function boundaryKey() {
  return JSON.stringify(S.boundary?.rings?.[0]?.slice(0, 3)) + (S.boundary?.rings?.length ?? 0);
}
async function loadConstraints() {
  const key = boundaryKey();
  if (S.constraints && S.constraintsKey === key) return true;
  const bb = bboxOfLL(S.boundary.rings.flat(), 0.002);
  const approxKm2 = ((bb[2] - bb[0]) * 111) * ((bb[3] - bb[1]) * 111 * Math.cos((bb[0] * Math.PI) / 180));
  if (approxKm2 > 400 && !confirm(`That boundary's bounding box is about ${Math.round(approxKm2)} km². Loading map data may be slow or fail. Continue?\n(Tip: draw a smaller polygon inside it.)`)) return false;
  status('Loading OSM terrain data (water, buildings, trails, cliffs…)…');
  try {
    S.constraints = await fetchConstraints(bb);
    S.constraintsKey = key;
    const c = S.constraints.counts;
    status(`Map data loaded: ${S.constraints.trails.length} trail/road segments, ${S.constraints.avoidAreas.length} excluded areas.`, 'ok');
    return true;
  } catch (e) {
    S.constraints = null;
    if (confirm(`Couldn't load OSM data (${e.message}).\n\nGenerate using only the boundary? Points will NOT be checked against water, buildings, cliffs or trails.`)) {
      S.constraints = { avoidAreas: [], avoidLines: [], trails: [], counts: {}, empty: true };
      S.constraintsKey = '';
      return true;
    }
    return false;
  }
}
function ensureBuilt(seed = (Math.random() * 2 ** 32) >>> 0) {
  if (!S.boundary || !S.start) return null;
  const s = S.settings;
  const c = S.constraints ?? { avoidAreas: [], avoidLines: [], trails: [] };
  const rng = mulberry32(seed);
  const rings = S.boundary.rings;
  const holes = (S.boundary.holes ?? []).map((ring) => ({ ring, buffer: 10, kind: 'inholding' }));
  S.built = buildPool({
    boundary: { rings },
    start: S.start,
    constraints: { ...c, avoidAreas: [...c.avoidAreas, ...holes] },
    opts: {
      edgeBuffer: s.edge, rng,
      maxTrailDist: s.useTrails ? s.trailMax : null,
      minTrailDist: s.useTrails ? s.offTrail : 0,
    },
  });
  S.built.rng = rng;
  return S.built;
}

$('genBtn').onclick = async () => {
  readSettings();
  if (!S.boundary) return status('Set a boundary first (step 1).', 'warn');
  if (!S.start) return status('Set a start point first (step 2).', 'warn');
  $('genBtn').disabled = true;
  try {
    if (!(await loadConstraints())) return status('Cancelled.', 'warn');
    const built = ensureBuilt();
    await new Promise((r) => setTimeout(r, 20)); // let the status paint
    const s = S.settings;
    if (!built.pool.length) {
      const why = Object.entries(built.stats.rejected).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(', ');
      return status(`No valid ground found. Rejected — ${why}. Loosen the walkability filters or the boundary.`, 'bad');
    }
    const r = generateCourse({
      pool: built.pool, proj: built.proj, start: S.start, n: s.n, targetM: milesToM(s.miles),
      minSpacing: s.spacing, endAtStart: s.endAtStart, rng: built.rng,
    });
    if (!r.points.length) return status(r.reason, 'bad');
    const ids = makePointIds(r.points.length);
    S.points = r.points.map((p, i) => ({ id: ids[i], lat: p.lat, lon: p.lon }));
    validatePoints();
    renderAll();
    saveDraft();
    updateLink();
    const kept = built.stats.kept, grid = built.stats.grid;
    status(
      (r.ok ? '' : `Couldn't hit the target distance in this area (best ${(r.error * 100).toFixed(0)}% off) — try a bigger boundary or a shorter target. `) +
        `${kept} of ${grid} sampled spots were usable ground.`,
      r.ok ? 'ok' : 'warn',
    );
    const fit = L.latLngBounds([...S.points, S.start].map((p) => [p.lat, p.lon]));
    map.fitBounds(fit, { padding: [40, 40] });
  } finally {
    $('genBtn').disabled = false;
  }
};

function regen(i) {
  readSettings();
  const built = S.built ?? ensureBuilt();
  if (!built) return status('Set boundary and start first.', 'warn');
  const np = regeneratePoint({
    pool: built.pool, proj: built.proj, start: S.start, points: S.points, index: i,
    targetM: milesToM(S.settings.miles), minSpacing: S.settings.spacing, endAtStart: S.settings.endAtStart, rng: built.rng,
  });
  if (!np) return status('No other spot fits the spacing rules for that point.', 'warn');
  S.points[i] = { ...S.points[i], ...np };
  validatePoints();
  renderAll();
  saveDraft();
  updateLink();
}
$('addPt').onclick = () => {
  readSettings();
  const built = S.built ?? ensureBuilt();
  if (!built) return status('Set boundary and start first.', 'warn');
  const np = regeneratePoint({
    pool: built.pool, proj: built.proj, start: S.start, points: S.points, index: S.points.length,
    targetM: milesToM(S.settings.miles), minSpacing: S.settings.spacing, endAtStart: S.settings.endAtStart, rng: built.rng,
  });
  if (!np) return status('No spot left that satisfies the spacing rules.', 'warn');
  const existing = new Set(S.points.map((p) => p.id));
  let id;
  do { id = makePointIds(1)[0]; } while (existing.has(id));
  S.points.push({ id, ...np });
  S.settings.n = S.points.length;
  $('n').value = S.points.length;
  validatePoints();
  renderAll();
  saveDraft();
  updateLink();
};

// ---------------------------------------------------------- hand-over ---
function currentCourse() {
  readSettings();
  if (!S.start || !S.points.length) return null;
  const s = S.settings;
  return makeCourse({
    name: S.name || (S.boundary?.label ?? 'Course'),
    start: S.start, pts: S.points, ids: S.points.map((p) => p.id),
    radius: s.radius, limitMin: s.limit, endAtStart: s.endAtStart, need: s.need,
  });
}
function link(page) {
  const c = currentCourse();
  if (!c) return null;
  return new URL(page, location.href).href.replace(/[?#].*$/, '') + '#' + encodeCourse(c);
}
function updateLink() {
  $('linkOut').value = link('run.html') ?? '';
}
$('cardBtn').onclick = () => {
  const l = link('card.html');
  if (!l) return status('Generate a course first.', 'warn');
  window.open(l, '_blank');
};
$('copyLink').onclick = async () => {
  const l = link('run.html');
  if (!l) return status('Generate a course first.', 'warn');
  try { await navigator.clipboard.writeText(l); status('Course link copied.', 'ok'); }
  catch { $('linkOut').select(); status('Select and copy the link above.', 'warn'); }
};
$('shareLink').onclick = async () => {
  const l = link('run.html');
  if (!l) return status('Generate a course first.', 'warn');
  if (navigator.share) { try { await navigator.share({ title: 'Land nav course', url: l }); } catch { /* cancelled */ } }
  else $('copyLink').click();
};
$('linkOut').onclick = (e) => e.target.select();

// print the grid map without the course
let hiddenForPrint = false;
function hideCourse() {
  if (!hiddenForPrint) return;
  map.removeLayer(courseLayer);
  map.removeLayer(exclLayer);
  map.removeLayer(trailLayer);
}
$('printMap').onclick = () => {
  if (!map.hasLayer(gridLayer)) gridLayer.addTo(map);
  hiddenForPrint = true;
  hideCourse();
  map.invalidateSize();
  setTimeout(() => window.print(), 400);
};
window.addEventListener('afterprint', () => {
  if (!hiddenForPrint) return;
  hiddenForPrint = false;
  courseLayer.addTo(map);
  renderAll();
  map.invalidateSize();
});
window.addEventListener('beforeprint', () => map.invalidateSize());

// ------------------------------------------------------------------ init ---
loadDraft();
writeSettings();
renderAll();
updateLink();
if (S.boundary) {
  const bb = bboxOfLL(S.boundary.rings.flat());
  map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]]);
}
for (const id of ['n', 'miles', 'spacing', 'radius', 'limit', 'need', 'endAtStart', 'useTrails', 'trailMax', 'offTrail', 'edge', 'name']) {
  $(id).addEventListener('change', () => { readSettings(); S.built = null; saveDraft(); renderTotal(); updateLink(); });
}
if (!S.boundary) status('Tip: type “Palmer Park” above, press Go, then “Find park boundaries in view”.');
