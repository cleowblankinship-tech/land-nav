import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const sw = readFileSync('sw.js', 'utf8');
const shell = eval(/const SHELL = (\[[\s\S]*?\]);/.exec(sw)[1]);

test('service worker precache list only names files that exist', () => {
  for (const f of shell) {
    if (f === './') continue;
    assert.ok(existsSync(f), `missing precache file ${f}`);
  }
});

test('every app JS module and page is precached', () => {
  for (const f of readdirSync('js')) assert.ok(shell.includes('js/' + f), `js/${f} not precached`);
  for (const f of readdirSync('.').filter((n) => n.endsWith('.html'))) assert.ok(shell.includes(f), `${f} not precached`);
});

test('manifest icons exist', () => {
  const m = JSON.parse(readFileSync('manifest.webmanifest', 'utf8'));
  for (const i of m.icons) assert.ok(existsSync(i.src), i.src);
});

test('deploy workflow ships every html page and every precached file', () => {
  const wf = readFileSync('.github/workflows/pages.yml', 'utf8');
  assert.match(wf, /cp \*\.html /, 'workflow must copy all html pages, not a hand-kept list');
  for (const dir of ['css', 'js', 'vendor', 'icons']) assert.match(wf, new RegExp(`cp -r [^\\n]*\\b${dir}\\b`), `${dir} not copied`);
});
