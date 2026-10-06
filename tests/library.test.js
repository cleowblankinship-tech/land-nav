import test from 'node:test';
import assert from 'node:assert/strict';
import { listCourses, getCourse, saveCourse, deleteCourse, duplicateCourse, describeCourse, newId } from '../js/library.js';

const memory = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => { m.set(k, JSON.stringify(v)); return true; }, del: (k) => m.delete(k) };
};
const course = (id, name, savedAt, n = 5) => ({ id, name, savedAt, data: { name, points: Array.from({ length: n }, (_, i) => ({ id: `P${i}` })) } });

test('save, list newest first, get, delete', () => {
  const b = memory();
  saveCourse(course('a', 'Palmer', 1000), b);
  saveCourse(course('b', 'Victor', 3000), b);
  saveCourse(course('c', 'Pike', 2000), b);
  assert.deepEqual(listCourses(b).map((c) => c.id), ['b', 'c', 'a']);
  assert.equal(getCourse('c', b).name, 'Pike');
  deleteCourse('c', b);
  assert.deepEqual(listCourses(b).map((c) => c.id), ['b', 'a']);
  assert.equal(getCourse('c', b), null);
});

test('saving an existing id replaces it instead of duplicating', () => {
  const b = memory();
  saveCourse(course('a', 'Palmer', 1000, 3), b);
  saveCourse(course('a', 'Palmer renamed', 2000, 5), b);
  const all = listCourses(b);
  assert.equal(all.length, 1);
  assert.equal(all[0].name, 'Palmer renamed');
  assert.equal(all[0].data.points.length, 5);
});

test('duplicate is independent of the original', () => {
  const b = memory();
  saveCourse(course('a', 'Palmer', 1000), b);
  const copy = duplicateCourse('a', b);
  assert.notEqual(copy.id, 'a');
  assert.equal(copy.name, 'Palmer copy');
  assert.equal(copy.data.name, 'Palmer copy');
  copy.data.points.pop();
  assert.equal(getCourse('a', b).data.points.length, 5);
  assert.equal(listCourses(b).length, 2);
  assert.equal(duplicateCourse('missing', b), null);
});

test('saveCourse reports a storage failure', () => {
  const full = { get: () => [], set: () => false };
  assert.equal(saveCourse(course('a', 'x', 1), full), false);
});

test('describeCourse and newId', () => {
  assert.match(describeCourse(course('a', 'x', Date.parse('2026-10-05T12:00:00Z'), 5)), /^5 points, /);
  assert.match(describeCourse(course('a', 'x', 1, 1)), /^1 point, /);
  assert.notEqual(newId(), newId());
});
