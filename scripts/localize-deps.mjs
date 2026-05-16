import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// 1. Chart.js
console.log('Downloading Chart.js...');
const chartJs = await fetch('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js').then(r => r.text());
mkdirSync(join(ROOT, 'public', 'vendor'), { recursive: true });
writeFileSync(join(ROOT, 'public', 'vendor', 'chart.umd.min.js'), chartJs);
console.log(`  chart.umd.min.js (${(chartJs.length / 1024).toFixed(0)} KB)`);

// 2. Inter font
console.log('Downloading Inter font...');
const fontCss = await fetch('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' },
}).then(r => r.text());

const fontUrls = [...fontCss.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(m => m[1]);
mkdirSync(join(ROOT, 'public', 'fonts'), { recursive: true });

let localCss = fontCss;
for (let i = 0; i < fontUrls.length; i++) {
  const fontData = await fetch(fontUrls[i]).then(r => r.arrayBuffer());
  const fileName = `inter-${i}.woff2`;
  writeFileSync(join(ROOT, 'public', 'fonts', fileName), Buffer.from(fontData));
  localCss = localCss.replace(fontUrls[i], `./${fileName}`);
  console.log(`  ${fileName}`);
}

writeFileSync(join(ROOT, 'public', 'fonts', 'inter.css'), localCss);
console.log('Done!');
