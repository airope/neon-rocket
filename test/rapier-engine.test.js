import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVehiclePhysicsHarness, ENGINE_CONTRACT } from '../shared/rapier-engine.js';
import { OCTANE_CLASS_CAR } from '../shared/car-soccer-contract.js';

test('new authoritative physics contract is deterministic Rapier at 120 Hz', async () => {
  assert.equal(ENGINE_CONTRACT.id, 'rapier3d-deterministic');
  assert.equal(ENGINE_CONTRACT.tickRate, 120);
  assert.equal(ENGINE_CONTRACT.vehicleModel, 'four-wheel-raycast-suspension');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dependencies['@dimforge/rapier3d-deterministic-compat']);
});

test('a real four-wheel Rapier chassis settles on all suspensions', async () => {
  const harness = await createVehiclePhysicsHarness();
  try {
    for (let i = 0; i < ENGINE_CONTRACT.tickRate * 2; i++) harness.step();
    assert.deepEqual(harness.wheelContacts(), [true, true, true, true]);
    assert.ok(harness.chassis.translation().y > 0.18);
    assert.ok(harness.chassis.translation().y < 0.35);
  } finally {
    harness.free();
  }
});

test('Rapier wheels and mass come from the compact car-soccer contract', async () => {
  const harness = await createVehiclePhysicsHarness();
  try {
    assert.ok(Math.abs(harness.chassis.mass() - OCTANE_CLASS_CAR.mass) < 1e-3);
    for (let index = 0; index < OCTANE_CLASS_CAR.wheels.length; index++) {
      const expected = OCTANE_CLASS_CAR.wheels[index];
      assert.ok(Math.abs(harness.vehicle.wheelRadius(index) - expected.radius) < 1e-6);
      assert.ok(Math.abs(harness.vehicle.wheelSuspensionRestLength(index) - expected.suspensionRest) < 1e-6);
      const point = harness.vehicle.wheelChassisConnectionPointCs(index);
      assert.ok(Math.abs(point.x - expected.x) < 1e-6);
      assert.ok(Math.abs(point.y - expected.y) < 1e-6);
      assert.ok(Math.abs(point.z - expected.z) < 1e-6);
    }
  } finally {
    harness.free();
  }
});

test('four driven suspensions reach car-soccer speed without V1 lateral sliding', async () => {
  const harness = await createVehiclePhysicsHarness();
  try {
    for (let i = 0; i < ENGINE_CONTRACT.tickRate * 2; i++) harness.step();
    const start = harness.chassis.translation();
    harness.setInput({ throttle: 1 });
    for (let i = 0; i < ENGINE_CONTRACT.tickRate * 3; i++) harness.step();
    const end = harness.chassis.translation();
    const speed = Math.abs(harness.vehicle.currentVehicleSpeed());
    assert.ok(speed >= 20, `expected at least 20 m/s, got ${speed}`);
    assert.ok(speed <= 24, `expected at most 24 m/s, got ${speed}`);
    assert.ok(Math.abs(end.z - start.z) < 0.25, `lateral drift ${end.z - start.z}`);
    assert.ok(harness.wheelContacts().filter(Boolean).length >= 3);
  } finally {
    harness.free();
  }
});

test('held first jump leaves the suspension and reaches a controlled car-soccer apex', async () => {
  const harness = await createVehiclePhysicsHarness();
  try {
    for (let i = 0; i < ENGINE_CONTRACT.tickRate; i++) harness.step();
    harness.setInput({ jump: true });
    let apex = harness.chassis.translation().y;
    for (let i = 0; i < 24; i++) {
      harness.step();
      apex = Math.max(apex, harness.chassis.translation().y);
    }
    harness.setInput({ jump: false });
    for (let i = 0; i < ENGINE_CONTRACT.tickRate * 2; i++) {
      harness.step();
      apex = Math.max(apex, harness.chassis.translation().y);
    }
    assert.ok(apex > 1.8, `jump apex too low: ${apex}`);
    assert.ok(apex < 3.2, `jump apex too high: ${apex}`);
    assert.ok(harness.telemetry().airborneTicks > 30);
  } finally {
    harness.free();
  }
});

test('second jump with directional input creates a forward dodge and consumes the aerial jump', async () => {
  const harness = await createVehiclePhysicsHarness();
  try {
    for (let i = 0; i < ENGINE_CONTRACT.tickRate; i++) harness.step();
    harness.setInput({ jump: true });
    for (let i = 0; i < 12; i++) harness.step();
    harness.setInput({ jump: false });
    for (let i = 0; i < 10; i++) harness.step();
    const before = harness.chassis.linvel();
    harness.setInput({ jump: true, throttle: 1 });
    harness.step();
    const after = harness.chassis.linvel();
    assert.ok(after.x - before.x > 4.5, `forward dodge impulse ${after.x - before.x}`);
    assert.ok(Math.abs(harness.chassis.angvel().z) > 0.5);
    assert.equal(harness.telemetry().secondJumpAvailable, false);
  } finally {
    harness.free();
  }
});

test('airborne controls create independent local pitch yaw and roll authority', async () => {
  const harness = await createVehiclePhysicsHarness();
  try {
    for (let i = 0; i < ENGINE_CONTRACT.tickRate; i++) harness.step();
    harness.setInput({ jump: true });
    for (let i = 0; i < 10; i++) harness.step();
    harness.setInput({ jump: false, throttle: 0.8, steer: 0.7, airRoll: 0.9 });
    for (let i = 0; i < 30; i++) harness.step();
    const angular = harness.chassis.angvel();
    assert.ok(Math.abs(angular.z) > 0.35, `pitch authority ${angular.z}`);
    assert.ok(Math.abs(angular.y) > 0.15, `yaw authority ${angular.y}`);
    assert.ok(Math.abs(angular.x) > 0.25, `roll authority ${angular.x}`);
    assert.ok(Math.hypot(angular.x, angular.y, angular.z) < 6.5);
  } finally {
    harness.free();
  }
});

test('airborne boost accelerates along the car nose and consumes a finite tank', async () => {
  const harness = await createVehiclePhysicsHarness();
  try {
    for (let i = 0; i < ENGINE_CONTRACT.tickRate; i++) harness.step();
    harness.setInput({ jump: true });
    for (let i = 0; i < 10; i++) harness.step();
    harness.setInput({ jump: false, throttle: 0, steer: 0, airRoll: 0, boost: true });
    const before = harness.chassis.linvel();
    for (let i = 0; i < 24; i++) harness.step();
    const after = harness.chassis.linvel();
    assert.ok(after.x - before.x > 2.5, `boost delta ${after.x - before.x}`);
    assert.ok(harness.telemetry().boost < 100);
    assert.ok(harness.telemetry().boost > 90);
  } finally {
    harness.free();
  }
});
