import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GameSimulation, sanitizeInput } from '../shared/simulation-v3.js';
import { rotateLocalVector } from '../shared/rapier-car-controller.js';

const DT = 1 / 120;

function runningCar() {
  const simulation = new GameSimulation({ mode: 'solo' });
  const player = simulation.addPlayer({ id: 'driver', team: 0 });
  simulation.status = 'playing';
  return { simulation, player };
}

test('opposite throttle brakes hard before reverse propulsion engages', () => {
  const { simulation, player } = runningCar();
  try {
    simulation.setInput(player.id, { throttle: 1 });
    for (let tick = 0; tick < 240; tick++) simulation.step(DT);
    const forwardSpeed = player.controller.vehicle.currentVehicleSpeed();
    assert.ok(forwardSpeed > 17, `forward setup speed ${forwardSpeed}`);

    simulation.setInput(player.id, { throttle: -1 });
    for (let tick = 0; tick < 60; tick++) simulation.step(DT);
    const brakingSpeed = player.controller.vehicle.currentVehicleSpeed();
    assert.ok(brakingSpeed >= -0.5, `reverse engaged before braking completed: ${brakingSpeed}`);
    assert.ok(brakingSpeed < 7, `opposite throttle did not brake hard enough: ${brakingSpeed}`);

    for (let tick = 0; tick < 90; tick++) simulation.step(DT);
    const reverseSpeed = player.controller.vehicle.currentVehicleSpeed();
    assert.ok(reverseSpeed < -2, `reverse propulsion never engaged: ${reverseSpeed}`);
  } finally {
    simulation.free();
  }
});

function runTurnRoute(handbrake) {
  const { simulation, player } = runningCar();
  try {
    simulation.setInput(player.id, { throttle: 1 });
    for (let tick = 0; tick < 180; tick++) simulation.step(DT);
    simulation.setInput(player.id, { throttle: 1, steer: 1, handbrake });
    let maxLateralSlip = 0;
    for (let tick = 0; tick < 120; tick++) {
      simulation.step(DT);
      const tickVelocity = player.rigidBody.linvel();
      const tickRight = rotateLocalVector({ x: 0, y: 0, z: 1 }, player.rigidBody.rotation());
      const tickSpeed = Math.hypot(tickVelocity.x, tickVelocity.y, tickVelocity.z);
      const tickSlip = Math.abs(tickVelocity.x * tickRight.x + tickVelocity.y * tickRight.y + tickVelocity.z * tickRight.z)
        / Math.max(tickSpeed, 1e-6);
      maxLateralSlip = Math.max(maxLateralSlip, tickSlip);
    }
    const position = { ...player.rigidBody.translation() };
    const velocity = player.rigidBody.linvel();
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    return { position, speed, maxLateralSlip };
  } finally {
    simulation.free();
  }
}

test('handbrake is sanitized and produces a distinct controlled powerslide route', () => {
  assert.equal(sanitizeInput({ handbrake: true }).handbrake, true);
  const gripTurn = runTurnRoute(false);
  const powerslide = runTurnRoute(true);
  const routeDifference = Math.hypot(
    powerslide.position.x - gripTurn.position.x,
    powerslide.position.z - gripTurn.position.z
  );
  assert.ok(routeDifference >= 1.9, `powerslide route difference ${routeDifference}`);
  assert.ok(powerslide.maxLateralSlip > gripTurn.maxLateralSlip + 0.08,
    `powerslide slip ${powerslide.maxLateralSlip}, grip slip ${gripTurn.maxLateralSlip}`);
  assert.ok(powerslide.speed > 7, `powerslide killed momentum: ${powerslide.speed}`);
});

test('an idle car resting on its roof recovers progressively onto its wheels', () => {
  const { simulation, player } = runningCar();
  try {
    player.rigidBody.setTranslation({ x: 0, y: 1.2, z: 0 }, true);
    player.rigidBody.setRotation({ x: 1, y: 0, z: 0, w: 0 }, true);
    player.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    player.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const initialUp = rotateLocalVector({ x: 0, y: 1, z: 0 }, player.rigidBody.rotation());
    assert.ok(initialUp.y < -0.95, `fixture is not upside down: ${initialUp.y}`);
    let maxAngularSpeed = 0;
    for (let tick = 0; tick < 480; tick++) {
      simulation.step(DT);
      const angular = player.rigidBody.angvel();
      maxAngularSpeed = Math.max(maxAngularSpeed, Math.hypot(angular.x, angular.y, angular.z));
    }
    const finalUp = rotateLocalVector({ x: 0, y: 1, z: 0 }, player.rigidBody.rotation());
    const contacts = player.controller.wheelContacts().filter(Boolean).length;
    assert.ok(finalUp.y > 0.7, `car stayed roof-down: up.y=${finalUp.y}`);
    assert.ok(contacts >= 2, `car recovered orientation without landing wheels: ${contacts}/4 contacts`);
    assert.ok(maxAngularSpeed <= 5.5 + 1e-6, `recovery exceeded angular safety cap: ${maxAngularSpeed}`);
  } finally {
    simulation.free();
  }
});

test('browser keyboard and gamepad expose powerslide without browser Control shortcuts', () => {
  const game = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  const controls = readFileSync(new URL('../public/rocketsim-playable-core.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(game, /Object\.assign\(inputState, controlsFromHeldKeys\(held\)\)/);
  assert.match(controls, /handbrake:.*KeyC/);
  assert.doesNotMatch(controls, /handbrake:.*ControlLeft|handbrake:.*ControlRight/);
  assert.match(game, /pad\.buttons\[2\].*handbrake|handbrake.*pad\.buttons\[2\]/);
  assert.match(html, /C · POWERSLIDE/);
  assert.match(html, /data-key="handbrake"/);
});
