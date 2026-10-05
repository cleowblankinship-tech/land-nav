// Results screen, reveal map, GPX export and GPX backup scoring.
import { haversine, toMGRS } from './geo.js';
import { fmtDuration, mgrs8 } from './course.js';
import { buildGPX, parseGPX, scoreTrack } from './gpx.js';
import { makeBases } from './basemaps.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Summarise a run against its course. */
export function computeResults(course, run) {
  const limitSec = course.limitMin * 60;
  const finds = course.pts
    .map((p, i) => ({ p, i, f: run.found[p.id] }))
    .filter((x) => x.f)
    .sort((a, b) => a.f.t - b.f.t);
  let prev = run.startedAt;
  const rows = course.pts.map((p, i) => ({ p, i, f: run.found[p.id], elapsed: null, split: null, late: false }));
  for (const x of finds) {
    const row = rows[x.i];
    row.elapsed = (x.f.t - run.startedAt) / 1000;
    row.split = (x.f.t - prev) / 1000;
    row.late = row.elapsed > limitSec;
    prev = x.f.t;
  }
  const valid = rows.filter((r) => r.f && !r.late).length;
  const end = run.endedAt ?? Date.now();
  const checkins = run.checkins ?? [];
  return {
    rows,
    found: rows.filter((r) => r.f).length,
    valid,
    pass: valid >= course.need,
    totalSec: (end - run.startedAt) / 1000,
    limitSec,
    misses: checkins.filter((c) => c.result === 'miss').length,
    inconclusive: checkins.filter((c) => c.result === 'poor').length,
    checkins: checkins.length,
  };
}

export function resultsText(course, run) {
  const r = computeResults(course, run);
  const lines = [
    `${course.name}: ${r.pass ? 'PASS' : 'FAIL'}. ${r.valid} of ${course.pts.length} found within time, need ${course.need}.`,
    `Total time ${fmtDuration(r.totalSec)} of ${fmtDuration(r.limitSec)} · missed check-ins ${r.misses}`,
  ];
  for (const x of r.rows) {
    lines.push(`P${x.i + 1} ${x.p.id}: ${x.f ? `${fmtDuration(x.elapsed)} (split ${fmtDuration(x.split)})${x.late ? ' LATE' : ''}` : 'not found'}`);
  }
  return lines.join('\n');
}

const icon = (label, cls) => L.divIcon({ className: '', html: `<div class="mk ${cls}">${label}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
const dot = (ll, color, text, r = 5) => L.circleMarker(ll, { radius: r, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 1 }).bindTooltip(text);

/** Map revealing the true points (and, if given, check-ins and the track). */
export function createRevealMap(el, course, { found = {}, checkins = [], track = [] } = {}) {
  const map = L.map(el, { attributionControl: false }).setView([course.start.lat, course.start.lon], 14);
  L.control.attribution({ prefix: false }).addTo(map);
  const bases = makeBases();
  bases['OpenTopoMap'].addTo(map);
  L.control.layers(bases, {}, { collapsed: true }).addTo(map);
  L.control.scale({ imperial: true, metric: true }).addTo(map);
  const bounds = L.latLngBounds([[course.start.lat, course.start.lon]]);
  L.marker([course.start.lat, course.start.lon], { icon: icon('S', 'start') }).bindTooltip('Start ' + mgrs8(course.start)).addTo(map);
  course.pts.forEach((p, i) => {
    const ok = !!found[p.id];
    L.circle([p.lat, p.lon], { radius: course.radius, color: ok ? '#1f6b2e' : '#a4161a', weight: 2, fillOpacity: 0.12 }).addTo(map);
    L.marker([p.lat, p.lon], { icon: icon('P' + (i + 1), ok ? 'ok' : 'bad') }).bindTooltip(`${p.id} · ${mgrs8(p)}${ok ? ' · found' : ' · not found'}`).addTo(map);
    bounds.extend([p.lat, p.lon]);
  });
  let trackLine = null;
  const api = {
    map,
    setTrack(points, color = '#0b5d8a') {
      if (trackLine) trackLine.remove();
      if (!points.length) return;
      // break the line at segment boundaries
      const segs = [];
      for (const q of points) {
        const s = q.seg ?? 0;
        (segs[s] ??= []).push([q.lat, q.lon]);
      }
      trackLine = L.layerGroup(segs.filter(Boolean).map((s) => L.polyline(s, { color, weight: 3, opacity: 0.85 }))).addTo(map);
      points.forEach((q) => bounds.extend([q.lat, q.lon]));
      map.fitBounds(bounds, { padding: [24, 24] });
    },
  };
  if (track.length) api.setTrack(track.map((t) => ({ lat: t[1], lon: t[2], seg: 0 })));
  for (const c of checkins) {
    const color = { hit: '#1f6b2e', miss: '#666', poor: '#c27a00', already: '#0b5d8a' }[c.result] ?? '#666';
    dot([c.lat, c.lon], color, `${clock(c.t)} · ${c.result}${c.pid ? ' ' + c.pid : ''} · ±${Math.round(c.acc)} m${c.nearestM != null ? ` · nearest point ${Math.round(c.nearestM)} m` : ''}`, c.result === 'hit' ? 7 : 5).addTo(map);
    bounds.extend([c.lat, c.lon]);
  }
  map.fitBounds(bounds, { padding: [24, 24] });
  return api;
}

function download(name, text, type = 'application/gpx+xml') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** The full results screen. `track` is [[t,lat,lon,acc],...]. */
export function renderResults(root, course, run, track, { onNew } = {}) {
  const r = computeResults(course, run);
  root.innerHTML = `
    <div class="result ${r.pass ? 'found' : 'bad'}">${r.pass ? 'PASS' : 'FAIL'}: ${r.valid} of ${course.pts.length} found within time<div class="small" style="font-weight:600">Standard: ${course.need} of ${course.pts.length} within ${fmtDuration(r.limitSec)}</div></div>
    <div class="card stat3">
      <div><div class="v">${r.found}/${course.pts.length}</div><div class="k">Found</div></div>
      <div><div class="v ${r.totalSec > r.limitSec ? 'fail' : ''}">${fmtDuration(r.totalSec)}</div><div class="k">Total time</div></div>
      <div><div class="v">${r.misses}</div><div class="k">Misses</div></div>
    </div>
    ${r.inconclusive ? `<div class="small muted">${r.inconclusive} check ins had weak GPS and were not counted as misses.</div>` : ''}
    <div class="card"><table class="tbl">
      <tr><th>Pt</th><th>ID</th><th>Result</th><th>Time</th><th>Split</th></tr>
      ${r.rows.map((x) => `<tr><td><b>P${x.i + 1}</b></td><td class="mono">${esc(x.p.id)}</td>
        <td class="${x.f ? (x.late ? 'fail' : 'pass') : 'fail'}">${x.f ? (x.late ? 'Late' : 'Found') : 'Not found'}</td>
        <td class="mono">${x.f ? fmtDuration(x.elapsed) : ''}</td><td class="mono">${x.f ? fmtDuration(x.split) : ''}</td></tr>`).join('')}
    </table></div>
    <h2>Reveal map</h2>
    <div id="resmap"></div>
    <div class="small muted" style="margin:6px 0">Circles show the check in radius. Green dots are finds, grey are misses, orange are weak GPS. The blue line is your track.</div>
    <div class="row">
      <button id="expGpx">Save track</button>
      <button id="copyRes">Copy results</button>
    </div>
    <div id="scoreBox"></div>
    <p><button id="newRun" class="danger" style="width:100%">Start a new run</button></p>`;
  const found = run.found ?? {};
  const rev = createRevealMap(root.querySelector('#resmap'), course, { found, checkins: run.checkins ?? [], track });
  root.querySelector('#expGpx').onclick = () => {
    if (!track.length) return alert('No track was recorded for this run.');
    download(`landnav-${new Date(run.startedAt).toISOString().slice(0, 10)}.gpx`, buildGPX(track.map((t) => ({ t: t[0], lat: t[1], lon: t[2] })), course.name));
  };
  root.querySelector('#copyRes').onclick = async (e) => {
    try { await navigator.clipboard.writeText(resultsText(course, run)); e.target.textContent = 'Copied ✓'; }
    catch { prompt('Copy:', resultsText(course, run)); }
  };
  root.querySelector('#newRun').onclick = () => onNew?.();
  renderGpxScoring(root.querySelector('#scoreBox'), course, { rev, startMs: run.startedAt });
}

/** GPX backup scoring panel. `rev` (optional) is a reveal-map API to draw the track on. */
export function renderGpxScoring(root, course, { rev = null, startMs = null } = {}) {
  root.innerHTML = `
    <div class="card">
      <h2>Score a GPX file</h2>
      <p class="small muted">Use this if the phone GPS was unreliable. Upload a track from Strava or a watch.</p>
      <input id="gpxFile" type="file" accept=".gpx,application/gpx+xml,text/xml,application/xml">
      <div id="gpxOut"></div>
    </div>`;
  const out = root.querySelector('#gpxOut');
  root.querySelector('#gpxFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const g = parseGPX(await file.text());
      if (!g.points.length) throw new Error('No track points found in that file.');
      const res = scoreTrack(g.points, course.pts, course.radius);
      const timed = g.points.find((p) => p.t != null);
      // use the run's own start if the file overlaps it, otherwise the file's first timestamp
      const sameDay = startMs != null && timed && Math.abs(timed.t - startMs) < 12 * 3600e3;
      const start = sameDay ? startMs : timed?.t ?? null;
      const limitMs = course.limitMin * 60000;
      const hits = res.filter((x) => x.hit);
      const valid = hits.filter((x) => start == null || x.t == null || x.t - start <= limitMs).length;
      out.innerHTML = `
        <div class="result ${valid >= course.need ? 'found' : 'bad'}" style="font-size:1.1rem">${valid >= course.need ? 'PASS' : 'FAIL'}: track passed within ${course.radius} m of ${hits.length} of ${course.pts.length} points${hits.length !== valid ? `, ${valid} within the time limit` : ''}</div>
        <table class="tbl"><tr><th>Pt</th><th>ID</th><th>Passed?</th><th>Closest</th><th>Time</th></tr>
        ${res.map((x, i) => `<tr><td><b>P${i + 1}</b></td><td class="mono">${esc(x.id)}</td><td class="${x.hit ? 'pass' : 'fail'}">${x.hit ? 'Yes' : 'No'}</td>
          <td class="mono">${Math.round(x.minDist)} m</td>
          <td class="mono">${x.hit && x.t != null ? `${clock(x.t)}${start != null ? `, ${fmtDuration((x.t - start) / 1000)}` : ''}` : ''}</td></tr>`).join('')}</table>
        <p class="small muted">${g.points.length} track points${timed ? '' : ', no timestamps so no times shown'}. Elapsed time counts from ${sameDay ? 'the run start' : 'the first track point'}.</p>`;
      rev?.setTrack(g.points, '#7a1fa2');
    } catch (err) {
      out.innerHTML = `<div class="banner bad">${esc(err.message)}</div>`;
    }
  };
}
