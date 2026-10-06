// Saved courses ("My courses"). Stored in localStorage, newest edit first.
// The backend is injectable so this can be unit-tested without a browser.
import { store } from './store.js';

const KEY = 'ln.courses.v1';

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** A saved course: {id, name, savedAt, data}. `data` is the editor state. */
export function listCourses(backend = store) {
  const all = backend.get(KEY, []);
  return [...all].sort((a, b) => b.savedAt - a.savedAt);
}

export function getCourse(id, backend = store) {
  return backend.get(KEY, []).find((c) => c.id === id) ?? null;
}

/** Insert or replace by id. Returns false if storage refused (quota). */
export function saveCourse(entry, backend = store) {
  const all = backend.get(KEY, []).filter((c) => c.id !== entry.id);
  all.push({ ...entry, savedAt: entry.savedAt ?? Date.now() });
  return backend.set(KEY, all);
}

export function deleteCourse(id, backend = store) {
  return backend.set(KEY, backend.get(KEY, []).filter((c) => c.id !== id));
}

/** Copy with a new id and name; returns the copy. */
export function duplicateCourse(id, backend = store) {
  const src = getCourse(id, backend);
  if (!src) return null;
  const copy = { ...src, id: newId(), name: `${src.name} copy`, savedAt: Date.now(), data: JSON.parse(JSON.stringify(src.data)) };
  copy.data.name = copy.name;
  return saveCourse(copy, backend) ? copy : null;
}

/** One line for the list: "5 points, Oct 5". */
export function describeCourse(c) {
  const n = c.data?.points?.length ?? 0;
  const d = new Date(c.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${n} ${n === 1 ? 'point' : 'points'}, ${d}`;
}
