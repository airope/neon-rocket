import test from 'node:test';
import assert from 'node:assert/strict';
import { CAR_SOCCER_FIELD } from '../shared/car-soccer-contract.js';

const MODULE_URL = new URL('../shared/car-soccer-arena-mesh.js', import.meta.url);

test('shared Neon arena mesh contains rounded shell and goal tunnels without blocked mouths', async () => {
  const { buildCarSoccerArenaMesh } = await import(MODULE_URL);
  const mesh = buildCarSoccerArenaMesh();
  const field = CAR_SOCCER_FIELD;

  assert.ok(mesh.vertices instanceof Float32Array);
  assert.ok(mesh.indices instanceof Uint32Array);
  assert.ok(mesh.indices.length / 3 > 250);
  assert.equal(mesh.indices.length % 3, 0);

  const points = [];
  for (let index = 0; index < mesh.vertices.length; index += 3) {
    points.push({ x: mesh.vertices[index], y: mesh.vertices[index + 1], z: mesh.vertices[index + 2] });
  }
  assert.ok(Math.max(...points.map(point => point.y)) >= field.ceiling);
  assert.ok(Math.max(...points.map(point => point.x)) >= field.halfLength + field.goalDepth);
  assert.ok(Math.min(...points.map(point => point.x)) <= -field.halfLength - field.goalDepth);

  for (const side of [-1, 1]) {
    let blockers = 0;
    for (let index = 0; index < mesh.indices.length; index += 3) {
      const triangle = [0, 1, 2].map(offset => points[mesh.indices[index + offset]]);
      const onMouthPlane = triangle.every(point => Math.abs(point.x - side * field.halfLength) < 1e-4);
      const centerY = triangle.reduce((sum, point) => sum + point.y, 0) / 3;
      const centerZ = triangle.reduce((sum, point) => sum + point.z, 0) / 3;
      if (onMouthPlane && centerY > 0.05 && centerY < field.goalHeight - 0.05 && Math.abs(centerZ) < field.goalHalfWidth - 0.05) blockers++;
    }
    assert.equal(blockers, 0, `goal mouth ${side} must remain open`);
  }
});
