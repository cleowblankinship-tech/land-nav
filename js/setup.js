import { haversine, toMGRS, snapToMGRS, makeProjection, pointInRing, milesToM, mToMiles } from './geo.js';
import { buildPool, generateCourse, regeneratePoint, courseLength, mulberry32 } from './generate.js';
import { findBoundaries, fetchConstraints, searchPlace, bboxOfLL } from './osm.js';
import { DEFAULTS, makeCourse, encodeCourse, makePointIds, mgrs8, fmtLatLon } from './course.js';
import { createGridLayer } from './grid.js';
import { store } from './store.js';
import { makeBases } from './basemaps.js';
import { Dem } from './dem.js';
import { listCourses, getCourse, saveCourse, deleteCourse, duplicateCourse, describeCourse, newId } from './library.js';

// If an element is missing (for example a stale cached page), keep going
// instead of letting one null take every button down with it.
const stub = (id) => {
  console.warn('Missing element #' + id);
  return { style: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, select() {}, value: '', checked: false, innerHTML: '', textContent: '' };
};
const $ = (id) => document.getElementById(id) ?? stub(id);
const DRAFT_KEY = 'ln.setup.draft.v1';

function defaultSettings() {
  return {
    n: DEFAULTS.n, miles: DEFAULTS.targetMiles, spacing: DEFAULTS.minSpacing, radius: DEFAULTS.radius,
    limit: DEFAULTS.limitMin, need: DEFAULTS.need, endAtStart: DEFAULTS.endAtStart,
    useSlope: true, maxSlope: DEFAULTS.maxSlope,
    useTrails: true, trailMax: DEFAULTS.trailMax, offTrail: DEFAULTS.offTrailMin, edge: DEFAULTS.edgeBuffer,
  };
}

// ------------------------------------------------------------------ state ---
const S = {
  id: null, // id in My courses once the course has points
  name: '',
  boundary: null, // { rings:[[{lat,lon}]], holes:[[{lat,lon}]], label }
  start: null,
  points: [], // [{id,lat,lon}]
  settings: defaultSettings(),

  constraints: null, // parsed OSM data for the current boundary
  constraintsKey: '',
  dem: null,
  demKey: '',
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
  s.useSlope = $('useSlope').checked;
  s.maxSlope = Math.max(5, Math.min(60, num('maxSlope') || DEFAULTS.maxSlope));
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
  $('useSlope').checked = s.useSlope; $('maxSlope').value = s.maxSlope;
  $('useTrails').checked = s.useTrails; $('trailMax').value = s.trailMax; $('offTrail').value = s.offTrail; $('edge').value = s.edge;
  $('name').value = S.name;
}

function saveDraft() {
  readSettings();
  store.set(DRAFT_KEY, { id: S.id, name: S.name, boundary: S.boundary, start: S.start, points: S.points, settings: S.settings });
  saveToLibrary();
}

// Every edit to a course that has points is saved into My courses.
function saveToLibrary() {
  if (!S.points.length || !S.start) return;
  if (!S.id) S.id = newId();
  const name = S.name || S.boundary?.label || 'Course';
  const ok = saveCourse({
    id: S.id, name, savedAt: Date.now(),
    data: { name, boundary: S.boundary, start: S.start, points: S.points, settings: S.settings },
  });
  if (!ok) status('Could not save this course. Browser storage is full. Delete an old course.', 'bad');
  renderLibrary();
}
function loadDraft() {
  const d = store.get(DRAFT_KEY);
  if (!d) return;
  S.id = d.id || null;
  S.name = d.name || '';
  S.boundary = d.boundary || null;
  S.start = d.start || null;
  S.points = d.points || [];
  Object.assign(S.settings, d.settings || {});
}

// -------------------------------------------------------------------- map ---
const map = L.map('map', { zoomControl: true, attributionControl: false }).setView([38.8685, -104.7518], 14);
L.control.attribution({ prefix: false }).addTo(map);
const bases = makeBases();
bases['OpenTopoMap'].addTo(map);
const gridLayer = createGridLayer(map);
const boundaryLayer = L.layerGroup().addTo(map);
const exclLayer = L.layerGroup();
const trailLayer = L.layerGroup();
const courseLayer = L.layerGroup().addTo(map);
const drawLayer = L.layerGroup().addTo(map);
L.control.layers(bases, { 'MGRS grid': gridLayer, 'Course points': courseLayer }, { collapsed: true }).addTo(map);
L.control.scale({ imperial: true, metric: true }).addTo(map);

// Phone layout: the map shrinks when you scroll the options so they get the screen,
// and grows while you're tapping on it.
const mainEl = document.querySelector('.setup-main');
const panelEl = document.querySelector('.panel');
let mapState = 'normal'; // 'normal' | 'compact' | 'full'
let mapPinned = false; // user chose a size with the handle; stop auto-resizing
function setMapState(st) {
  if (st === mapState) return;
  mapState = st;
  mainEl.classList.toggle('map-compact', st === 'compact');
  mainEl.classList.toggle('map-full', st === 'full');
  setTimeout(() => map.invalidateSize(), 300);
}
panelEl.addEventListener('scroll', () => {
  if (mapPinned || tapMode) return;
  if (panelEl.scrollTop > 60 && mapState === 'normal') setMapState('compact');
  else if (panelEl.scrollTop <= 0 && mapState === 'compact') setMapState('normal');
}, { passive: true });
$('mapToggle').onclick = () => {
  mapPinned = true;
  setMapState(mapState === 'full' ? 'compact' : 'full');
  if (mapState === 'full') panelEl.scrollTop = 0;
};

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
  S.dem = null;
  S.demKey = '';
  S.built = null;
  renderBoundary(fit);
  saveDraft();
}
function renderBoundary(fit) {
  boundaryLayer.clearLayers();
  const info = $('boundaryInfo');
  if (!S.boundary) {
    info.textContent = 'No area yet.';
    return;
  }
  const style = { color: '#1f6b2e', weight: 3, fillColor: '#3f4a1f', fillOpacity: 0.06, interactive: false };
  for (const r of S.boundary.rings) L.polygon(r.map((p) => [p.lat, p.lon]), style).addTo(boundaryLayer);
  for (const h of S.boundary.holes ?? []) L.polygon(h.map((p) => [p.lat, p.lon]), { ...style, color: '#a4161a', dashArray: '4 4', fillOpacity: 0.15 }).addTo(boundaryLayer);
  const bb = bboxOfLL(S.boundary.rings.flat());
  const proj = makeProjection({ lat: (bb[0] + bb[2]) / 2, lon: (bb[1] + bb[3]) / 2 });
  const w = Math.abs(proj.toXY(bb[0], bb[3])[0] - proj.toXY(bb[0], bb[1])[0]);
  const h = Math.abs(proj.toXY(bb[2], bb[1])[1] - proj.toXY(bb[0], bb[1])[1]);
  info.textContent = `${S.boundary.label || 'Custom area'}: about ${(w / 1000).toFixed(1)} by ${(h / 1000).toFixed(1)} km`;
  if (fit) map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: [20, 20] });
}

let drawing = null; // {pts:[], markers:[]}
let tapMode = null; // 'start' | 'draw'
function setMode(mode) {
  tapMode = mode;
  $('startBtn').classList.toggle('on', mode === 'start');
  $('startBtn').textContent = mode === 'start' ? 'Tap the map' : 'Set start';
  $('drawBtn').classList.toggle('on', mode === 'draw');
  $('drawBtn').textContent = mode === 'draw' ? 'Finish area' : 'Draw area';
  map.getContainer().style.cursor = mode ? 'crosshair' : '';
  $('drawTools').classList.toggle('hidden', mode !== 'draw');
  if (mode) { mapPinned = false; setMapState('full'); } else if (mapState === 'full' && !mapPinned) setMapState('normal');
  hint(mode === 'start' ? 'Tap the map to set the start' : mode === 'draw' ? 'Tap to add corners, then tap Finish' : '');
}
// Once a boundary exists, go straight to "tap to place the start" (if none yet).
function afterBoundary() {
  if (S.start) { setMode(null); return; }
  panelEl.scrollTop = 0;
  setMode('start');
}
function finishDraw() {
  if (drawing && drawing.pts.length >= 3) {
    setBoundary({ rings: [drawing.pts.slice()], holes: [], label: 'Drawn area' }, { fit: false });
    afterBoundary();
    drawLayer.clearLayers();
    drawing = null;
    return;
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
  setBoundary({ rings: [ring], holes: [], label: 'Map view' }, { fit: false });
  afterBoundary();
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
    L.polyline(drawing.pts.map((p) => [p.lat, p.lon]), { color: '#2f3a14', weight: 3 }).addTo(drawLayer);
    drawing.pts.forEach((p) => L.circleMarker([p.lat, p.lon], { radius: 5, color: '#2f3a14', fillOpacity: 1 }).addTo(drawLayer));
  }
});

// ------------------------------------------------------------ My courses ---
function renderLibrary() {
  const box = $('libList');
  const all = listCourses();
  $('libEmpty').classList.toggle('hidden', all.length > 0);
  if (!box.appendChild) return;
  box.innerHTML = '';
  for (const c of all) {
    const row = document.createElement('div');
    row.className = 'pt-row';
    row.style.gridTemplateColumns = '1fr auto';
    const current = c.id === S.id;
    row.innerHTML = `<div class="pt-main"><div class="m">${escHtml(c.name)}</div>
      <div class="small muted">${describeCourse(c)}${current ? ', editing now' : ''}</div></div>
      <div class="pt-actions"><button class="small" data-act="open">${current ? 'Reload' : 'Open'}</button>
      <button class="small" data-act="copy">Copy</button>
      <button class="small danger" data-act="del">Delete</button></div>`;
    row.querySelector('[data-act=open]').onclick = () => openCourse(c.id);
    row.querySelector('[data-act=copy]').onclick = () => { const cp = duplicateCourse(c.id); renderLibrary(); if (cp) status(`Copied as ${cp.name}.`, 'ok'); };
    row.querySelector('[data-act=del]').onclick = () => {
      if (!confirm(`Delete ${c.name}?`)) return;
      deleteCourse(c.id);
      if (S.id === c.id) S.id = null;
      saveDraftOnly();
      renderLibrary();
    };
    box.append(row);
  }
}
const escHtml = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
function saveDraftOnly() {
  readSettings();
  store.set(DRAFT_KEY, { id: S.id, name: S.name, boundary: S.boundary, start: S.start, points: S.points, settings: S.settings });
}

function openCourse(id) {
  const c = getCourse(id);
  if (!c) return status('That course is gone.', 'warn');
  if (!S.id && (S.boundary || S.start) && !S.points.length && !confirm('Replace what is on the screen?')) return;
  cancelDraw();
  const d = c.data;
  Object.assign(S, {
    id: c.id, name: d.name || c.name, boundary: d.boundary || null, start: d.start || null,
    points: d.points || [], settings: { ...defaultSettings(), ...(d.settings || {}) },
    constraints: null, constraintsKey: '', dem: null, demKey: '', built: null, warnings: {},
  });
  writeSettings();
  $('boundaryRes').innerHTML = '';
  $('placeRes').innerHTML = '';
  renderAll();
  updateLink();
  saveDraftOnly();
  renderLibrary();
  if (S.boundary) {
    const bb = bboxOfLL(S.boundary.rings.flat());
    map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: [20, 20] });
  } else if (S.start) map.setView([S.start.lat, S.start.lon], 14);
  status(`Opened ${c.name}. Edits save automatically.`, 'ok');
  $('libBox').open = false;
  panelEl.scrollTop = 0;
}

// ------------------------------------------------------- clear / restart ---
function cancelDraw() {
  drawLayer.clearLayers();
  drawing = null;
  setMode(null);
}
$('undoCorner').onclick = () => {
  if (!drawing) return;
  drawing.pts.pop();
  drawLayer.clearLayers();
  if (drawing.pts.length) {
    L.polyline(drawing.pts.map((p) => [p.lat, p.lon]), { color: '#2f3a14', weight: 3 }).addTo(drawLayer);
    drawing.pts.forEach((p) => L.circleMarker([p.lat, p.lon], { radius: 5, color: '#2f3a14', fillOpacity: 1 }).addTo(drawLayer));
  }
};
$('cancelDraw').onclick = cancelDraw;

function clearPoints(msg = 'Points cleared.') {
  S.points = [];
  S.warnings = {};
  renderAll();
  saveDraft();
  updateLink();
  status(msg, 'ok');
}
$('clearPts').onclick = () => {
  if (!S.points.length) return status('No points to clear.');
  clearPoints();
};
$('clearStart').onclick = () => {
  S.start = null;
  S.built = null;
  S.points = [];
  S.warnings = {};
  renderAll();
  saveDraft();
  updateLink();
  status('Start point and points cleared.', 'ok');
};
$('startOver').onclick = () => {
  if ((S.boundary || S.start || S.points.length) && !confirm('Start over? This clears the area, start, points and settings.')) return;
  cancelDraw();
  store.del(DRAFT_KEY);
  Object.assign(S, {
    id: null, name: '', boundary: null, start: null, points: [], settings: defaultSettings(),
    constraints: null, constraintsKey: '', dem: null, demKey: '', built: null, warnings: {},
  });
  writeSettings();
  $('placeQ').value = '';
  $('placeRes').innerHTML = '';
  $('boundaryRes').innerHTML = '';
  $('showExcl').checked = false;
  $('showTrails').checked = false;
  renderAll();
  updateLink();
  status('Cleared.', 'ok');
};

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
  box.textContent = 'Searching…';
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
      btn.textContent = c.name;
      btn.onclick = () => {
        setBoundary({ rings: c.rings, holes: c.holes, label: c.name });
        if (!$('name').value) $('name').value = c.name;
        box.innerHTML = '';
        afterBoundary();
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
  } else $('startInfo').textContent = 'Not set.';
  $('clearStart').classList.toggle('hidden', !S.start);
  if (S.start && S.points.length) {
    const seq = [S.start, ...S.points, ...(S.settings.endAtStart ? [S.start] : [])];
    L.polyline(seq.map((p) => [p.lat, p.lon]), { color: '#1c2410', weight: 2.5, dashArray: '7 6', interactive: false }).addTo(courseLayer);
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
  el.innerHTML = `<b>${mToMiles(total).toFixed(2)} miles in a straight line</b><br>
    Target ${S.settings.miles} miles, ${diff >= 0 ? '+' : ''}${diff.toFixed(0)}%. Walking will be about ${(mToMiles(total) * 1.3).toFixed(1)} miles.`;
}

function renderPointList() {
  const box = $('pts');
  box.innerHTML = '';
  S.points.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pt-row' + (S.warnings[p.id] ? ' warn' : '');
    row.innerHTML = `<div class="pt-badge">P${i + 1}</div>
      <div class="pt-main"><div class="m coord">${mgrs8(p)}</div>
      <div class="small muted">${p.id} · ${fmtLatLon(p)}${terrainText(p)}</div>
      ${S.warnings[p.id] ? `<div class="small" style="color:var(--warn);font-weight:700">⚠ ${S.warnings[p.id]}</div>` : ''}</div>
      <div class="pt-actions"><button class="small icon" title="Regenerate this point" data-act="regen">↻</button><button class="small icon danger" title="Delete this point" data-act="del">✕</button></div>`;
    row.querySelector('[data-act=regen]').onclick = () => regen(i);
    row.querySelector('[data-act=del]').onclick = () => del(i);
    row.querySelector('.pt-main').onclick = () => map.panTo([p.lat, p.lon]);
    box.append(row);
  });
}

function terrainText(p) {
  if (!S.dem) return '';
  const el = S.dem.elevation(p.lat, p.lon);
  const sl = S.dem.slope(p.lat, p.lon);
  if (Number.isNaN(el)) return '';
  return `<br>${Math.round(el * 3.28084).toLocaleString()} ft${sl != null ? `, slope ${sl.toFixed(0)}°` : ''}`;
}

function validatePoints() {
  S.warnings = {};
  const sp = S.settings.spacing;
  S.points.forEach((p, i) => {
    const why = [];
    if (S.built) {
      const r = S.built.check(p.lat, p.lon);
      if (r) why.push(r === 'steep ground' ? 'steep ground' : r === 'outside' ? 'outside the area' : r === 'edge' ? 'too close to the edge' : `too close to ${r}`);
    } else if (!boundaryContains(p.lat, p.lon)) why.push('outside the area');
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
  if (approxKm2 > 400 && !confirm(`That area is about ${Math.round(approxKm2)} square km. Loading map data may be slow or fail. Continue?\n\nTip: draw a smaller area inside it.`)) return false;
  status('Loading map data…');
  try {
    S.constraints = await fetchConstraints(bb);
    S.constraintsKey = key;
    status(`Map data loaded. ${S.constraints.trails.length} trails and roads, ${S.constraints.avoidAreas.length} avoided areas.`, 'ok');
    return true;
  } catch (e) {
    S.constraints = null;
    if (confirm(`Could not load map data: ${e.message}\n\nGenerate using only the area? Points will not be checked for water, buildings, cliffs or trails.`)) {
      S.constraints = { avoidAreas: [], avoidLines: [], trails: [], counts: {}, empty: true };
      S.constraintsKey = '';
      return true;
    }
    return false;
  }
}
async function loadDem() {
  const key = boundaryKey();
  if (S.dem && S.demKey === key) return true;
  const bb = bboxOfLL(S.boundary.rings.flat(), 0.002);
  status('Loading elevation data…');
  try {
    S.dem = await Dem.load(bb);
    S.demKey = key;
    return true;
  } catch (e) {
    S.dem = null;
    return confirm(`Could not load elevation data: ${e.message}\n\nGenerate without the slope filter? Points may land on steep ground.`);
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
      maxSlope: s.useSlope && S.dem ? s.maxSlope : null,
      slopeFn: S.dem ? (lat, lon) => S.dem.maxSlope(lat, lon) : null,
      maxTrailDist: s.useTrails ? s.trailMax : null,
      minTrailDist: s.useTrails ? s.offTrail : 0,
    },
  });
  S.built.rng = rng;
  return S.built;
}

$('genBtn').onclick = async () => {
  readSettings();
  if (!S.boundary) return status('Set an area first.', 'warn');
  if (!S.start) return status('Set a start point first.', 'warn');
  $('genBtn').disabled = true;
  try {
    if (!(await loadConstraints())) return status('Cancelled.', 'warn');
    if (S.settings.useSlope && !(await loadDem())) return status('Cancelled.', 'warn');
    const built = ensureBuilt();
    await new Promise((r) => setTimeout(r, 20)); // let the status paint
    const s = S.settings;
    if (!built.pool.length) {
      const why = Object.entries(built.stats.rejected).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(', ');
      return status(`No valid ground found. Rejected: ${why}. Loosen the terrain filters or use a bigger area.`, 'bad');
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
      (r.ok ? '' : `Could not reach the target distance here. Best was ${(r.error * 100).toFixed(0)}% off. Try a bigger area or a shorter distance. `) +
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
  if (!built) return status('Set an area and start first.', 'warn');
  const np = regeneratePoint({
    pool: built.pool, proj: built.proj, start: S.start, points: S.points, index: i,
    targetM: milesToM(S.settings.miles), minSpacing: S.settings.spacing, endAtStart: S.settings.endAtStart, rng: built.rng,
  });
  if (!np) return status('No other spot fits for that point.', 'warn');
  S.points[i] = { ...S.points[i], ...np };
  validatePoints();
  renderAll();
  saveDraft();
  updateLink();
}
$('addPt').onclick = () => {
  readSettings();
  const built = S.built ?? ensureBuilt();
  if (!built) return status('Set an area and start first.', 'warn');
  const np = regeneratePoint({
    pool: built.pool, proj: built.proj, start: S.start, points: S.points, index: S.points.length,
    targetM: milesToM(S.settings.miles), minSpacing: S.settings.spacing, endAtStart: S.settings.endAtStart, rng: built.rng,
  });
  if (!np) return status('No spot left that fits.', 'warn');
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

// exact scale 1:25,000 print sheets (no course points)
$('printMap').onclick = () => {
  let bbox, rings = null;
  if (S.boundary) {
    bbox = bboxOfLL(S.boundary.rings.flat(), 0.002);
    rings = S.boundary.rings;
  } else if (S.start) {
    bbox = bboxOfLL([S.start], 0.015);
  } else {
    return status('Set an area or a start first.', 'warn');
  }
  readSettings();
  store.set('ln.printreq', { name: S.name || S.boundary?.label || 'Course area', bbox, rings });
  window.open('printmap.html', '_blank');
};

// ------------------------------------------------------------------ init ---
loadDraft();
writeSettings();
renderAll();
renderLibrary();
if (listCourses().length) $('libBox').open = true;
updateLink();
if (S.boundary) {
  const bb = bboxOfLL(S.boundary.rings.flat());
  map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]]);
}
for (const id of ['n', 'miles', 'spacing', 'radius', 'limit', 'need', 'endAtStart', 'useSlope', 'maxSlope', 'useTrails', 'trailMax', 'offTrail', 'edge', 'name']) {
  $(id).addEventListener('change', () => { readSettings(); S.built = null; saveDraft(); renderTotal(); updateLink(); });
}
if (!S.boundary) status('Search a place, then tap Find park boundaries.');
