import test from 'node:test';
import assert from 'node:assert/strict';
import { CAR_SOCCER_FIELD } from '../shared/car-soccer-contract.js';

const MODULE_URL = new URL('../shared/rocketsim-nova.js', import.meta.url);

test('NOVA 1 emits canonical RocketSim controls toward an off-axis ball', async () => {
  const { novaDirectControls } = await import(MODULE_URL);
  const controls = novaDirectControls({
    team: 0,
    car: {
      position: { x: -18, y: .2, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      rotation: { forward: { x: 1, y: 0, z: 0 } },
      boost: 33,
      wheelContactCount: 4
    },
    ball: { position: { x: 0, y: .92, z: 10 }, velocity: { x: 0, y: 0, z: 0 } },
    field: CAR_SOCCER_FIELD
  });

  assert.equal(controls.throttle, 1);
  assert.ok(controls.steer < 0, `expected right steer toward +Z, got ${controls.steer}`);
  assert.equal(controls.pitch, -1);
  assert.equal(controls.yaw, -controls.steer);
  assert.equal(controls.roll, 0);
  assert.equal(typeof controls.jump, 'boolean');
  assert.equal(typeof controls.boost, 'boolean');
  assert.equal(controls.handbrake, false);
});

test('NOVA versions dispatch distinct controllers over the same native state', async () => {
  const { controlsForNovaVersion } = await import(MODULE_URL);
  const context = {
    team: 1,
    car: {
      position: { x: 24, y: .2, z: 12 },
      velocity: { x: -3, y: 0, z: 0 },
      rotation: { forward: { x: -1, y: 0, z: 0 } },
      boost: 40,
      wheelContactCount: 4
    },
    ball: { position: { x: -8, y: 1.1, z: 3 }, velocity: { x: -12, y: 0, z: 4 } },
    field: CAR_SOCCER_FIELD,
    boostPads: []
  };
  const direct = controlsForNovaVersion(1, context);
  const tactical = controlsForNovaVersion(2, context);
  const wildfire = controlsForNovaVersion(3, context);

  assert.equal(direct.strategy, 'direct');
  assert.match(tactical.strategy, /tactical/);
  assert.match(wildfire.strategy, /wildfire/);
  for (const result of [direct, tactical, wildfire]) {
    assert.equal(result.throttle, 1);
    assert.ok(Number.isFinite(result.steer));
    assert.ok(result.steer >= -1 && result.steer <= 1);
  }
  assert.notDeepEqual(
    [tactical.steer, tactical.boost, tactical.strategy],
    [direct.steer, direct.boost, direct.strategy]
  );
});
