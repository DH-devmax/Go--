const fs = require('node:fs');
const esbuild = require('esbuild');
fs.mkdirSync('dist', { recursive: true });
esbuild.buildSync({ entryPoints: ['src/renderer.js'], bundle: true, outfile: 'dist/renderer.js', format: 'iife' });
// Remove retired generated pages from older local builds.
for (const name of [
  'projector.html', 'projector.css', 'projector.js',
  'tutorial-1.svg', 'tutorial-2.svg', 'tutorial-3.svg', 'tutorial-4.svg',
]) fs.rmSync(`dist/${name}`, { force: true });
for (const name of ['index.html', 'style.css']) fs.copyFileSync(`src/${name}`, `dist/${name}`);
console.log('Independent app built.');
