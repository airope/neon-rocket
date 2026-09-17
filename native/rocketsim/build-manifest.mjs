// Records the actual build inputs/outputs, not provenance inferred from old binaries.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [revision, source] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(revision ?? '') || !source) throw new Error('Usage: build-manifest.mjs REVISION SOURCE');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function inventory(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : 1).flatMap(entry => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? inventory(path.join(directory, entry.name), name + '/') : [[name, sha256(fs.readFileSync(path.join(directory, entry.name)))]];
  });
}
const inputs = ['native/rocketsim/rocketsim_c_api.cpp', 'native/rocketsim/dist/rocketsim.mjs', 'scripts/build-rocketsim-wasm.sh', 'scripts/embed-rocketsim-wasm.mjs', 'native/rocketsim/build-manifest.mjs'];
const outputs = ['native/rocketsim/dist/rocketsim-raw.wasm', 'native/rocketsim/dist/rocketsim-raw.mjs'];
const hashes = files => Object.fromEntries(files.map(file => [file, sha256(fs.readFileSync(path.join(root, file)))]));
const manifest = {
  schema: 1,
  source: { url: 'https://github.com/ZealanL/RocketSim.git', revision, patches: [], files: Object.fromEntries(inventory(source)) },
  toolchain: { emscripten: execFileSync('em++', ['--version'], { encoding: 'utf8' }).split('\n')[0], cmake: execFileSync('cmake', ['--version'], { encoding: 'utf8' }).split('\n')[0], node: process.version },
  inputs: hashes(inputs), outputs: hashes(outputs),
  assetPolicy: 'No dumped game assets; InitFromMem({}, true), THE_VOID and procedural custom arena mesh.',
};
fs.writeFileSync(path.join(root, 'native/rocketsim/dist/build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Recorded source inventory and artifact SHA-256 in native/rocketsim/dist/build-manifest.json');
