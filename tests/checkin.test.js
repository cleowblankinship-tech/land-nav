import test from 'node:test';
import assert from 'node:assert/strict';
import { averageFixes, evaluateCheckin } from '../js/checkin.js';
import { destination, haversine } from '../js/geo.js';

const P = { lat: 38.8685, lon: -104.7518 };
const pts = [{ id: 'AA11', ...P }, { id: 'BB22', ...destination(P, 90, 500) }];

test('averageFixes: averages, favours accurate fixes, drops wild ones', () => {
  const fixes = [
    { ...destination(P, 0, 4), acc: 5 },
    { ...destination(P, 180, 4), acc: 5 },
    { ...P, acc: 4 },
    { ...destination(P, 90, 300), acc: 120 }, // junk fix
  ];
  const a = averageFixes(fixes);
  assert.ok(haversine(a, P) < 3, `avg error ${haversine(a, P)}`);
  assert.ok(a.acc >= 3 && a.acc < 12, `acc ${a.acc}`);
  assert.equal(a.n, 3);
  assert.equal(averageFixes([]), null);
});

test('averageFixes: spread inflates reported accuracy', () => {
  const wander = [0, 60, 120, 180, 240, 300].map((b) => ({ ...destination(P, b, 30), acc: 5 }));
  assert.ok(averageFixes(wander).acc > 20);
});

test('evaluateCheckin: hit / miss / already / poor', () => {
  const near = destination(P, 45, 20);
  assert.equal(evaluateCheckin({ ...near, acc: 8 }, pts, {}, 30).status, 'hit');
  assert.equal(evaluateCheckin({ ...near, acc: 8 }, pts, {}, 30).pt.id, 'AA11');
  const far = destination(P, 270, 200);
  assert.equal(evaluateCheckin({ ...far, acc: 8 }, pts, {}, 30).status, 'miss');
  assert.equal(evaluateCheckin({ ...near, acc: 8 }, pts, { AA11: {} }, 30).status, 'already');
  assert.equal(evaluateCheckin({ ...far, acc: 80 }, pts, {}, 30).status, 'poor');
  // a real hit still counts under poor accuracy
  assert.equal(evaluateCheckin({ ...near, acc: 80 }, pts, {}, 30).status, 'hit');
});

test('evaluateCheckin: exact radius edge and nearest-point choice', () => {
  const close = [{ id: 'X', ...P }, { id: 'Y', ...destination(P, 90, 25) }];
  const pos = destination(P, 90, 20);
  assert.equal(evaluateCheckin({ ...pos, acc: 5 }, close, {}, 30).pt.id, 'Y');
  const edge = destination(P, 0, 29.9);
  assert.equal(evaluateCheckin({ ...edge, acc: 5 }, [pts[0]], {}, 30).status, 'hit');
  const out = destination(P, 0, 30.5);
  assert.equal(evaluateCheckin({ ...out, acc: 5 }, [pts[0]], {}, 30).status, 'miss');
});
