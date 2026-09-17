import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSimulation, FIELD } from '../shared/simulation-v3.js';
import { rotateLocalVector } from '../shared/rapier-car-controller.js';

const DT = 1 / 120;

function placeForPositiveSideWall(simulation, player) {
  player.body.position.set(0, 0.65, FIELD.halfZ - FIELD.curveRadius - 5);
  player.body.quaternion.setFromEuler(0, -Math.PI / 2, 0, 'XYZ');
  player.body.velocity.setZero();
  player.body.angularVelocity.setZero();
  simulation.status = 'playing';
}

test('powered car keeps wheel contact while climbing a side bank and recovers wheels-first after release', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  try {
    const player = simulation.addPlayer({ id: 'wall-driver', team: 0 });
    placeForPositiveSideWall(simulation, player);
    simulation.setInput(player.id, { throttle: 1, boost: true });

    let maxHeight = player.body.position.y;
    let wallFrames = 0;
    let wallContactFrames = 0;
    let maxAngularSpeed = 0;
    for (let tick = 0; tick < 360; tick++) {
      simulation.step(DT);
      maxHeight = Math.max(maxHeight, player.body.position.y);
      maxAngularSpeed = Math.max(maxAngularSpeed, player.body.angularVelocity.length());
      if (player.body.position.y > 1.5) {
        wallFrames++;
        if (player.controller.wheelContacts().filter(Boolean).length >= 2) wallContactFrames++;
      }
    }

    assert.ok(maxHeight > 2.5, `car never climbed the bank: max y=${maxHeight}`);
    assert.ok(wallFrames > 20, `wall phase too short: ${wallFrames} frames`);
    assert.ok(wallContactFrames / wallFrames >= 0.4, `wall wheel-contact ratio ${wallContactFrames}/${wallFrames}`);
    assert.ok(maxAngularSpeed < 6, `wall transition spun too fast: ${maxAngularSpeed}`);

    simulation.setInput(player.id, { throttle: 0, boost: false, steer: 0, jump: false, airRoll: 0 });
    for (let tick = 0; tick < 480; tick++) simulation.step(DT);

    const localUp = rotateLocalVector({ x: 0, y: 1, z: 0 }, player.rigidBody.rotation());
    const contacts = player.controller.wheelContacts().filter(Boolean).length;
    assert.ok(player.body.position.y < 1, `car did not return to the floor: y=${player.body.position.y}`);
    assert.ok(localUp.y > 0.65, `car did not recover wheels-first: up.y=${localUp.y}`);
    assert.ok(contacts >= 2, `car recovered with only ${contacts}/4 wheel contacts`);
  } finally {
    simulation.free();
  }
});
