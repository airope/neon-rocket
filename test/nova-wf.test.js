import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSimulation } from '../shared/simulation.js';
import {
  NOVA_WF_DEFAULTS,
  chooseNovaWfState,
  driveToTarget,
  findReachableIntercept,
  shadowTarget,
  simulateCar1D
} from '../shared/nova-wf.js';

const field = { halfX: 120, halfZ: 60, goalHalf: 19.875, goalHeight: 8, goalDepth: 12, curveRadius: 12, cornerRadius: 18, ballRadius: 1.875 };

test('Wildfire Car1D is deterministic and boost improves arrival distance', () => {
  const withoutBoost = simulateCar1D({ seconds: 1, initialSpeed: 0, boost: 0 });
  const withBoost = simulateCar1D({ seconds: 1, initialSpeed: 0, boost: 33 });
  assert.deepEqual(withoutBoost, simulateCar1D({ seconds: 1, initialSpeed: 0, boost: 0 }));
  assert.ok(withoutBoost.distance > 5);
  assert.ok(withBoost.distance > withoutBoost.distance);
  assert.ok(withBoost.speed <= NOVA_WF_DEFAULTS.boostSpeedCap);
});

test('Wildfire intercept picks the earliest reachable slice and offsets contact behind the shot', () => {
  const trajectory = [
    { time: .2, position: { x: 30, y: 2, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
    { time: 1, position: { x: 12, y: 2, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
    { time: 2, position: { x: 20, y: 2, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }
  ];
  const intercept = findReachableIntercept({
    car: { position: { x: 0, y: .7, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, boost: 33 },
    trajectory,
    target: { x: 132, y: 0, z: 0 },
    field
  });
  assert.equal(intercept.time, 1);
  assert.ok(intercept.contactPosition.x < intercept.ballPosition.x);
  assert.ok(intercept.arrivalSlack >= 0);
});

test('Wildfire interception budgets deterministic turning time before acceleration', () => {
  const trajectory = [
    { time: 1, position: { x: -12, y: 2, z: 0 } },
    { time: 2, position: { x: -12, y: 2, z: 0 } }
  ];
  const intercept = findReachableIntercept({
    car: { position: { x: 0, y: .7, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, boost: 33 },
    trajectory, target: { x: -132, y: 0, z: 0 }, field
  });
  assert.equal(intercept.time, 2);
  assert.ok(intercept.turnTime > 1);
});

test('Wildfire state priority separates kickoff, clear, patient shot, shadow and fallback', () => {
  const base = { attack: 1, field, ball: { position: { x: 0, y: 2, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }, selfArrival: 1, opponentArrival: 1.2, cleanShot: true, laterCleanShot: false, boost: 33 };
  assert.equal(chooseNovaWfState({ ...base, kickoff: true }), 'kickoff');
  assert.equal(chooseNovaWfState({ ...base, ball: { position: { x: -80, y: 2, z: 0 }, velocity: { x: -12, y: 0, z: 0 } } }), 'clear');
  assert.equal(chooseNovaWfState({ ...base, safeBoostRoute: true, boost: 33 }), 'fallback');
  assert.equal(chooseNovaWfState({ ...base, safeBoostRoute: true, boost: 10 }), 'fallback');
  assert.equal(chooseNovaWfState({ ...base, safeBoostRoute: true, boost: 10, opponentArrival: 2 }), 'boost-route');
  assert.equal(chooseNovaWfState({ ...base, cleanShot: false, laterCleanShot: true }), 'patient-shot');
  assert.equal(chooseNovaWfState({ ...base, selfArrival: 2, opponentArrival: 1 }), 'shadow');
  assert.equal(chooseNovaWfState(base), 'fallback');
});

test('Wildfire shadow target never crosses behind its own goal line', () => {
  const target = shadowTarget({ x: -field.halfX + 2, y: 2, z: 0 }, 1, field);
  assert.ok(target.x >= -field.halfX + 1);
});

test('Wildfire driving preserves full throttle and steers toward the target', () => {
  const input = driveToTarget({ position: { x: 0, z: 0 }, yaw: 0, boost: 33 }, { x: 20, z: 8 }, { urgent: true });
  assert.equal(input.throttle, 1);
  assert.ok(input.steer > 0);
  assert.equal(input.boost, false);
});

test('NOVA-WF parameters are injected into a simulation and govern commitments', () => {
  const simulation = new GameSimulation({ mode: 'duel', novaWfParameters: { urgentCommitSeconds: .91 } });
  const wildfire = simulation.addPlayer({ id: 'WF', team: 0, isBot: true, aiVersion: 3 });
  simulation.addPlayer({ id: 'N2', team: 1, isBot: true, aiVersion: 2 });
  simulation.status = 'playing';
  simulation.ball.position.set(-80, 3, 0);
  simulation.ball.velocity.set(-12, 0, 0);
  simulation.step(1 / 60);
  assert.ok(wildfire.aiCommitTimer > .85);
});

test('NOVA-WF contest timing includes an opponent that must turn around', () => {
  const simulation = new GameSimulation({ mode: 'duel' });
  const wildfire = simulation.addPlayer({ id: 'WF', team: 0, isBot: true, aiVersion: 3 });
  const opponent = simulation.addPlayer({ id: 'N2', team: 1, isBot: true, aiVersion: 2 });
  simulation.status = 'playing';
  wildfire.aiKickoffActive = false;
  wildfire.body.position.set(-10, .78, 0);
  wildfire.body.quaternion.setFromEuler(0, 0, 0, 'XYZ');
  opponent.body.position.set(2, .78, 0);
  opponent.body.quaternion.setFromEuler(0, 0, 0, 'XYZ');
  simulation.ball.position.set(0, 2, 0);
  simulation.ball.velocity.setZero();
  simulation.step(1 / 60);
  assert.notEqual(wildfire.aiState, 'shadow');
});

test('NOVA-WF never dodges into a ball that is behind it toward its own goal', () => {
  const simulation = new GameSimulation({ mode: 'duel' });
  const wildfire = simulation.addPlayer({ id: 'WF', team: 0, isBot: true, aiVersion: 3 });
  simulation.addPlayer({ id: 'N2', team: 1, isBot: true, aiVersion: 2 });
  simulation.status = 'playing';
  simulation.ball.position.set(wildfire.body.position.x - 3, 2, wildfire.body.position.z);
  simulation.ball.velocity.set(-12, 0, 0);
  simulation.step(1 / 60);
  assert.equal(wildfire.aiAction, null);
});

test('NOVA-WF integrates as AI version 3 and keeps an urgent state committed across ticks', () => {
  const simulation = new GameSimulation({ mode: 'duel', targetScore: 1 });
  const wildfire = simulation.addPlayer({ id: 'WF', team: 0, isBot: true, aiVersion: 3 });
  simulation.addPlayer({ id: 'N2', team: 1, isBot: true, aiVersion: 2 });
  simulation.start();
  simulation.status = 'playing';
  simulation.ball.position.set(-80, 2, 0);
  simulation.ball.velocity.set(-12, 0, 0);

  simulation.step(1 / 60);
  assert.equal(wildfire.aiState, 'clear');
  assert.equal(wildfire.input.throttle, 1);
  assert.ok(wildfire.aiCommitTimer > 0);
  const telemetry = simulation.snapshot().players.find(player => player.id === 'WF').ai;
  assert.equal(telemetry.controllerId, 3);
  assert.equal(telemetry.state, 'clear');
  assert.ok(telemetry.commitTime > 0);
  assert.ok(Object.hasOwn(telemetry, 'action'));

  simulation.ball.position.set(70, 2, 20);
  simulation.ball.velocity.setZero();
  simulation.step(1 / 60);
  assert.equal(wildfire.aiState, 'clear', 'active state must not oscillate before commit expiry');
});
