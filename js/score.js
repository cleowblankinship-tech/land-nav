import { decodeCourse } from './course.js';
import { createRevealMap, renderGpxScoring } from './results.js';
import { store } from './store.js';

const $ = (id) => document.getElementById(id);
let rev = null;

function load(input) {
  try {
    const course = decodeCourse(input);
    $('msg').innerHTML = `<div class="banner ok">${course.name}: ${course.pts.length} points, radius ${course.radius} m.</div>`;
    $('stage').classList.remove('hidden');
    if (rev) { rev.map.remove(); }
    rev = createRevealMap($('resmap'), course);
    renderGpxScoring($('scoreBox'), course, { rev });
    store.set('ln.lastCode', course.code);
  } catch (e) {
    $('msg').innerHTML = `<div class="banner bad">${e.message}</div>`;
  }
}
$('load').onclick = () => load($('code').value);
const initial = location.hash.slice(1) || store.get('ln.run')?.code || store.get('ln.lastCode');
if (initial) { $('code').value = initial; load(initial); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
