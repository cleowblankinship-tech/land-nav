// Navigator mode. NO map and NO "you are here" while a run is active.
import { decodeCourse, mgrs8, fmtDuration } from './course.js';
import { averageFixes, evaluateCheckin } from './checkin.js';
import { haversine, bearing, compassPoint, toMGRS } from './geo.js';
import { renderResults } from './results.js';
import { store } from './store.js';

const RUN_KEY = 'ln.run';
const TRACK_KEY = 'ln.track';
const PLAN_KEY = 'ln.plan';
const CHECKIN_MS = 8000; // collect fixes for this long...
const CHECKIN_MAX_MS = 15000; // ...up to this long if fixes are slow

const app = document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let course = null;
let run = null;
let track = [];
let timer = null;
let watchId = null;
let wakeLock = null;
let audioCtx = null;
let busy = false;
const fixListeners = new Set(); // check-in windows listening to the shared GPS watch

// ---------------------------------------------------------------- state ----
const saveRun = () => store.set(RUN_KEY, run);
const saveTrack = () => store.set(TRACK_KEY, track);
const active = () => run && run.startedAt && !run.endedAt;

// ---------------------------------------------------------------- views ----
function showEnterCode(msg = '') {
  document.getElementById('topTitle').textContent = 'Run a course';
  app.innerHTML = `
    <div class="card"><h2>Open a course</h2>
      ${msg ? `<div class="banner bad">${esc(msg)}</div>` : ''}
      <p class="muted">Open your course link, or paste it here.</p>
      <label>Course link<input id="code" type="text" placeholder="https://…/run.html#…"></label>
      <p><button id="go" class="primary" style="width:100%">Open course</button></p></div>`;
  document.getElementById('go').onclick = () => {
    try {
      course = decodeCourse(document.getElementById('code').value);
      store.set(PLAN_KEY, course.code);
      showPlan();
    } catch (e) { showEnterCode(e.message); }
  };
}

function limitText(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h${m ? ' ' + m + ' min' : ''}` : `${m} min`;
}

function showPlan() {
  document.getElementById('topTitle').textContent = 'Plan';
  const prevRun = run && run.endedAt && run.code === course.code ? run : null;
  app.innerHTML = `
    <h1>${esc(course.name)}</h1>
    <div class="card">
      <div class="small muted">START POINT</div>
      <div class="mg mono" style="font-size:1.4rem;font-weight:800">${mgrs8(course.start)}</div>
      <div class="small muted" style="margin-top:6px">${course.pts.length} points · ${limitText(course.limitMin)} · check-in radius ${course.radius} m · pass with ${course.need} of ${course.pts.length}</div>
    </div>
    <div class="plist">${course.pts.map((p, i) => `
      <div class="prow"><div class="lbl">P${i + 1}</div>
        <div><div class="mg">${mgrs8(p)}</div><div class="pid">ID ${esc(p.id)}</div></div><div></div></div>`).join('')}</div>
    <div class="banner">Plot your points first. The clock starts when you press the button. The screen stays on and a GPS track is recorded. No map is shown while you run.</div>
    <button id="start" class="primary" style="width:100%;min-height:84px;font-size:1.4rem">START CLOCK</button>
    <div id="startMsg"></div>
    <button id="practice" style="width:100%;margin-top:10px">Practice mode</button>
    <div class="small muted" style="text-align:center">Shows distance and direction to each point. Not scored.</div>
    ${prevRun ? `<div class="card"><div class="small muted">Starting replaces your last results for this course.</div>
      <button id="lastRes" style="width:100%;margin-top:8px">View last results</button></div>` : ''}`;
  document.getElementById('start').onclick = startRun;
  document.getElementById('practice').onclick = showPractice;
  if (prevRun) document.getElementById('lastRes').onclick = showResults;
}

// ------------------------------------------------------------ practice ----
// Learning aid, deliberately separate from a real run: live distance and
// bearing to every point plus your own MGRS. Nothing is scored or saved.
let practiceWatch = null;
let practiceTimer = null;

function stopPractice() {
  if (practiceWatch != null) navigator.geolocation.clearWatch(practiceWatch);
  practiceWatch = null;
  clearInterval(practiceTimer);
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}

function showPractice() {
  document.getElementById('topTitle').textContent = 'Practice';
  const decl = store.get('ln.decl', 7);
  app.innerHTML = `
    <div class="banner warn"><b>Practice mode.</b> Not scored and nothing is saved. Use it to check your plotting and your compass work.</div>
    <div class="card"><div class="small muted">YOU ARE AT</div>
      <div class="mono" id="me" style="font-size:1.4rem;font-weight:800">Finding GPS…</div>
      <div class="small muted" id="acc"></div></div>
    <label>Declination in degrees east, from your map
      <input id="decl" type="number" step="0.5" inputmode="decimal" value="${decl}"></label>
    <div class="small muted">Magnetic bearing is true bearing minus declination.</div>
    <div class="plist" id="pp"></div>
    <button id="stopPractice" class="primary" style="width:100%">Done</button>`;
  let fix = null;
  document.getElementById('decl').onchange = (e) => { store.set('ln.decl', parseFloat(e.target.value) || 0); draw(); };
  const draw = () => {
    if (!fix) return;
    const d = parseFloat(document.getElementById('decl').value) || 0;
    document.getElementById('me').textContent = toMGRS(fix.lat, fix.lon, 4);
    document.getElementById('acc').textContent = `GPS ±${Math.round(fix.acc)} m`;
    document.getElementById('pp').innerHTML = course.pts.map((p, i) => {
      const dist = haversine(fix, p);
      const tb = bearing(fix, p);
      const mb = (((tb - d) % 360) + 360) % 360;
      const near = dist <= course.radius;
      return `<div class="prow ${near ? 'found' : ''}"><div class="lbl">P${i + 1}</div>
        <div><div class="mg">${mgrs8(p)}</div>
          <div class="pid">True ${Math.round(tb)}° ${compassPoint(tb)}, magnetic ${Math.round(mb)}°</div></div>
        <div class="st" style="font-size:1.2rem">${near ? 'IN RANGE' : Math.round(dist) + ' m'}${near ? `<br><span class="small">${Math.round(dist)} m</span>` : ''}</div></div>`;
    }).join('');
  };
  practiceWatch = navigator.geolocation.watchPosition(
    (p) => { fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }; },
    (e) => { document.getElementById('me').textContent = e.code === 1 ? 'Location is blocked' : 'No GPS yet'; },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
  );
  practiceTimer = setInterval(draw, 1000);
  lockScreen();
  document.getElementById('stopPractice').onclick = () => { stopPractice(); showPlan(); };
}

function startRun() {
  const btn = document.getElementById('start');
  const msg = document.getElementById('startMsg');
  if (!('geolocation' in navigator)) {
    msg.innerHTML = '<div class="banner bad">This browser has no GPS support.</div>';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Requesting GPS…';
  navigator.geolocation.getCurrentPosition(
    () => begin(),
    (err) => {
      if (err.code === 1) {
        btn.disabled = false;
        btn.textContent = 'START CLOCK';
        msg.innerHTML = '<div class="banner bad"><b>Location is blocked.</b> Allow location for this site in your phone settings, then try again.</div>';
      } else begin(); // timeout / no fix yet: start anyway, it will come
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
  );
}

function begin() {
  stopPractice();
  run = { code: course.code, startedAt: Date.now(), endedAt: null, found: {}, checkins: [] };
  track = [];
  saveRun();
  saveTrack();
  showActive();
}

function showActive() {
  document.getElementById('topTitle').textContent = 'Running';
  app.innerHTML = `
    <div class="clock"><div class="sub" id="clkLbl">Time remaining</div><div class="big" id="clk">--:--</div>
      <div class="sub" id="elapsed"></div></div>
    <div class="stat3 card"><div><div class="v" id="nFound">0/${course.pts.length}</div><div class="k">Found</div></div>
      <div><div class="v">${course.need}</div><div class="k">To pass</div></div>
      <div><div class="v" id="nMiss">0</div><div class="k">Misses</div></div></div>
    <button id="checkin" class="primary checkin">Check in</button>
    <div class="pbar hidden" id="pbar" style="margin-top:10px"><div></div></div>
    <div id="out" aria-live="polite"></div>
    <div class="plist" id="plist"></div>
    <div id="allDone"></div>
    <div class="small muted" id="foot"></div>
    <p style="margin-top:18px"><button id="end" class="danger" style="width:100%">End course</button></p>`;
  document.getElementById('checkin').onclick = doCheckin;
  document.getElementById('end').onclick = () => {
    const n = Object.keys(run.found).length;
    if (confirm(`End the course now?\n\nYou have found ${n} of ${course.pts.length}.`)) endRun();
  };
  renderPoints();
  tick();
  clearInterval(timer);
  timer = setInterval(tick, 1000);
  startTracking();
  lockScreen();
}

function renderPoints() {
  document.getElementById('plist').innerHTML = course.pts.map((p, i) => {
    const f = run.found[p.id];
    const late = f && (f.t - run.startedAt) / 1000 > course.limitMin * 60;
    return `<div class="prow ${f ? 'found' : ''}"><div class="lbl">${f ? '✓' : 'P' + (i + 1)}</div>
      <div><div class="mg">${mgrs8(p)}</div><div class="pid">P${i + 1} · ID ${esc(p.id)}</div></div>
      <div class="st">${f ? `FOUND<br><span class="mono">${fmtDuration((f.t - run.startedAt) / 1000)}</span>${late ? '<br>LATE' : ''}` : ''}</div></div>`;
  }).join('');
  const n = Object.keys(run.found).length;
  document.getElementById('nFound').textContent = `${n}/${course.pts.length}`;
  document.getElementById('nMiss').textContent = run.checkins.filter((c) => c.result === 'miss').length;
  document.getElementById('allDone').innerHTML = n === course.pts.length
    ? '<div class="banner ok"><b>All points found!</b> Press “End course” to see your results.</div>' : '';
}

function tick() {
  if (!active()) return;
  const elapsed = (Date.now() - run.startedAt) / 1000;
  const remaining = course.limitMin * 60 - elapsed;
  const clk = document.getElementById('clk');
  if (!clk) return;
  clk.textContent = remaining >= 0 ? fmtDuration(remaining) : '+' + fmtDuration(-remaining);
  clk.classList.toggle('over', remaining < 0);
  document.getElementById('clkLbl').textContent = remaining >= 0 ? 'Time remaining' : 'Over time. New finds will not count.';
  document.getElementById('elapsed').textContent = `Elapsed ${fmtDuration(elapsed)}`;
  const foot = document.getElementById('foot');
  if (foot) foot.textContent = `Screen lock ${wakeLock ? 'on' : 'off, keep the screen on'}. Track points: ${track.length}`;
}

// ------------------------------------------------------------ check-in ----
function beep(ok) {
  try {
    const ctx = audioCtx;
    if (!ctx) return;
    const tones = ok ? [660, 880, 1100] : [220];
    tones.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      g.gain.value = 0.15;
      o.connect(g);
      g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.13;
      o.start(t);
      o.stop(t + 0.11);
    });
  } catch { /* sound is a bonus */ }
}

function gpsErrorText(err) {
  if (!err) return 'No GPS fix.';
  if (err.code === 1) return 'Location permission denied. Enable it in your browser/phone settings.';
  if (err.code === 2) return 'Position unavailable. Try again in the open.';
  return 'GPS timed out. Try again in the open.';
}

async function doCheckin() {
  if (busy || !active()) return;
  busy = true;
  try { audioCtx ??= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.(); } catch { /* ignore */ }
  const btn = document.getElementById('checkin');
  const out = document.getElementById('out');
  const bar = document.getElementById('pbar');
  btn.disabled = true;
  btn.textContent = 'Reading GPS…';
  out.innerHTML = '';
  bar.classList.remove('hidden');
  const fill = bar.firstElementChild;
  const fixes = [];
  let lastErr = null;
  const t0 = Date.now();
  const add = (p) => fixes.push({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy });
  // Fixes come from the run's shared watch AND from periodic one-shot reads, so
  // a watch that only reports on movement can't leave a stationary phone with nothing.
  const listener = (p) => add(p);
  fixListeners.add(listener);
  const poll = () => navigator.geolocation.getCurrentPosition(add, (e) => { lastErr = e; }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  poll();
  const pollIv = setInterval(poll, 2500);
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      const dt = Date.now() - t0;
      fill.style.width = Math.min(100, (dt / CHECKIN_MS) * 100) + '%';
      if ((dt >= CHECKIN_MS && fixes.length >= 3) || dt >= CHECKIN_MAX_MS || (lastErr?.code === 1)) {
        clearInterval(iv);
        resolve();
      }
    }, 200);
  });
  clearInterval(pollIv);
  fixListeners.delete(listener);
  bar.classList.add('hidden');
  fill.style.width = '0';
  btn.disabled = false;
  btn.textContent = 'Check in';
  busy = false;
  if (!active()) return;

  const pos = averageFixes(fixes);
  if (!pos) {
    out.innerHTML = `<div class="result bad">No GPS fix<div class="small" style="font-weight:600">${esc(gpsErrorText(lastErr))}</div></div>`;
    return;
  }
  const ev = evaluateCheckin(pos, course.pts, run.found, course.radius);
  const now = Date.now();
  const entry = { t: now, lat: pos.lat, lon: pos.lon, acc: pos.acc, n: pos.n, result: ev.status, pid: ev.pt?.id ?? null, nearestM: ev.nearestM };
  run.checkins.push(entry);
  const info = `GPS ±${Math.round(pos.acc)} m · ${pos.n} fixes averaged`;
  const poorNote = pos.acc > course.radius ? `<div class="small" style="font-weight:600">GPS accuracy (±${Math.round(pos.acc)} m) is worse than the ${course.radius} m radius.</div>` : '';
  if (ev.status === 'hit') {
    run.found[ev.pt.id] = { t: now, lat: pos.lat, lon: pos.lon, acc: pos.acc };
    const idx = course.pts.findIndex((p) => p.id === ev.pt.id) + 1;
    out.innerHTML = `<div class="result found">✔ POINT FOUND<div style="font-size:2rem">P${idx} · ${esc(ev.pt.id)}</div><div class="small mono">${fmtDuration((now - run.startedAt) / 1000)} elapsed</div><div class="small" style="font-weight:600">${info}</div>${poorNote}</div>`;
    navigator.vibrate?.([120, 60, 120, 60, 240]);
    beep(true);
  } else if (ev.status === 'already') {
    const idx = course.pts.findIndex((p) => p.id === ev.pt.id) + 1;
    out.innerHTML = `<div class="result none">You already found P${idx}, ${esc(ev.pt.id)}.<div class="small" style="font-weight:600">${info}</div></div>`;
    navigator.vibrate?.(80);
  } else if (ev.status === 'poor') {
    out.innerHTML = `<div class="result none">No point here, but GPS is weak<div class="small" style="font-weight:600">${info}</div>${poorNote}<div class="small" style="font-weight:600">Not counted as a miss. Move to open sky and try again.</div></div>`;
    navigator.vibrate?.(200);
    beep(false);
  } else {
    out.innerHTML = `<div class="result none">No point here<div class="small" style="font-weight:600">${info}</div></div>`;
    navigator.vibrate?.(200);
    beep(false);
  }
  saveRun();
  renderPoints();
}

// ----------------------------------------------- background track + lock ----
function startTracking() {
  if (watchId != null || !('geolocation' in navigator)) return;
  let lastT = track.length ? track[track.length - 1][0] : 0;
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      for (const fn of fixListeners) fn(p);
      const t = Date.now();
      if (t - lastT < 5000) return;
      lastT = t;
      track.push([t, +p.coords.latitude.toFixed(6), +p.coords.longitude.toFixed(6), Math.round(p.coords.accuracy)]);
    },
    () => { /* errors are surfaced at check-in time */ },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
  );
}
function stopTracking() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}
setInterval(() => { if (active()) saveTrack(); }, 20000);
for (const ev of ['pagehide', 'visibilitychange']) {
  window.addEventListener(ev, () => { if (active()) { saveTrack(); saveRun(); } });
}

async function lockScreen() {
  try {
    if (!('wakeLock' in navigator)) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { wakeLock = null; /* fail gracefully */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && active() && !wakeLock) lockScreen();
});

// ----------------------------------------------------------------- end ----
function endRun() {
  run.endedAt = Date.now();
  saveRun();
  saveTrack();
  clearInterval(timer);
  stopTracking();
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
  showResults();
}

function showResults() {
  document.getElementById('topTitle').textContent = 'Results';
  renderResults(app, course, run, track, {
    onNew: () => {
      window.scrollTo(0, 0);
      showPlan();
    },
  });
}

// ----------------------------------------------------------------- boot ----
function resume() {
  course = decodeCourse(run.code);
  if (run.endedAt) return showResults();
  showActive();
}

function boot() {
  run = store.get(RUN_KEY);
  track = store.get(TRACK_KEY, []);
  const hash = location.hash.slice(1);
  if (hash) {
    let c;
    try { c = decodeCourse(hash); } catch (e) { return showEnterCode(e.message); }
    if (run && run.code === c.code && !run.endedAt) return resume();
    if (active()) {
      course = decodeCourse(run.code);
      app.innerHTML = `<div class="card"><h2>Run in progress</h2>
        <p>You already have a run going for <b>${esc(course.name)}</b>. Opening this new course link would replace it.</p>
        <p><button id="res" class="primary" style="width:100%">Resume current run</button></p>
        <p><button id="rep" class="danger" style="width:100%">Discard it and open the new course</button></p></div>`;
      document.getElementById('res').onclick = resume;
      document.getElementById('rep').onclick = () => {
        if (!confirm('Discard the run in progress?')) return;
        store.del(RUN_KEY); store.del(TRACK_KEY); run = null; track = [];
        course = c; store.set(PLAN_KEY, c.code); showPlan();
      };
      return;
    }
    course = c;
    store.set(PLAN_KEY, c.code);
    return showPlan();
  }
  if (run) return resume();
  const plan = store.get(PLAN_KEY);
  if (plan) {
    try { course = decodeCourse(plan); return showPlan(); } catch { /* fall through */ }
  }
  showEnterCode();
}

boot();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
