import test from 'node:test';
import assert from 'node:assert/strict';
import { CAR_SOCCER_FIELD, OCTANE_CLASS_CAR } from '../shared/car-soccer-contract.js';
import { FIELD as LEGACY_FIELD } from '../shared/arena-geometry.js';

test('new car-soccer arena uses a compact RocketSim-scale contract instead of V1 dimensions', () => {
  assert.equal(CAR_SOCCER_FIELD.halfLength, 51.2);
  assert.equal(CAR_SOCCER_FIELD.halfWidth, 40.96);
  assert.equal(CAR_SOCCER_FIELD.ceiling, 20.44);
  assert.equal(CAR_SOCCER_FIELD.ballRadius, 0.9125);
  assert.equal(CAR_SOCCER_FIELD.goalHalfWidth, 8.928);
  assert.equal(CAR_SOCCER_FIELD.goalHeight, 6.42);
  assert.ok(CAR_SOCCER_FIELD.halfLength < LEGACY_FIELD.halfX * 0.5);
  assert.ok(CAR_SOCCER_FIELD.ballRadius < LEGACY_FIELD.ballRadius * 0.5);
});

test('new vehicle contract defines a compact offset hitbox and four physical wheels', () => {
  assert.deepEqual(OCTANE_CLASS_CAR.hitboxSize, { x: 1.20507, y: 0.386591, z: 0.866994 });
  assert.deepEqual(OCTANE_CLASS_CAR.hitboxOffset, { x: 0.138757, y: 0.20755, z: 0 });
  assert.equal(OCTANE_CLASS_CAR.wheels.length, 4);
  assert.deepEqual(OCTANE_CLASS_CAR.wheels.map(wheel => wheel.axle), ['front', 'front', 'rear', 'rear']);
  assert.ok(OCTANE_CLASS_CAR.wheels.every(wheel => wheel.radius > 0 && wheel.suspensionRest > 0));
});
