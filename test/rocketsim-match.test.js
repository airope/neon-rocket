import test from 'node:test';
import assert from 'node:assert/strict';
import { CAR_SOCCER_FIELD } from '../shared/car-soccer-contract.js';

const MODULE_URL = new URL('../shared/rocketsim-match.js', import.meta.url);

test('RocketSim match scores only when the whole ball crosses inside a goal mouth', async () => {
  const { goalTeamForBall } = await import(MODULE_URL);
  const field = CAR_SOCCER_FIELD;
  const radius = field.ballRadius;

  assert.equal(goalTeamForBall({ position: { x: field.halfLength + radius + .01, y: 2, z: 0 } }, field), 0);
  assert.equal(goalTeamForBall({ position: { x: -field.halfLength - radius - .01, y: 2, z: 0 } }, field), 1);
  assert.equal(goalTeamForBall({ position: { x: field.halfLength + radius + .01, y: 2, z: field.goalHalfWidth + .2 } }, field), null);
  assert.equal(goalTeamForBall({ position: { x: field.halfLength + radius + .01, y: field.goalHeight + .2, z: 0 } }, field), null);
  assert.equal(goalTeamForBall({ position: { x: field.halfLength + radius - .01, y: 2, z: 0 } }, field), null);
});
