import test from 'node:test';
import assert from 'node:assert/strict';
import { RAPIER } from '../shared/rapier-engine.js';
import { CAR_SOCCER_FIELD } from '../shared/car-soccer-contract.js';
import { buildRapierArena, RAPIER_ARENA_VERSION } from '../shared/rapier-arena.js';

test('new Rapier arena has a distinct compact collider topology with shared render meshes', () => {
  const world = new RAPIER.World({ x: 0, y: -13, z: 0 });
  try {
    const arena = buildRapierArena(world);
    assert.equal(RAPIER_ARENA_VERSION, 'neon-prism-bowl-v3');
    assert.ok(arena.colliders.length >= 30, `only ${arena.colliders.length} colliders`);
    assert.ok(arena.renderMeshes.floorCornerRamps.vertices.length > 100);
    assert.ok(arena.renderMeshes.roofCornerRamps.vertices.length > 100);
    assert.equal(arena.field, CAR_SOCCER_FIELD);
    assert.ok(arena.parts.has('goal-tunnels'));
    assert.ok(arena.parts.has('octagonal-corners'));
    assert.ok(arena.parts.has('floor-banks'));
  } finally {
    world.free();
  }
});

test('CCD ball remains inside the compact bowl after a high-speed side impact', () => {
  const world = new RAPIER.World({ x: 0, y: -13, z: 0 });
  world.timestep = 1 / 120;
  try {
    buildRapierArena(world);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 3, 0)
        .setLinvel(0, 0, 60)
        .setCcdEnabled(true)
        .setCanSleep(false)
    );
    world.createCollider(
      RAPIER.ColliderDesc.ball(CAR_SOCCER_FIELD.ballRadius)
        .setMass(28)
        .setRestitution(0.71),
      body
    );
    for (let tick = 0; tick < 360; tick++) world.step();
    const position = body.translation();
    assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z));
    assert.ok(Math.abs(position.z) <= CAR_SOCCER_FIELD.halfWidth + 0.2, `escaped at z=${position.z}`);
    assert.ok(position.y >= -0.1 && position.y <= CAR_SOCCER_FIELD.ceiling + 0.2, `escaped at y=${position.y}`);
  } finally {
    world.free();
  }
});
