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
  assert.match(html, /管理汇报/);
  assert.doesNotMatch(html, /牛马/);
  assert.match(app, /smartReportStyle/);
  assert.match(app, /openSmartReportStyleModal/);
  assert.match(app, /smart-report-\$\{this\.smartReportStyle\}/);
});

test('smart report module has a prominent visual emphasis', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const css = readFileSync('public/style.css', 'utf8');

  assert.match(html, /class="card smart-report-card"/);
  assert.match(css, /\.smart-report-card\s*\{/);
  assert.match(css, /border-color:\s*color-mix\(in srgb, var\(--accent\) 55%, var\(--border\)\)/);
  assert.match(css, /\.smart-report-card::before/);
  assert.match(css, /\.smart-report-card::after/);
  assert.match(css, /height:\s*3px/);
  assert.match(css, /conic-gradient/);
  assert.match(css, /animation:\s*smart-report-border-flow 6s linear infinite/);
  assert.match(css, /@keyframes smart-report-border-flow/);
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*\.smart-report-card::after[\s\S]*animation:\s*none/);
  assert.match(css, /box-shadow:[\s\S]*0 0 0 1px color-mix\(in srgb, var\(--accent\) 18%, transparent\)/);
  assert.match(css, /\.smart-report-label/);
  assert.match(css, /\.smart-report-icon/);
  assert.match(html, /smart-report-label/);
  assert.match(html, /smart-report-icon/);
});

test('settings path tag actions are exposed for inline handlers', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const app = readFileSync('public/app.js', 'utf8');

  assert.match(html, /onclick="addPathTag\('cfgReposTags','cfgReposInput'\)"/);
  assert.match(app, /window\.addPathTag\s*=\s*addPathTag/);
  assert.match(app, /window\.removePathTag\s*=\s*removePathTag/);
});
