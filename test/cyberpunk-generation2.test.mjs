import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('cyberpunk semantic roles derive from theme tokens', () => {
  const src = read('src/styles/86-v3-skin.css');
  for (const role of [
    '--cp-structural', '--cp-terminal', '--cp-telemetry', '--cp-line-passive',
    '--cp-line-active', '--cp-slab', '--cp-glow-calm',
  ]) assert.match(src, new RegExp(role));
  assert.doesNotMatch(src.slice(src.indexOf('--cp-structural'), src.indexOf('--row-h')), /#[0-9a-f]{3,8}/i);
});

test('brightness is concentrated on selected targets', () => {
  const src = read('src/styles/88-cyberpunk.css');
  assert.match(src, /\.row\[aria-selected='true'\]/);
  assert.match(src, /\.cat\[aria-current='page'\]/);
  assert.match(src, /--cp-slab/);
  assert.match(src, /--cp-line-active/);
});

test('timetable terminal palette is bounded to its workspace', () => {
  const src = read('src/styles/88-cyberpunk.css');
  assert.match(src, /data-tt-terminal='on'\] #tt-workspace/);
  assert.doesNotMatch(src, /data-tt-terminal='on'\] body/);
});

test('cyberpunk intensity has calm and maximum implementations', () => {
  const src = read('src/styles/88-cyberpunk.css');
  assert.match(src, /data-cp-intensity='calm'/);
  assert.match(src, /data-cp-intensity='maximum'/);
  assert.match(src, /data-calm-content='on'/);
});

test('calm content explicitly excludes texture and text distortion', () => {
  const src = read('src/styles/88-cyberpunk.css');
  const rule = src.slice(src.indexOf("data-calm-content='on'"));
  assert.match(rule, /#r-frame/);
  assert.match(rule, /#c-text/);
  assert.match(rule, /background-image: none/);
  assert.match(rule, /text-shadow: none/);
});
