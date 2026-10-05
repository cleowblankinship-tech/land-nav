import test from 'node:test';
import assert from 'node:assert/strict';
import { stitchRings, elementRings, parseBoundaries, parseConstraints, areaRule, lineRule, bboxOfLL } from '../js/osm.js';

const g = (...pts) => pts.map(([lat, lon]) => ({ lat, lon }));

test('stitchRings joins segments regardless of direction', () => {
  const rings = stitchRings([
    [[0, 0], [0, 1]],
    [[1, 1], [0, 1]], // reversed
    [[1, 1], [1, 0]],
    [[1, 0], [0, 0]],
  ]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 4);
});

test('multipolygon relation -> outer rings and inner holes', () => {
  const el = {
    type: 'relation', id: 1,
    members: [
      { type: 'way', role: 'outer', geometry: g([0, 0], [0, 10], [10, 10]) },
      { type: 'way', role: 'outer', geometry: g([10, 10], [10, 0], [0, 0]) },
      { type: 'way', role: 'inner', geometry: g([4, 4], [4, 6], [6, 6], [6, 4], [4, 4]) },
    ],
  };
  const r = elementRings(el);
  assert.equal(r.outers.length, 1);
  assert.equal(r.outers[0].length, 4);
  assert.equal(r.inners.length, 1);
});

test('parseBoundaries lists named areas, biggest first', () => {
  const sq = (s) => g([0, 0], [0, s], [s, s], [s, 0], [0, 0]);
  const out = parseBoundaries({
    elements: [
      { type: 'way', id: 1, tags: { name: 'Small', leisure: 'park' }, geometry: sq(1) },
      { type: 'way', id: 2, tags: { name: 'Big', boundary: 'protected_area' }, geometry: sq(5) },
      { type: 'way', id: 3, tags: { leisure: 'park' }, geometry: sq(9) }, // unnamed: dropped
    ],
  });
  assert.deepEqual(out.map((o) => o.name), ['Big', 'Small']);
});

test('tag rules classify water/buildings/trails/roads sensibly', () => {
  assert.equal(areaRule({ natural: 'water' }).kind, 'water');
  assert.equal(areaRule({ building: 'yes' }).kind, 'building');
  assert.equal(areaRule({ landuse: 'residential' }).kind, 'developed');
  assert.equal(areaRule({ access: 'private' }).kind, 'private');
  assert.equal(areaRule({ leisure: 'park' }), null);
  assert.deepEqual(lineRule({ highway: 'path' }), { kind: 'trail', buffer: 0, trail: true });
  assert.equal(lineRule({ highway: 'residential' }).kind, 'road');
  assert.equal(lineRule({ highway: 'track', access: 'private' }).trail, false);
  assert.equal(lineRule({ natural: 'cliff' }).kind, 'cliff');
  assert.equal(lineRule({ highway: 'proposed' }), null);
});

test('parseConstraints splits areas, avoid-lines and trails', () => {
  const sq = g([0, 0], [0, 1], [1, 1], [1, 0], [0, 0]);
  const c = parseConstraints({
    elements: [
      { type: 'way', id: 1, tags: { natural: 'water' }, geometry: sq },
      { type: 'way', id: 2, tags: { building: 'house' }, geometry: sq },
      { type: 'way', id: 3, tags: { highway: 'path' }, geometry: g([0, 0], [1, 1]) },
      { type: 'way', id: 4, tags: { highway: 'residential' }, geometry: g([0, 0], [1, 1]) },
      { type: 'way', id: 5, tags: { natural: 'cliff' }, geometry: g([0, 0], [1, 1]) },
      { type: 'node', id: 6, lat: 0, lon: 0, tags: { natural: 'water' } },
    ],
  });
  assert.equal(c.avoidAreas.length, 2);
  assert.equal(c.trails.length, 2);
  assert.equal(c.avoidLines.length, 2); // road + cliff (paths have no keep-out)
  assert.equal(c.counts.trail, 1);
});

test('bboxOfLL', () => {
  assert.deepEqual(bboxOfLL(g([1, 2], [3, 4]), 1), [0, 1, 4, 5]);
});
