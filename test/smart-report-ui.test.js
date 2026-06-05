import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

test('smart report loading state exposes a visible progress bar', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const css = readFileSync('public/style.css', 'utf8');

  assert.match(html, /smart-report-progress/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow/);
  assert.match(html, /smartReportProgress/);
  assert.match(html, /smartReportElapsedLabel/);
  assert.match(css, /\.smart-report-progress-track/);
  assert.match(css, /transition: width/);
  assert.doesNotMatch(css, /@keyframes smart-report-progress/);
});

test('work report removes boss level and smart report exposes style selection', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const app = readFileSync('public/app.js', 'utf8');

  assert.doesNotMatch(html, /setReportLevel\('boss'\)/);
  assert.doesNotMatch(html, /汇报 Boss/);
  assert.match(html, /smart-report-style-modal/);
  assert.match(html, /默认风格/);
  assert.match(html, /牛马/);
  assert.match(app, /smartReportStyle/);
  assert.match(app, /openSmartReportStyleModal/);
});
