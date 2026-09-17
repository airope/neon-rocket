#!/usr/bin/env node
// Static packaging only: never rewrite simulation, renderer, or input behavior.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out-dir')) throw new Error('Usage: node scripts/build-static-demo.mjs [--out-dir directory]');
const out = path.resolve(args[1] || path.join(root, 'dist-demo'));
// Never recursively delete user-supplied destinations; only empty directories are accepted.
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Output directory must be empty');
if ((await lstat(out)).isSymbolicLink()) throw new Error('Output directory cannot be a symlink');
const hashes = {};
async function put(name, contents) {
  if (/\/Users\/|\/home\/(?!web_user\b)[a-zA-Z]|[A-Za-z]:\\+[Uu][Ss][Ee][Rr][Ss]\\+/.test(contents.toString())) throw new Error(`Personal filesystem path in asset: ${name}`);
  hashes[name] = createHash('sha256').update(contents).digest('hex');
  await mkdir(path.dirname(path.join(out, name)), { recursive: true });
  await writeFile(path.join(out, name), contents);
}
async function copy(source, target = source) { await put(target, await readFile(path.join(root, source))); }
for (const file of ['game.js', 'network-interpolation.js', 'rocketsim-playable-core.js']) {
  const source = await readFile(path.join(root, 'public', file), 'utf8');
  await put(file, source.replace(/(from\s+['"])\//g, '$1./')
    .replace(/(from\s+['"])\.\.\/shared\//g, '$1./shared/'));
}
for (const file of (await readdir(path.join(root, 'shared'))).sort()) {
  if (file.endsWith('.js')) await copy(`shared/${file}`);
}
for (const file of ['rocketsim.mjs', 'rocketsim-raw.mjs', 'rocketsim-raw.wasm']) await copy(`native/rocketsim/dist/${file}`);
for (const [source, target] of [
  ['node_modules/three/build/three.module.js', 'vendor/three.module.js'],
  ['node_modules/three/build/three.core.js', 'vendor/three.core.js'],
  ['node_modules/cannon-es/dist/cannon-es.js', 'vendor/cannon-es.js'],
  ['node_modules/@dimforge/rapier3d-deterministic-compat/rapier.mjs', 'vendor/rapier/rapier.mjs'],
]) await copy(source, target);
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'native/rocketsim/dist/build-manifest.json']) await copy(file);
for (const directory of ['docs/licenses', 'native/rocketsim/licenses']) {
  for (const file of (await readdir(path.join(root, directory))).sort()) await copy(`${directory}/${file}`);
}
const imports = {
  three: './vendor/three.module.js',
  'cannon-es': './vendor/cannon-es.js',
  '@dimforge/rapier3d-deterministic-compat': './vendor/rapier/rapier.mjs',
};
let html = await readFile(path.join(root, 'public/index.html'), 'utf8');
html = html.replace(/((?:src|href)=['"])\//g, '$1./');
// Prevent Chrome's implicit origin-root /favicon.ico fetch on project subpaths.
html = html.replace('</head>', `<link rel="icon" href="data:,">\n<script type="importmap">${JSON.stringify({ imports })}</script>\n</head>`);
html = html.replace('./socket.io/socket.io.js', './offline-socket.js');
for (const id of ['create', 'join', 'code', 'novaDuel']) {
  const control = new RegExp(`(<(?:button|input)\\b[^>]*id="${id}"[^>]*)(>)`);
  if (!control.test(html)) throw new Error(`Missing expected demo control: ${id}`);
  html = html.replace(control, '$1 disabled aria-describedby="static-demo-note"$2');
}
html = html.replace('CONNECTING TO SERVER…', 'SOLO-ONLY DEMO · OFFLINE');
html = html.replace('<p class="offline-note">', '<p id="static-demo-note" class="offline-note">SOLO-ONLY DEMO. Private rooms and live spectating are unavailable on GitHub Pages: there is no multiplayer server. <a href="https://github.com/airope/neon-rocket">Source code and self-hosted multiplayer</a>.</p>\n      <p class="offline-note">');
html = html.replace('</body>', '<p style="position:fixed;bottom:4px;left:50%;transform:translateX(-50%);z-index:30;font:11px sans-serif"><a style="color:#9cacc9" href="./THIRD_PARTY_NOTICES.md">Licenses and credits</a></p>\n</body>');
await put('index.html', html);
// This is deliberately NOT a Socket.IO client: a permanently disconnected null object.
// The production game guards backend actions with socket.connected and starts solo locally.
// No events are synthesized, no acknowledgement succeeds, and no network/retry is attempted.
await put('offline-socket.js', `/* SOLO-only static export: multiplayer requires a self-hosted server. */
(() => {
  const socket = Object.freeze({
    connected: false,
    disconnected: true,
    on() { return this; },
    emit() { return this; },
    timeout() { return this; },
    async emitWithAck() { throw new Error('SOLO-ONLY DEMO: no multiplayer server.'); }
  });
  window.io = () => socket;
})();
`);
// No CDN: use the stylesheet's existing sans-serif fallback fonts.
const css = await readFile(path.join(root, 'public/style.css'), 'utf8');
await put('style.css', css.replace(/^@import\s+url\([^\n]+\);\s*\n/m, ''));
await put('.nojekyll', '');
await put('manifest.json', JSON.stringify({
  schemaVersion: 1,
  mode: 'solo-offline',
  repository: 'https://github.com/airope/neon-rocket',
  hashAlgorithm: 'sha256',
  files: Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
}, null, 2) + '\n');
console.log('Static solo demo exported.');
