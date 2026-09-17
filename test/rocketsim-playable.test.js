import test from 'node:test';
import assert from 'node:assert/strict';

const CORE_URL = new URL('../public/rocketsim-playable-core.js', import.meta.url);

test('playable keyboard maps independent ground and aerial controls to RocketSim', async () => {
  const { controlsFromHeldKeys } = await import(CORE_URL);
  const controls = controlsFromHeldKeys(new Set([
    'KeyW', 'KeyD', 'ArrowUp', 'ArrowRight', 'KeyE',
    'Space', 'ShiftLeft', 'KeyC'
  ]));

  assert.deepEqual(controls, {
    throttle: 1,
    steer: -1,
    pitch: -1,
    yaw: -1,
    roll: 1,
    jump: true,
    boost: true,
    handbrake: true
  });
});

test('C activates powerslide without reserving browser Control shortcuts', async () => {
  const { controlsFromHeldKeys } = await import(CORE_URL);
  assert.equal(controlsFromHeldKeys(new Set(['KeyC'])).handbrake, true);
  assert.equal(controlsFromHeldKeys(new Set(['ControlLeft'])).handbrake, false);
  assert.equal(controlsFromHeldKeys(new Set(['ControlRight'])).handbrake, false);
});

test('playable keyboard releases to a neutral RocketSim command', async () => {
  const { controlsFromHeldKeys } = await import(CORE_URL);
  assert.deepEqual(controlsFromHeldKeys(new Set()), {
    throttle: 0,
    steer: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    jump: false,
    boost: false,
    handbrake: false
  });
});

test('arrow keys drive on the ground and control pitch/yaw in the air', async () => {
  const { controlsFromHeldKeys } = await import(CORE_URL);
  const controls = controlsFromHeldKeys(new Set(['ArrowUp', 'ArrowLeft']));
  assert.equal(controls.throttle, 1);
  assert.equal(controls.steer, 1);
  assert.equal(controls.pitch, -1);
  assert.equal(controls.yaw, 1);
});

test('moving native ball produces a normalized rolling quaternion', async () => {
  const { integrateRollingQuaternion } = await import(CORE_URL);
  const quaternion = integrateRollingQuaternion([0, 0, 0, 1], [12, 0, 4], .92, 1 / 120);
  assert.notDeepEqual(quaternion, [0, 0, 0, 1]);
  const norm = Math.hypot(...quaternion);
  assert.ok(Math.abs(norm - 1) < 1e-9, `quaternion norm ${norm}`);
});

test('chase camera stays above the arena when the car is inverted', async () => {
  const { chaseCameraPose } = await import(CORE_URL);
  const pose = chaseCameraPose(
    { x: 4, y: 0.4, z: -2 },
    { x: 1, y: 0, z: 0 }
  );
  assert.ok(pose.position.y >= 2.5);
  assert.ok(pose.lookAt.y > 0.4);
  assert.ok(pose.position.x < 4);
});

test('chase camera biases its target toward the ball without abandoning the car', async () => {
  const { chaseCameraPose } = await import(CORE_URL);
  const pose = chaseCameraPose(
    { x: 0, y: 0.4, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 12, y: 5, z: 8 }
  );
  assert.ok(pose.lookAt.x > 2.4 && pose.lookAt.x < 8);
  assert.ok(pose.lookAt.y > 1.2);
  assert.ok(pose.lookAt.z > 0);
});
