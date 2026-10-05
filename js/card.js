// Printable / screenshot-friendly lane card. Deliberately NO map.
import { decodeCourse, mgrs8 } from './course.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const root = document.getElementById('card');

function fmtLimit(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h${m ? ' ' + String(m).padStart(2, '0') + 'm' : ''}` : `${m}m`;
}

try {
  const c = decodeCourse(location.hash);
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  root.innerHTML = `
  <div class="lane">
    <h1><span>Land Nav Lane Card</span><small>${esc(c.name)} · ${esc(date)}</small></h1>
    <table>
      <tr><th style="width:5.5em">Point</th><th style="width:5em">ID</th><th>MGRS (8-digit)</th><th style="width:7em">Found</th></tr>
      <tr class="start"><td><b>START</b></td><td>—</td><td class="m">${esc(mgrs8(c.start))}</td><td></td></tr>
      ${c.pts.map((p, i) => `<tr><td><b>P${i + 1}</b></td><td class="mono"><b>${esc(p.id)}</b></td><td class="m">${esc(mgrs8(p))}</td><td style="white-space:nowrap">☐ ___:___</td></tr>`).join('')}
    </table>
    <div class="meta">
      <div><b>Time limit</b><span>${esc(fmtLimit(c.limitMin))}</span></div>
      <div><b>Check-in radius</b><span>${c.radius} m</span></div>
      <div><b>To pass</b><span>${c.need} of ${c.pts.length}</span></div>
    </div>
    <div class="notes">
      <p>Plot each grid on your own map. ${c.endAtStart ? 'Course ends back at the start point.' : 'Course ends at the last point you find.'}
      Points may be found in any order. Datum WGS84 · grid ${esc(mgrs8(c.start).split(' ').slice(0, 2).join(' '))}.</p>
      <p>Notes:</p><div class="blank"></div><div class="blank"></div>
    </div>
  </div>`;
  document.title = `Lane card — ${c.name}`;
} catch (e) {
  root.innerHTML = `<div class="banner bad">${esc(e.message)} Open this page from the course link made in Setup mode.</div>`;
}
