import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bundledRocketSimWasm } from '../../shared/rocketsim-wasm-bundled.js';
const root = new URL('../../', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(fs.readFileSync(new URL('dist/build-manifest.json', import.meta.url)));
for (const [name, expected] of Object.entries({ ...manifest.inputs, ...manifest.outputs })) {
  assert.equal(hash(fs.readFileSync(new URL(name, root))), expected, `manifest mismatch: ${name}`);
}
const wasm = fs.readFileSync(new URL('dist/rocketsim-raw.wasm', import.meta.url));
assert.ok(WebAssembly.validate(wasm));
assert.equal(hash(bundledRocketSimWasm()), hash(wasm), 'Production browser bundle must contain the rebuilt native WASM');
const { createRocketSimModule } = await import('./dist/rocketsim.mjs');
// Exercise the same embedded-byte hook used in the browser, not merely the sidecar file.
const api = await createRocketSimModule({ instantiateWasm(imports, receiveInstance) {
  const module = new WebAssembly.Module(bundledRocketSimWasm());
  const instance = new WebAssembly.Instance(module, imports);
  receiveInstance(instance, module);
  return instance.exports;
}});
assert.equal(typeof api.raw._rs_set_car_boost, 'function');
const arena = api.createArena();
try {
  const car = arena.addOctane();
  arena.step(90);
  assert.equal(car.getState().wheelContactCount, 4);
  car.setBoost(80);
  car.setControls({ throttle: 1, boost: true });
  const before = car.getState();
  arena.step(120);
  const after = car.getState();
  assert.ok(after.boost < before.boost);
  assert.ok(Math.hypot(after.position.x - before.position.x, after.position.z - before.position.z) > 5);
} finally { arena.destroy(); }
console.log(JSON.stringify({ verified: true, wasmBytes: wasm.length, wasmSha256: hash(wasm), productionBundleMatches: true, manifest: fileURLToPath(new URL('dist/build-manifest.json', import.meta.url)) }, null, 2));
