// Copies the third-party browser libraries out of node_modules into ./vendor
// so the site is fully static (no bundler, no CDN, works offline).
import { cpSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('vendor/images', { recursive: true });
copyFileSync('node_modules/leaflet/dist/leaflet.js', 'vendor/leaflet.js');
copyFileSync('node_modules/leaflet/dist/leaflet.css', 'vendor/leaflet.css');
cpSync('node_modules/leaflet/dist/images', 'vendor/images', { recursive: true });
copyFileSync('node_modules/mgrs/dist/mgrs.esm.js', 'vendor/mgrs.js');
copyFileSync('node_modules/proj4/dist/proj4.js', 'vendor/proj4.js');
for (const f of ['vendor/mgrs.js', 'vendor/leaflet.js', 'vendor/proj4.js']) {
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gm, ''));
}
console.log('vendored leaflet, mgrs, proj4');
