import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GameSimulation, FIELD } from '../shared/simulation.js';

function createPlayer() {
  const simulation = new GameSimulation({ mode: 'solo' });
  const player = simulation.addPlayer({ id: 'me', team: 0 });
  simulation.start();
  simulation.status = 'playing';
  return { simulation, player };
}

function drive({ steer = 0, ticks = 90 } = {}) {
  const { simulation, player } = createPlayer();
  const initialZ = player.body.position.z;
  const heights = [];

  for (let i = 0; i < ticks; i++) {
    simulation.setInput('me', { throttle: 1, steer });
    simulation.step(1 / 60);
    heights.push(player.body.position.y);
  }

  return {
    player,
    speed: Math.hypot(player.body.velocity.x, player.body.velocity.z),
    lateralDrift: Math.abs(player.body.position.z - initialZ),
    verticalJitter: Math.max(...heights.slice(15)) - Math.min(...heights.slice(15))
  };
}

test('ball trajectory prediction is deterministic and never mutates the authoritative ball', () => {
  const simulation = new GameSimulation({ mode: 'duel' });
  simulation.ball.position.set(10, 8, 12);
  simulation.ball.velocity.set(18, 4, 9);
  simulation.ball.angularVelocity.set(1, 2, 3);
  const before = {
    position: simulation.ball.position.clone(),
    velocity: simulation.ball.velocity.clone(),
    angularVelocity: simulation.ball.angularVelocity.clone()
  };

  const first = simulation.predictBallTrajectory({ horizon: 1, sliceDt: 1 / 60, physicsDt: 1 / 120 });
  const second = simulation.predictBallTrajectory({ horizon: 1, sliceDt: 1 / 60, physicsDt: 1 / 120 });

  assert.equal(first.length, 60);
  assert.deepEqual(first, second);
  assert.deepEqual(simulation.ball.position, before.position);
  assert.deepEqual(simulation.ball.velocity, before.velocity);
  assert.deepEqual(simulation.ball.angularVelocity, before.angularVelocity);
  assert.ok(first.every(slice => Number.isFinite(slice.position.x) && Number.isFinite(slice.velocity.y)));
});

test('cars collide physically instead of passing through each other', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  const left = simulation.addPlayer({ id: 'left', team: 0 });
  const right = simulation.addPlayer({ id: 'right', team: 1 });
  simulation.status = 'playing';
  left.body.position.set(-5, .68, 0);
  right.body.position.set(5, .68, 0);
  left.body.quaternion.setFromEuler(0, 0, 0, 'XYZ');
  right.body.quaternion.setFromEuler(0, Math.PI, 0, 'XYZ');
  left.body.velocity.set(24, 0, 0);
  right.body.velocity.set(-24, 0, 0);

  for (let frame = 0; frame < 60; frame++) simulation.step(1 / 60);

  assert.ok(left.body.position.x < right.body.position.x, `cars crossed through each other: left=${left.body.position.x}, right=${right.body.position.x}`);
  assert.ok(right.body.position.x - left.body.position.x > 2.5, 'collision did not preserve chassis separation');
});

test('accelerating straight is fast, stable and does not drift sideways', () => {
  const result = drive();
  assert.ok(result.speed > 18, `speed was only ${result.speed.toFixed(3)} m/s`);
  assert.ok(result.lateralDrift < 0.12, `lateral drift was ${result.lateralDrift.toFixed(3)} m`);
  assert.ok(result.verticalJitter < 0.01, `vertical jitter was ${result.verticalJitter.toFixed(3)} m`);
});

test('duel resets play without changing score when both AIs are immobilized', () => {
  const simulation = new GameSimulation({ mode: 'duel' });
  const nova1 = simulation.addPlayer({ id: 'NOVA1', team: 0, isBot: true, aiVersion: 1 });
  const nova2 = simulation.addPlayer({ id: 'NOVA2', team: 1, isBot: true, aiVersion: 2 });
  simulation.start();
  simulation.status = 'playing';
  simulation.score = [2, 3];
  nova1.body.position.set(103, .68, 49);
  nova2.body.position.set(104, .68, -4);
  simulation.ball.position.set(66, FIELD.ballRadius, -22);
  simulation.ball.velocity.set(0, 0, 2.2);
  let resetEvent = null;

  for (let frame = 0; frame < 420 && !resetEvent; frame++) {
    nova1.body.velocity.setZero();
    nova1.body.angularVelocity.setZero();
    nova2.body.velocity.setZero();
    nova2.body.angularVelocity.setZero();
    simulation.ball.velocity.x = 0;
    simulation.ball.velocity.z = 2.2;
    simulation.step(1 / 60);
    resetEvent = simulation.drainEvents().find(event => event.type === 'duelReset') || null;
  }

  assert.ok(resetEvent, 'collective deadlock was not detected');
  assert.deepEqual(simulation.score, [2, 3], 'deadlock reset changed the score');
  assert.equal(simulation.status, 'countdown');
  assert.ok(Math.abs(simulation.ball.position.x) < .01, 'ball was not returned to a neutral kickoff');
});

test('a deterministic NOVA 1 versus NOVA 2 duel reaches a real winning goal', () => {
  const originalRandom = Math.random;
  Math.random = () => .5;
  try {
    const simulation = new GameSimulation({ mode: 'duel', targetScore: 1 });
    simulation.addPlayer({ id: 'NOVA1', name: 'NOVA 1', team: 0, isBot: true, aiVersion: 1 });
    simulation.addPlayer({ id: 'NOVA2', name: 'NOVA 2', team: 1, isBot: true, aiVersion: 2 });
    simulation.start();
    for (let tick = 0; tick < 10800 && simulation.status !== 'finished'; tick++) simulation.step(1 / 60);
    assert.equal(simulation.status, 'finished');
    assert.equal(simulation.score[0] + simulation.score[1], 1);
    assert.ok(simulation.winner === 0 || simulation.winner === 1);
  } finally {
    Math.random = originalRandom;
  }
});

test('simulation rejects a non-function random source', () => {
  assert.throws(() => new GameSimulation({ random: 42 }), /random must be a function/);
});

test('simulation uses its injected random source for deterministic bot decisions', () => {
  const originalRandom = Math.random;
  Math.random = () => 1;
  try {
    const simulation = new GameSimulation({ mode: 'solo', random: () => 0 });
    simulation.addPlayer({ id: 'human', team: 0 });
    const nova = simulation.addPlayer({ id: 'nova', team: 1, isBot: true, aiVersion: 1 });
    simulation.start();
    simulation.status = 'playing';
    nova.body.position.set(0, .68, 0);
    simulation.ball.position.set(-2.8, 4, 0);
    simulation.ball.velocity.setZero();

    simulation.step(1 / 60);

    assert.equal(nova.input.jump, true, 'injected RNG must override global Math.random');
  } finally {
    Math.random = originalRandom;
  }
});

test('NOVA 1 remains available as the original direct controller', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  const human = simulation.addPlayer({ id: 'human', team: 0 });
  const nova = simulation.addPlayer({ id: 'nova', name: 'NOVA 1', team: 1, isBot: true, aiVersion: 1 });
  simulation.start();
  simulation.status = 'playing';
  human.body.position.set(-100, .68, -50);
  nova.body.position.set(70, .68, 20);
  simulation.ball.position.set(30, FIELD.ballRadius + .1, 30);
  simulation.ball.velocity.setZero();

  simulation.step(1 / 60);

  assert.equal(nova.aiState, 'nova1');
  assert.ok(Math.abs(nova.aiTarget.x - (simulation.ball.position.x + 2.8)) < .1);
  assert.ok(Math.abs(nova.aiTarget.z - simulation.ball.position.z) < .1, 'NOVA 1 should retain its direct lateral chase target');
  assert.equal(nova.input.throttle, 1);
});

test('NOVA 2 predicts an incoming own-goal threat and switches to save', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  simulation.addPlayer({ id: 'human', team: 0 });
  const nova = simulation.addPlayer({ id: 'nova', name: 'NOVA 2', team: 1, isBot: true });
  simulation.start();
  simulation.status = 'playing';
  simulation.ball.position.set(62, 2.2, 0);
  simulation.ball.velocity.set(34, 0, 0);

  simulation.step(1 / 60);

  assert.equal(nova.aiState, 'save');
  assert.ok(nova.aiTarget.x > simulation.ball.position.x, `NOVA did not lead the incoming ball: target=${nova.aiTarget.x.toFixed(2)}, ball=${simulation.ball.position.x.toFixed(2)}`);
});

test('NOVA 2 approaches an own-goal threat from the goal side to clear it outward', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  simulation.addPlayer({ id: 'human', team: 0 });
  const nova = simulation.addPlayer({ id: 'nova', name: 'NOVA 2', team: 1, isBot: true });
  simulation.start();
  simulation.status = 'playing';
  simulation.ball.position.set(62, FIELD.ballRadius + .1, 25);
  simulation.ball.velocity.set(34, 0, 0);

  simulation.step(1 / 60);

  assert.equal(nova.aiState, 'save');
  assert.ok(nova.aiTarget.x > 83, `clearance point is not behind the predicted threat: x=${nova.aiTarget.x}`);
  assert.ok(nova.aiTarget.z > 25.2, `clearance point does not angle the ball away from the side of NOVA goal: z=${nova.aiTarget.z}`);
});

test('NOVA 2 leads a moving ball instead of chasing its current coordinates', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  const human = simulation.addPlayer({ id: 'human', team: 0 });
  const nova = simulation.addPlayer({ id: 'nova', name: 'NOVA 2', team: 1, isBot: true });
  simulation.start();
  simulation.status = 'playing';
  human.body.position.set(-105, .68, -50);
  simulation.ball.position.set(0, FIELD.ballRadius + .1, 0);
  simulation.ball.velocity.set(-8, 0, 14);

  simulation.step(1 / 60);

  assert.equal(nova.aiState, 'intercept');
  assert.ok(nova.aiInterceptTime >= .2, `invalid intercept horizon: ${nova.aiInterceptTime}`);
  assert.ok(nova.aiTarget.z > 4, `NOVA chased the old lateral coordinate: z=${nova.aiTarget.z.toFixed(2)}`);
});

test('NOVA 2 keeps full throttle near an interception to preserve arcade agility', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  simulation.addPlayer({ id: 'human', team: 0 });
  const nova = simulation.addPlayer({ id: 'nova', name: 'NOVA 2', team: 1, isBot: true });
  simulation.start();
  simulation.status = 'playing';
  nova.body.velocity.set(-25, 0, 0);
  simulation.ball.position.set(15, FIELD.ballRadius + .1, 3.2);
  simulation.ball.velocity.setZero();

  simulation.step(1 / 60);

  assert.equal(nova.input.throttle, 1, `NOVA softened near the ball: throttle=${nova.input.throttle}`);
});

test('NOVA 2 aggressively retrieves a low ball even when the opponent is closer', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  const human = simulation.addPlayer({ id: 'human', team: 0 });
  const nova = simulation.addPlayer({ id: 'nova', name: 'NOVA 2', team: 1, isBot: true });
  simulation.start();
  simulation.status = 'playing';
  human.body.position.set(31, .68, 0);
  nova.body.position.set(70, .68, 0);
  simulation.ball.position.set(30, FIELD.ballRadius + .1, 0);
  simulation.ball.velocity.setZero();

  simulation.step(1 / 60);

  assert.equal(nova.aiState, 'hunt');
  assert.ok(Math.abs(nova.aiTarget.x - (simulation.ball.position.x + 2.8)) < .1, `NOVA did not use its direct NOVA 1 retrieval point: ${nova.aiTarget.x}`);
  assert.equal(nova.input.throttle, 1);
});

test('NOVA 2 places its contact point to shoot a lateral ball toward the opposing camp', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  const human = simulation.addPlayer({ id: 'human', team: 0 });
  const nova = simulation.addPlayer({ id: 'nova', name: 'NOVA 2', team: 1, isBot: true });
  simulation.start();
  simulation.status = 'playing';
  human.body.position.set(-100, .68, -50);
  nova.body.position.set(70, .68, 20);
  simulation.ball.position.set(30, FIELD.ballRadius + .1, 30);
  simulation.ball.velocity.setZero();

  simulation.step(1 / 60);

  assert.equal(nova.aiState, 'hunt');
  assert.ok(nova.aiTarget.x > simulation.ball.position.x, 'contact point must stay behind the ball relative to the negative-X enemy camp');
  assert.ok(nova.aiTarget.z > simulation.ball.position.z + .2, `contact point did not angle the shot back toward midfield: target z=${nova.aiTarget.z}`);
});

test('NOVA 2 keeps carrying after its first retrieval contact accelerates the ball', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  const human = simulation.addPlayer({ id: 'human', team: 0 });
  const nova = simulation.addPlayer({ id: 'nova', name: 'NOVA 2', team: 1, isBot: true });
  simulation.start();
  simulation.status = 'playing';
  human.body.position.set(31, .68, 0);
  nova.body.position.set(70, .68, 0);
  simulation.ball.position.set(30, FIELD.ballRadius + .1, 0);
  simulation.ball.velocity.setZero();
  simulation.step(1 / 60);

  simulation.ball.velocity.set(-20, 0, 0);
  simulation.step(1 / 60);

  assert.equal(nova.aiState, 'carry');
  assert.equal(nova.input.throttle, 1);
  assert.ok(nova.aiTarget.x > simulation.ball.position.x, 'NOVA must stay behind the ball while carrying toward the negative-X goal');
});

test('NOVA 2 times elevated-ball jumps deterministically without random input', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  const human = simulation.addPlayer({ id: 'human', team: 0 });
  const nova = simulation.addPlayer({ id: 'nova', name: 'NOVA 2', team: 1, isBot: true });
  simulation.start();
  simulation.status = 'playing';
  human.body.position.set(-105, .68, -50);
  simulation.ball.position.set(20, 4, 3.2);
  simulation.ball.velocity.setZero();

  simulation.step(1 / 60);

  const source = readFileSync(new URL('../shared/simulation.js', import.meta.url), 'utf8');
  const botSection = source.slice(source.indexOf('#predictBall'), source.indexOf('step(dt'));
  assert.doesNotMatch(botSection, /Math\.random/);
  assert.equal(nova.input.jump, true);
  assert.ok(nova.aiJumpCooldown > 0);
});

test('NOVA 2 seeks a live boost pad only when the ball is safely away', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  const human = simulation.addPlayer({ id: 'human', team: 0 });
  const nova = simulation.addPlayer({ id: 'nova', name: 'NOVA 2', team: 1, isBot: true });
  simulation.start();
  simulation.status = 'playing';
  human.body.position.set(-105, .68, -50);
  nova.boost = 5;
  simulation.ball.position.set(-70, 12, 0);
  simulation.ball.velocity.setZero();

  simulation.step(1 / 60);

  assert.equal(nova.aiState, 'boost');
  assert.ok(simulation.boostPads.some(pad => pad.active && Math.abs(pad.x - nova.aiTarget.x) < 1e-6 && Math.abs(pad.z - nova.aiTarget.z) < 1e-6));
  assert.equal(nova.input.boost, false, 'NOVA should not spend its last boost while routing to a pad');
});

test('NOVA 2 tactical state is exposed for HUD and QA telemetry', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  simulation.addPlayer({ id: 'human', team: 0 });
  simulation.addPlayer({ id: 'nova', name: 'NOVA 2', team: 1, isBot: true });
  simulation.start();
  simulation.status = 'playing';
  simulation.step(1 / 60);

  const nova = simulation.snapshot().players.find(player => player.id === 'nova');
  assert.ok(['hunt', 'carry', 'attack', 'intercept', 'shadow', 'defend', 'save', 'boost'].includes(nova.ai.state));
  assert.equal(nova.ai.target.length, 3);
  assert.ok(Number.isFinite(nova.ai.interceptTime));
});

test('cars start each kickoff with 33 boost instead of a full tank', () => {
  const { simulation, player } = createPlayer();
  assert.equal(player.boost, 33);
  player.boost = 0;
  simulation.start();
  assert.equal(player.boost, 33);
});

test('evaluation kickoff variation is seeded, reproducible and opt-in', () => {
  const kickoff = random => {
    const simulation = new GameSimulation({ mode: 'duel', random, evaluationKickoffVariation: true });
    simulation.addPlayer({ id: 'left', team: 0, isBot: true });
    simulation.addPlayer({ id: 'right', team: 1, isBot: true });
    simulation.start();
    return simulation.snapshot().ball;
  };
  const low = kickoff(() => .1);
  assert.deepEqual(low, kickoff(() => .1));
  assert.notDeepEqual(low, kickoff(() => .9));

  const regular = new GameSimulation({ mode: 'duel', random: () => .9 });
  regular.start();
  assert.equal(regular.snapshot().ball.p[2], -4);
});

test('kickoff countdown lasts three full seconds and freezes cars and ball', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  const player = simulation.addPlayer({ id: 'me', team: 0 });
  simulation.start();
  const carStart = player.body.position.clone();
  const ballStart = simulation.ball.position.clone();
  const countdownValues = simulation.drainEvents().filter(event => event.type === 'countdown').map(event => event.value);
  simulation.setInput('me', { throttle: 1, boost: true });
  let goAt = null;
  for (let frame = 1; frame <= 190; frame++) {
    simulation.step(1 / 60);
    for (const event of simulation.drainEvents()) {
      if (event.type === 'countdown') countdownValues.push(event.value);
      if (event.type === 'go') goAt = frame / 60;
    }
    if (goAt === null) {
      assert.ok(player.body.position.distanceTo(carStart) < 1e-6, 'car moved during countdown');
      assert.ok(simulation.ball.position.distanceTo(ballStart) < 1e-6, 'ball moved during countdown');
    }
  }
  assert.deepEqual(countdownValues, [3, 2, 1]);
  assert.ok(goAt >= 2.98 && goAt <= 3.05, `GO occurred at ${goAt}s instead of 3s`);
});

test('boost does not regenerate passively without collecting a pad', () => {
  const { simulation, player } = createPlayer();
  player.boost = 20;
  for (let i = 0; i < 300; i++) simulation.step(1 / 60);
  assert.ok(Math.abs(player.boost - 20) < 0.01, `boost regenerated without a pad: ${player.boost.toFixed(2)}`);
});

test('airborne boost creates a short forward burst along the car nose', () => {
  const { simulation, player } = createPlayer();
  player.body.position.set(0, 12, 0);
  player.body.velocity.setZero();
  player.boost = 50;
  for (let i = 0; i < 6; i++) {
    simulation.setInput('me', { boost: true });
    simulation.step(1 / 60);
  }
  assert.ok(player.body.velocity.x > 2.2, `six-frame boost tap was too weak: vx=${player.body.velocity.x.toFixed(2)}`);
  assert.ok(player.boost < 48 && player.boost > 45, `boost tap consumed an unexpected amount: ${player.boost.toFixed(2)}`);
});

test('authoritative snapshots expose whether a car is actively boosting', () => {
  const { simulation, player } = createPlayer();
  player.boost = 50;
  simulation.setInput('me', { boost: true }); simulation.step(1 / 60);
  assert.equal(simulation.snapshot().players.find(candidate => candidate.id === 'me').boosting, true);
  simulation.setInput('me', { boost: false }); simulation.step(1 / 60);
  assert.equal(simulation.snapshot().players.find(candidate => candidate.id === 'me').boosting, false);
});

test('driving over an active boost pad refills boost and deactivates the pad', () => {
  const { simulation, player } = createPlayer();
  const initial = simulation.snapshot();
  assert.ok(Array.isArray(initial.boostPads) && initial.boostPads.length >= 20, 'authoritative boost pad state is missing');
  const pad = initial.boostPads.find(candidate => candidate.amount < 100);
  player.boost = 0;
  player.body.position.set(pad.x, 0.62, pad.z);
  player.body.velocity.setZero();
  simulation.step(1 / 60);
  const collected = simulation.snapshot().boostPads.find(candidate => candidate.id === pad.id);
  assert.equal(player.boost, pad.amount);
  assert.equal(collected.active, false);
  assert.ok(simulation.drainEvents().some(event => event.type === 'boostPickup' && event.padId === pad.id));
});

test('a collected small boost pad respawns after its recharge delay', () => {
  const { simulation, player } = createPlayer();
  const pad = simulation.snapshot().boostPads.find(candidate => candidate.amount < 100);
  player.boost = 0; player.body.position.set(pad.x, 0.62, pad.z);
  simulation.step(1 / 60);
  player.body.position.set(0, 0.62, 0);
  for (let i = 0; i < 245; i++) simulation.step(1 / 60);
  const respawned = simulation.snapshot().boostPads.find(candidate => candidate.id === pad.id);
  assert.equal(respawned.active, true);
});

test('a kickoff reactivates every boost pad', () => {
  const { simulation, player } = createPlayer();
  const pad = simulation.snapshot().boostPads.find(candidate => candidate.amount < 100);
  player.boost = 0; player.body.position.set(pad.x, .62, pad.z);
  simulation.step(1 / 60);
  assert.equal(simulation.snapshot().boostPads.find(candidate => candidate.id === pad.id).active, false);
  simulation.start();
  assert.ok(simulation.snapshot().boostPads.every(candidate => candidate.active));
});

test('opposite throttle brakes hard before engaging reverse drive', () => {
  const { simulation, player } = createPlayer();
  for (let i = 0; i < 90; i++) {
    simulation.setInput('me', { throttle: 1 });
    simulation.step(1 / 60);
  }
  assert.ok(player.body.velocity.x > 18, `setup speed was ${player.body.velocity.x}`);
  for (let i = 0; i < 20; i++) {
    simulation.setInput('me', { throttle: -1 });
    simulation.step(1 / 60);
  }
  assert.ok(Math.abs(player.body.velocity.x) < 5, `opposite throttle did not brake abruptly: vx=${player.body.velocity.x.toFixed(2)}`);
  for (let i = 0; i < 30; i++) {
    simulation.setInput('me', { throttle: -1 });
    simulation.step(1 / 60);
  }
  assert.ok(player.body.velocity.x < -4, `reverse drive did not engage after braking: vx=${player.body.velocity.x.toFixed(2)}`);
});

test('steering still turns the car after straight-line stabilization', () => {
  const result = drive({ steer: 0.7 });
  assert.ok(result.lateralDrift > 5, `car only turned ${result.lateralDrift.toFixed(3)} m`);
  assert.ok(result.speed > 12, `turning speed was only ${result.speed.toFixed(3)} m/s`);
});

test('holding jump produces a higher first jump than tapping it', () => {
  const apex = holdTicks => {
    const { simulation, player } = createPlayer();
    let maxY = player.body.position.y;
    for (let i = 0; i < 150; i++) {
      simulation.setInput('me', { jump: i < holdTicks });
      simulation.step(1 / 60);
      maxY = Math.max(maxY, player.body.position.y);
    }
    return maxY;
  };
  const tapApex = apex(1), heldApex = apex(12);
  assert.ok(heldApex > tapApex + 0.6, `held jump ${heldApex.toFixed(2)} was not meaningfully higher than tap ${tapApex.toFixed(2)}`);
});

test('taller jeep collider and shared large-wheel contract raise the playable contact envelope', () => {
  const { player } = createPlayer();
  const chassis = player.body.shapes[0];
  assert.ok(chassis.halfExtents.y >= 0.66, `car collider remained too flat at ${(chassis.halfExtents.y * 2).toFixed(2)} m tall`);
  const source = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  assert.match(source, /const wheelRadius = CAR\.wheelRadius/);
});

test('front bumper reaches beyond the wheels and the ball is scaled up by 1.5', () => {
  const { simulation, player } = createPlayer();
  assert.equal(FIELD.ballRadius, 1.875);
  assert.equal(simulation.ball.shapes[0].radius, 1.875);
  assert.ok(player.body.shapes.length >= 2, 'car has no dedicated front bumper shape');
  const bumper = player.body.shapes[1];
  const offset = player.body.shapeOffsets[1];
  assert.ok(offset.x + bumper.halfExtents.x >= 1.7, `bumper only reaches x=${(offset.x + bumper.halfExtents.x).toFixed(2)}`);
  assert.ok(offset.y + bumper.halfExtents.y <= .18, 'bumper is too high and would behave like a second full chassis');
  const source = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  assert.match(source, /frontBumper/);
});

test('taller jeep envelope catches a normally bouncing ball instead of passing underneath', () => {
  const { simulation, player } = createPlayer();
  player.body.position.set(0, 0.68, 0);
  player.body.velocity.set(14, 0, 0);
  simulation.ball.position.set(4, 2.3, 0);
  simulation.ball.velocity.setZero();
  for (let i = 0; i < 30; i++) simulation.step(1 / 60);
  assert.ok(simulation.ball.velocity.x > 8, `car passed under the ball; ball vx=${simulation.ball.velocity.x.toFixed(2)}`);
  assert.ok(simulation.ball.position.y > 2.5, `tall-car contact did not lift the ball: y=${simulation.ball.position.y.toFixed(2)}`);
});

test('stronger held jumps gain additional height when boost is combined with jump', () => {
  const apex = boosted => {
    const { simulation, player } = createPlayer();
    player.boost = 100;
    let maxY = player.body.position.y;
    for (let i = 0; i < 180; i++) {
      const jumping = i < 12;
      simulation.setInput('me', { jump: jumping, boost: boosted && jumping });
      simulation.step(1 / 60);
      maxY = Math.max(maxY, player.body.position.y);
    }
    return maxY;
  };
  const regular = apex(false), boosted = apex(true);
  assert.ok(regular > 4.3, `held jump remained too low at ${regular.toFixed(2)} m`);
  assert.ok(boosted > regular + 0.7, `boosted jump ${boosted.toFixed(2)} did not clearly beat regular jump ${regular.toFixed(2)}`);
});

test('Tron boost uses persistent world-space light tracks instead of cone flames', () => {
  const source = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  assert.match(source, /createTronTrail/);
  assert.match(source, /updateTronTrail/);
  assert.match(source, /trailPoints/);
  const carSection = source.slice(source.indexOf('function buildCar'), source.indexOf('function ensureCar'));
  assert.doesNotMatch(carSection, /ConeGeometry/);
  assert.doesNotMatch(carSection, /energyRings|afterimages/);
});

test('observer mode joins one authoritative NOVA duel shared by every spectator', () => {
  const client = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="novaDuel"/);
  assert.match(client, /\$\('#novaDuel'\)\.onclick = async/);
  assert.match(client, /emitWithAck\('watchNovaDuel'/);
  assert.match(client, /startLocalNovaDuel/);
  assert.match(client, /if \(!spectatorMode\) localSim\.setInput/);
  assert.match(client, /if \(spectatorMode\) return updateSpectatorCamera/);
  assert.match(server, /LIVE_DUEL_CHANNEL/);
  assert.match(server, /new GameSimulation\(\{ mode: 'duel' \}\)/);
  assert.match(server, /onRequest\('watchNovaDuel'/);
  assert.match(server, /stampSnapshot\(liveDuel/);
});

test('solo menu selects NOVA 1 by default and can launch all three AI versions', () => {
  const client = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const rapierSimulation = readFileSync(new URL('../shared/simulation-v3.js', import.meta.url), 'utf8');
  const carSoccerContract = readFileSync(new URL('../shared/car-soccer-contract.js', import.meta.url), 'utf8');
  assert.match(html, /<select id="novaVersion"/);
  assert.match(html, /<option value="1" selected>NOVA 1/);
  assert.match(html, /<option value="2">NOVA 2/);
  assert.match(html, /<option value="3">NOVA-WF/);
  assert.match(client, /const novaVersion = Number\(\$\('#novaVersion'\)\.value\)/);
  assert.match(client, /aiVersion: novaVersion/);
  assert.match(client, /novaVersion === 3 \? 'NOVA-WF' : `NOVA \$\{novaVersion\}`/);
  assert.match(client, /await createRocketSimSoloSimulation\(\{ targetScore: 5 \}\)/);
  assert.doesNotMatch(client, /novaVersion === 1\s*\?\s*await createRocketSimSoloSimulation/);
  assert.match(client, /physics: currentState\?\.physics/);
  assert.match(client, /aiVersion:p\.aiVersion/);
  assert.match(client, /aiState:p\.aiState/);
  assert.match(server, /from '\.\/shared\/simulation-v3\.js'/);
  assert.match(rapierSimulation, /from '\.\/nova-wf\.js'/);
  assert.match(rapierSimulation, /player\.aiVersion === 3.*#novaWfInput/s);
  assert.doesNotMatch(carSoccerContract, /rapier/i);
});

test('client exposes goal explosion, final-score overlay and rematch controls', () => {
  const client = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(client, /spawnGoalExplosion/);
  assert.match(client, /updateGoalEffects/);
  assert.match(html, /id="matchEnd"/);
  assert.match(html, /id="finalScore"/);
  assert.match(html, /id="rematch"/);
  assert.match(server, /rematchRequest/);
});

test('online chase camera follows interpolated render poses instead of 20 Hz snapshots', () => {
  const source = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  const cameraSection = source.slice(source.indexOf('function updateCamera'), source.indexOf('function updatePerformance'));
  assert.match(cameraSection, /carMeshes\.get\(localId\)/, 'camera still ignores the interpolated local car mesh');
  assert.match(cameraSection, /cameraLookTarget\.lerp/, 'network camera look direction is not damped');
});

test('spectator camera hides opaque arena shell surfaces without changing physics', () => {
  const client = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  assert.match(client, /spectatorOccluderMeshes/);
  assert.match(client, /mesh\.visible = !spectatorMode/);
});

test('the single automatic chase camera resolves arena occlusion', () => {
  const source = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const cameraSection = source.slice(source.indexOf('function resolveCameraOcclusion'), source.indexOf('function updatePerformance'));
  assert.match(source, /arenaCameraOccluders/);
  assert.match(source, /THREE\.Raycaster/);
  assert.match(cameraSection, /resolveCameraOcclusion\(cameraLookTarget, camera\.position\)/);
  assert.doesNotMatch(html, /id="cameraToggle"/);
  assert.doesNotMatch(source, /toggleBallCamera|cameraDragging|cameraOrbitYaw/);
  assert.doesNotMatch(source, /canvas\.addEventListener\('wheel'/);
  assert.doesNotMatch(source, /event\.code === 'KeyC'/);
});

test('ball skin combines a graphite core, geodesic seams and instanced neon hex panels', () => {
  const source = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  const ballSection = source.slice(source.indexOf('function buildBall'), source.indexOf('function spawnGoalExplosion'));
  assert.match(ballSection, /graphiteCore/);
  assert.match(ballSection, /geodesicSeams/);
  assert.match(ballSection, /neonBallPanels/);
  assert.match(ballSection, /new THREE\.InstancedMesh/);
  assert.match(ballSection, /FIELD\.ballRadius/);
});

test('ball panels conform to the sphere instead of protruding as tangent discs', () => {
  const source = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  const ballSection = source.slice(source.indexOf('function buildBall'), source.indexOf('function spawnGoalExplosion'));
  assert.match(ballSection, /createBallHexPatch/);
  assert.doesNotMatch(ballSection, /CircleGeometry/, 'flat tangent discs create crescents and spikes at the silhouette');
});

test('ball rendering includes a world-space ground marker that follows its position', () => {
  const source = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  assert.match(source, /ballGroundHalo/);
  assert.match(source, /ballShadow\.position\.set/);
  assert.match(source, /state\.ball\.p/);
});

test('ball uses a bright neon-green skin and a persistent airborne ground halo', () => {
  const source = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  const ballSection = source.slice(source.indexOf('function buildBall'), source.indexOf('function spawnGoalExplosion'));
  assert.match(ballSection, /0x39ff14/);
  assert.match(source, /ballGroundHalo/);
  assert.match(source, /rgba\(57,255,20/);
  assert.match(source, /ballShadow\.material\.opacity = \.72/);
  assert.doesNotMatch(source, /ballShadow\.material\.opacity = THREE\.MathUtils\.clamp/, 'the location halo must not fade away as the ball rises');
});

test('a directional second jump creates a forward dodge with rotation', () => {
  const { simulation, player } = createPlayer();
  simulation.setInput('me', { jump: true }); simulation.step(1 / 60);
  simulation.setInput('me', { jump: false });
  for (let i = 0; i < 8; i++) simulation.step(1 / 60);
  const beforeX = player.body.velocity.x;
  simulation.setInput('me', { jump: true, throttle: 1 }); simulation.step(1 / 60);
  assert.ok(player.body.velocity.x > beforeX + 5.5, `forward dodge impulse was too weak: delta=${(player.body.velocity.x - beforeX).toFixed(2)}`);
  assert.ok(player.body.angularVelocity.length() > 1.5, `directional dodge did not rotate the car: w=${player.body.angularVelocity.length().toFixed(2)}`);
  assert.equal(player.airJumps, 0);
});

test('jump leaves the floor cleanly and lands without tunnelling', () => {
  const { simulation, player } = createPlayer();
  let maxY = player.body.position.y;

  for (let i = 0; i < 260; i++) {
    simulation.setInput('me', { jump: i === 30 });
    simulation.step(1 / 60);
    maxY = Math.max(maxY, player.body.position.y);
  }

  assert.ok(maxY > 1.5 && maxY < 4, `jump apex was ${maxY.toFixed(3)} m`);
  assert.ok(player.body.position.y >= 0.50, `car ended below floor at ${player.body.position.y.toFixed(3)} m`);
  assert.ok(player.body.position.y < 0.7, `car did not land: ${player.body.position.y.toFixed(3)} m`);
});

test('right keyboard input maps to negative Rapier steering and left maps to positive steering', () => {
  const source = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  const controls = readFileSync(new URL('../public/rocketsim-playable-core.js', import.meta.url), 'utf8');
  assert.match(controls, /steer: axis\(held\.has\('KeyA'\)[\s\S]*held\.has\('ArrowLeft'\)[\s\S]*held\.has\('KeyD'\)[\s\S]*held\.has\('ArrowRight'\)/);
  assert.match(source, /inputState\.steer\s*=\s*Math\.abs\(pad\.axes\[0\]\)[\s\S]*\?\s*-pad\.axes\[0\]/);
});

test('boost pads are rendered with instancing rather than one mesh per pad', () => {
  const source = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  assert.match(source, /boostPadVisuals[\s\S]*InstancedMesh[\s\S]*state\.boostPads/);
});

test('keyboard exposes dedicated Q and E air-roll controls', () => {
  const controls = readFileSync(new URL('../public/rocketsim-playable-core.js', import.meta.url), 'utf8');
  assert.match(controls, /roll: axis\(held\.has\('KeyE'\), held\.has\('KeyQ'\)\)/);
});

test('arena dimensions and structural transitions are doubled again', () => {
  assert.equal(FIELD.halfX, 120);
  assert.equal(FIELD.halfZ, 76);
  assert.equal(FIELD.ceilingY, 44);
  assert.equal(FIELD.goalHalf, 18);
  assert.equal(FIELD.goalHeight, 16);
  assert.equal(FIELD.goalDepth, 8);
  assert.equal(FIELD.curveRadius, 16);
  assert.equal(FIELD.cornerRadius, 28);
});

test('a ball fully crossing the goal line awards a point', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  simulation.addPlayer({ id: 'me', team: 0 });
  simulation.start();
  simulation.status = 'playing';
  simulation.ball.position.set(FIELD.halfX + FIELD.ballRadius + 0.05, 2, 0);
  simulation.ball.velocity.setZero();
  simulation.step(1 / 60);
  assert.deepEqual(simulation.score, [1, 0]);
  assert.ok(simulation.drainEvents().some(event => event.type === 'goal' && event.team === 0));
});

test('a non-winning goal enters a celebration before a fresh three-second kickoff', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  simulation.addPlayer({ id: 'me', team: 0 });
  simulation.start();
  simulation.status = 'playing';
  simulation.drainEvents();
  simulation.ball.position.set(FIELD.halfX + FIELD.ballRadius + .05, 2, 0);
  simulation.step(1 / 60);
  const goalEvent = simulation.drainEvents().find(event => event.type === 'goal');
  assert.equal(simulation.status, 'goal');
  assert.ok(Array.isArray(goalEvent.position) && goalEvent.position.length === 3, 'goal event lacks explosion position');
  for (let i = 0; i < 80; i++) simulation.step(1 / 60);
  assert.equal(simulation.status, 'goal');
  for (let i = 0; i < 20; i++) simulation.step(1 / 60);
  assert.equal(simulation.status, 'countdown');
  assert.equal(simulation.snapshot().countdown, 3);
  assert.ok(simulation.drainEvents().some(event => event.type === 'countdown' && event.value === 3));
});

test('finished matches preserve the final score until an explicit rematch starts', () => {
  const simulation = new GameSimulation({ mode: 'solo', targetScore: 1 });
  simulation.addPlayer({ id: 'me', team: 0 });
  simulation.start();
  simulation.status = 'playing';
  simulation.ball.position.set(FIELD.halfX + FIELD.ballRadius + .05, 2, 0);
  simulation.step(1 / 60);
  assert.equal(simulation.status, 'finished');
  assert.deepEqual(simulation.score, [1, 0]);
  for (let i = 0; i < 600; i++) simulation.step(1 / 60);
  assert.equal(simulation.status, 'finished');
  assert.deepEqual(simulation.score, [1, 0]);
  simulation.start();
  assert.equal(simulation.status, 'countdown');
  assert.deepEqual(simulation.score, [0, 0]);
  assert.equal(simulation.winner, null);
});

test('the ball keeps a lively but slightly reduced first floor rebound', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  simulation.addPlayer({ id: 'me', team: 0 });
  simulation.start();
  simulation.status = 'playing';
  simulation.ball.position.set(0, 12, 0);
  simulation.ball.velocity.setZero();

  let bounced = false, reboundApex = 0;
  for (let i = 0; i < 300; i++) {
    const previousVerticalSpeed = simulation.ball.velocity.y;
    simulation.step(1 / 60);
    if (!bounced && previousVerticalSpeed < 0 && simulation.ball.velocity.y > 0) bounced = true;
    if (bounced) reboundApex = Math.max(reboundApex, simulation.ball.position.y);
    if (bounced && reboundApex > 0 && simulation.ball.velocity.y <= 0) break;
  }

  assert.ok(bounced, 'ball never rebounded from the floor');
  assert.ok(reboundApex >= 6.2, `ball became too dead: rebound apex ${reboundApex.toFixed(3)} m`);
  assert.ok(reboundApex <= 7.8, `ball still rebounds too much: rebound apex ${reboundApex.toFixed(3)} m`);
});

test('the ceiling keeps the ball inside the arena', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  simulation.addPlayer({ id: 'me', team: 0 });
  simulation.start();
  simulation.status = 'playing';
  simulation.ball.position.set(0, 8, 10);
  simulation.ball.velocity.set(0, 52, 0);
  let maxY = 0;
  for (let i = 0; i < 240; i++) {
    simulation.step(1 / 60);
    maxY = Math.max(maxY, simulation.ball.position.y);
  }
  assert.ok(maxY <= FIELD.ceilingY - FIELD.ballRadius + 0.5, `ball escaped through ceiling at y=${maxY.toFixed(2)}`);
});

test('side walls and rounded corners keep a fast ball in the box', () => {
  for (const velocity of [[0, 0, 45], [42, 0, 42], [-42, 0, 42]]) {
    const simulation = new GameSimulation({ mode: 'solo' });
    simulation.addPlayer({ id: 'me', team: 0 });
    simulation.start();
    simulation.status = 'playing';
    simulation.ball.position.set(0, 3, 0);
    simulation.ball.velocity.set(...velocity);
    let maxAbsX = 0, maxAbsZ = 0;
    for (let i = 0; i < 300; i++) {
      simulation.step(1 / 60);
      maxAbsX = Math.max(maxAbsX, Math.abs(simulation.ball.position.x));
      maxAbsZ = Math.max(maxAbsZ, Math.abs(simulation.ball.position.z));
    }
    assert.ok(maxAbsZ <= FIELD.halfZ + 1, `ball escaped side at |z|=${maxAbsZ.toFixed(2)}`);
    assert.ok(maxAbsX <= FIELD.halfX + 5, `ball escaped end at |x|=${maxAbsX.toFixed(2)}`);
  }
});

test('the rounded floor-wall transition carries the ball upward', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  simulation.addPlayer({ id: 'me', team: 0 });
  simulation.start();
  simulation.status = 'playing';
  simulation.ball.position.set(0, 1.5, FIELD.halfZ - FIELD.curveRadius - 3);
  simulation.ball.velocity.set(0, 0, 45);
  let maxY = 0, maxZ = 0;
  for (let i = 0; i < 120; i++) {
    simulation.step(1 / 60);
    maxY = Math.max(maxY, simulation.ball.position.y);
    maxZ = Math.max(maxZ, simulation.ball.position.z);
  }
  assert.ok(maxY > 6, `ball bounced flat instead of climbing the curve; maxY=${maxY.toFixed(2)}`);
  assert.ok(maxZ < FIELD.halfZ, `ball crossed the curved wall; maxZ=${maxZ.toFixed(2)}`);
});

test('a virtual rounded roof contact quickly rolls a resting car toward its wheels', () => {
  const { simulation, player } = createPlayer();
  player.body.position.set(0, 1.05, 0);
  player.body.velocity.setZero();
  player.body.angularVelocity.setZero();
  player.body.quaternion.setFromEuler(Math.PI, 0, 0, 'XYZ');
  let leftRoofAt = null, reachedWheelsAt = null, maxFrameRotation = 0;
  let previous = player.body.quaternion.clone();
  for (let i = 0; i < 180; i++) {
    simulation.step(1 / 60);
    const current = player.body.quaternion;
    const up = current.vmult({ x: 0, y: 1, z: 0 }).y;
    const dot = Math.min(1, Math.abs(previous.x * current.x + previous.y * current.y + previous.z * current.z + previous.w * current.w));
    maxFrameRotation = Math.max(maxFrameRotation, 2 * Math.acos(dot));
    previous = current.clone();
    if (leftRoofAt === null && up > -0.6) leftRoofAt = (i + 1) / 60;
    if (reachedWheelsAt === null && up > 0.8) reachedWheelsAt = (i + 1) / 60;
  }
  assert.ok(leftRoofAt !== null && leftRoofAt < 0.9, `car stayed flat on its roof for ${leftRoofAt ?? 'the whole test'}s`);
  assert.ok(reachedWheelsAt !== null && reachedWheelsAt < 1.5, `car took ${reachedWheelsAt ?? 'too long'}s to reach its wheels`);
  assert.ok(maxFrameRotation < 0.22, `rounded roof assist snapped ${(maxFrameRotation * 180 / Math.PI).toFixed(1)} degrees in one frame`);
});

test('roof recovery dominates held aerial controls and residual sliding', () => {
  const { simulation, player } = createPlayer();
  player.body.position.set(0, 1.1, 0);
  player.body.velocity.set(6, 0, 2);
  player.body.angularVelocity.setZero();
  player.body.quaternion.setFromEuler(Math.PI, 0, 0, 'XYZ');
  let reachedWheelsAt = null;
  for (let i = 0; i < 180; i++) {
    simulation.setInput('me', { throttle: 1, steer: 1, airRoll: 1 });
    simulation.step(1 / 60);
    const up = player.body.quaternion.vmult({ x: 0, y: 1, z: 0 }).y;
    if (reachedWheelsAt === null && up > 0.8) reachedWheelsAt = (i + 1) / 60;
  }
  assert.ok(reachedWheelsAt !== null && reachedWheelsAt < 1.5, `held controls kept the car on its roof for ${reachedWheelsAt ?? 'the whole test'}s`);
});

test('side recovery makes the wheel side the only stable resting orientation', () => {
  const { simulation, player } = createPlayer();
  player.body.position.set(0, 1.1, 0);
  player.body.velocity.set(6, 0, 2);
  player.body.angularVelocity.setZero();
  player.body.quaternion.setFromEuler(Math.PI / 2, 0, 0, 'XYZ');
  let reachedWheelsAt = null;
  for (let i = 0; i < 180; i++) {
    simulation.setInput('me', { throttle: -1, steer: 1, airRoll: -1 });
    simulation.step(1 / 60);
    const up = player.body.quaternion.vmult({ x: 0, y: 1, z: 0 }).y;
    if (reachedWheelsAt === null && up > 0.8) reachedWheelsAt = (i + 1) / 60;
  }
  assert.ok(reachedWheelsAt !== null && reachedWheelsAt < 1.5, `car remained balanced on its side for ${reachedWheelsAt ?? 'the whole test'}s`);
});

test('an inverted car still rolls to its wheels while sliding quickly', () => {
  const { simulation, player } = createPlayer();
  player.body.position.set(0, 1.1, 0);
  player.body.velocity.set(12, 0, 3);
  player.body.angularVelocity.setZero();
  player.body.quaternion.setFromEuler(Math.PI, 0, 0, 'XYZ');
  let reachedWheelsAt = null;
  for (let i = 0; i < 180; i++) {
    simulation.setInput('me', { throttle: 1, steer: -1, airRoll: 1 });
    simulation.step(1 / 60);
    const up = player.body.quaternion.vmult({ x: 0, y: 1, z: 0 }).y;
    if (reachedWheelsAt === null && up > 0.8) reachedWheelsAt = (i + 1) / 60;
  }
  assert.ok(reachedWheelsAt !== null && reachedWheelsAt < 1.8, `fast roof slide prevented recovery for ${reachedWheelsAt ?? 'the whole test'}s`);
});

test('body scrape friction slows roof slides without braking wheel-side coasting', () => {
  const roof = createPlayer();
  roof.player.body.position.set(0, 1.1, 0);
  roof.player.body.velocity.set(12, 0, 3);
  roof.player.body.angularVelocity.setZero();
  roof.player.body.quaternion.setFromEuler(Math.PI, 0, 0, 'XYZ');

  const wheels = createPlayer();
  wheels.player.body.position.set(0, 0.52, 0);
  wheels.player.body.velocity.set(12, 0, 3);
  wheels.player.body.angularVelocity.setZero();

  for (let i = 0; i < 30; i++) {
    roof.simulation.step(1 / 60);
    wheels.simulation.step(1 / 60);
  }

  const roofSpeed = Math.hypot(roof.player.body.velocity.x, roof.player.body.velocity.z);
  const wheelSpeed = Math.hypot(wheels.player.body.velocity.x, wheels.player.body.velocity.z);
  assert.ok(roofSpeed < 7, `roof slide still behaves like ice at ${roofSpeed.toFixed(2)} m/s`);
  assert.ok(wheelSpeed > 9, `scrape friction incorrectly braked wheel-side coasting to ${wheelSpeed.toFixed(2)} m/s`);
  assert.ok(roofSpeed < wheelSpeed * 0.7, `roof drag ${roofSpeed.toFixed(2)} was not distinct from wheel drag ${wheelSpeed.toFixed(2)}`);
});

test('an overturned car self-rights progressively without quaternion teleportation', () => {
  const { simulation, player } = createPlayer();
  player.body.position.set(0, 1.05, 0);
  player.body.velocity.setZero();
  player.body.angularVelocity.setZero();
  player.body.quaternion.setFromEuler(Math.PI, 0, 0, 'XYZ');

  const worldUp = { x: 0, y: 1, z: 0 };
  let maxFrameRotation = 0, upAfterDelay = 0;
  let previous = player.body.quaternion.clone();
  for (let i = 0; i < 480; i++) {
    simulation.step(1 / 60);
    const current = player.body.quaternion;
    const dot = Math.min(1, Math.abs(previous.x * current.x + previous.y * current.y + previous.z * current.z + previous.w * current.w));
    maxFrameRotation = Math.max(maxFrameRotation, 2 * Math.acos(dot));
    previous = current.clone();
    if (i === 20) upAfterDelay = current.vmult(worldUp).y;
  }
  const finalUp = player.body.quaternion.vmult(worldUp).y;
  assert.ok(upAfterDelay < -0.65, `recovery started as an unnatural instant snap: up=${upAfterDelay.toFixed(2)}`);
  assert.ok(maxFrameRotation < 0.22, `car teleported by ${(maxFrameRotation * 180 / Math.PI).toFixed(1)} degrees in one frame`);
  assert.ok(finalUp > 0.82, `car stayed overturned: final up=${finalUp.toFixed(2)}`);
  assert.ok(player.body.position.y < 1.2, `car did not settle back on the floor: y=${player.body.position.y.toFixed(2)}`);
});

test('self-righting also handles side and diagonal resting orientations', () => {
  for (const euler of [[Math.PI / 2, 0, 0], [2.2, 0.35, 0.7]]) {
    const { simulation, player } = createPlayer();
    player.body.position.set(0, 1.15, 0);
    player.body.velocity.setZero();
    player.body.angularVelocity.setZero();
    player.body.quaternion.setFromEuler(...euler, 'XYZ');
    for (let i = 0; i < 300; i++) simulation.step(1 / 60);
    const up = player.body.quaternion.vmult({ x: 0, y: 1, z: 0 }).y;
    assert.ok(up > 0.95, `car failed to recover from ${JSON.stringify(euler)}: up=${up.toFixed(2)}`);
    assert.ok(player.body.position.y < 0.75, `car failed to settle: y=${player.body.position.y.toFixed(2)}`);
  }
});

test('a tumbling airborne car levels its wheels before floor contact', () => {
  const { simulation, player } = createPlayer();
  player.body.position.set(0, 7, 0);
  player.body.velocity.set(8, -3, 2);
  player.body.angularVelocity.set(1.1, 0.25, -0.9);
  player.body.quaternion.setFromEuler(1.55, 0.4, 1.0, 'XYZ');

  let landingUp = null, maxFrameRotation = 0;
  let previous = player.body.quaternion.clone();
  for (let i = 0; i < 300; i++) {
    simulation.step(1 / 60);
    const current = player.body.quaternion;
    const dot = Math.min(1, Math.abs(previous.x * current.x + previous.y * current.y + previous.z * current.z + previous.w * current.w));
    maxFrameRotation = Math.max(maxFrameRotation, 2 * Math.acos(dot));
    previous = current.clone();
    if (landingUp === null && player.body.position.y < 1.25) landingUp = current.vmult({ x: 0, y: 1, z: 0 }).y;
  }
  const finalUp = player.body.quaternion.vmult({ x: 0, y: 1, z: 0 }).y;
  assert.notEqual(landingUp, null, 'car never returned to the floor');
  assert.ok(landingUp > 0.72, `car reached the floor on its side/roof: up=${landingUp.toFixed(2)}`);
  assert.ok(maxFrameRotation < 0.3, `air leveling/collision rotated ${(maxFrameRotation * 180 / Math.PI).toFixed(1)} degrees in one frame`);
  assert.ok(finalUp > 0.95 && player.body.position.y < 0.75, `car did not settle on its wheels: up=${finalUp.toFixed(2)}, y=${player.body.position.y.toFixed(2)}`);
});

test('low corner seams are physically closed', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  simulation.addPlayer({ id: 'me', team: 0 });
  simulation.start();
  simulation.status = 'playing';
  const cx = FIELD.halfX - FIELD.cornerRadius, cz = FIELD.halfZ - FIELD.cornerRadius;
  simulation.ball.position.set(cx - 12, 2.2, cz - 9);
  simulation.ball.velocity.set(42, 0, 32);
  let maxCornerRadius = 0;
  for (let i = 0; i < 300; i++) {
    simulation.step(1 / 60);
    const x = simulation.ball.position.x, z = simulation.ball.position.z;
    if (x > cx && z > cz && simulation.ball.position.y < FIELD.curveRadius) maxCornerRadius = Math.max(maxCornerRadius, Math.hypot(x - cx, z - cz));
  }
  assert.ok(maxCornerRadius <= FIELD.cornerRadius + 0.5, `ball crossed a low corner seam: radius=${maxCornerRadius.toFixed(2)}`);
  assert.ok(Math.abs(simulation.ball.position.x) <= FIELD.halfX + 5 && Math.abs(simulation.ball.position.z) <= FIELD.halfZ + 1, 'ball escaped the closed box');
});

test('airborne throttle pitches the car around its local right axis', () => {
  const { simulation, player } = createPlayer();
  player.body.position.set(0, 12, 0);
  player.body.velocity.setZero();
  player.body.angularVelocity.setZero();
  for (let i = 0; i < 45; i++) {
    simulation.setInput('me', { throttle: 1 });
    simulation.step(1 / 60);
  }
  const forward = player.body.quaternion.vmult({ x: 1, y: 0, z: 0 });
  assert.ok(forward.y < -0.25, `air pitch did not lower the nose: forward=${JSON.stringify(forward.toArray())}`);
});

test('manual air roll remains available while auto-leveling is active', () => {
  const { simulation, player } = createPlayer();
  player.body.position.set(0, 10, 0);
  player.body.velocity.set(0, 4, 0);
  player.input.airRoll = 1;
  for (let i = 0; i < 60; i++) simulation.step(1 / 60);
  const up = player.body.quaternion.vmult({ x: 0, y: 1, z: 0 });
  assert.ok(Math.abs(up.z) > 0.4 && up.y < 0.9, `air leveling overpowered manual roll: up=${JSON.stringify(up.toArray())}`);
});

test('powered cars follow all four floor-wall curves instead of stopping or flipping', () => {
  const scenarios = [
    { position: [0, 0.62, FIELD.halfZ - FIELD.curveRadius - 1], velocity: [0, 0, 9], heading: -Math.PI / 2, axis: 'z', sign: 1 },
    { position: [0, 0.62, -FIELD.halfZ + FIELD.curveRadius + 1], velocity: [0, 0, -9], heading: Math.PI / 2, axis: 'z', sign: -1 },
    { position: [FIELD.halfX - FIELD.curveRadius - 1, 0.62, FIELD.goalHalf + 2], velocity: [9, 0, 0], heading: 0, axis: 'x', sign: 1 },
    { position: [-FIELD.halfX + FIELD.curveRadius + 1, 0.62, -FIELD.goalHalf - 2], velocity: [-9, 0, 0], heading: Math.PI, axis: 'x', sign: -1 }
  ];
  for (const scenario of scenarios) {
    const { simulation, player } = createPlayer();
    player.body.position.set(...scenario.position);
    player.body.velocity.set(...scenario.velocity);
    player.heading = scenario.heading;
    player.body.quaternion.setFromEuler(0, player.heading, 0, 'XYZ');
    let maxY = player.body.position.y, maxOutward = scenario.sign * player.body.position[scenario.axis], maxAngularSpeed = 0;
    for (let i = 0; i < 90; i++) {
      simulation.setInput('me', { throttle: 1, steer: 0 });
      simulation.step(1 / 60);
      maxY = Math.max(maxY, player.body.position.y);
      maxOutward = Math.max(maxOutward, scenario.sign * player.body.position[scenario.axis]);
      maxAngularSpeed = Math.max(maxAngularSpeed, player.body.angularVelocity.length());
    }
    assert.ok(maxY > 3, `${scenario.axis}/${scenario.sign} stalled low at y=${maxY}`);
    assert.ok(maxOutward > (scenario.axis === 'z' ? FIELD.halfZ - FIELD.curveRadius + 3 : FIELD.halfX - FIELD.curveRadius + 3), `${scenario.axis}/${scenario.sign} failed to progress: ${maxOutward}`);
    assert.ok(maxAngularSpeed < 2.2, `${scenario.axis}/${scenario.sign} spun at ${maxAngularSpeed} rad/s`);
  }
});

test('a car slides from a side wall through a rounded vertical corner', () => {
  const { simulation, player } = createPlayer();
  player.body.position.set((FIELD.halfX - FIELD.cornerRadius) - 36, FIELD.curveRadius + 4, FIELD.halfZ - 0.56);
  player.body.velocity.set(18, 0, 0);
  player.heading = 0;
  player.body.quaternion.setFromEuler(-Math.PI / 2, 0, 0, 'XYZ');
  let maxX = player.body.position.x, minZ = player.body.position.z, minAlignment = 1, maxAngularSpeed = 0;
  for (let i = 0; i < 150; i++) {
    simulation.setInput('me', { throttle: 1, steer: 0 });
    simulation.step(1 / 60);
    maxX = Math.max(maxX, player.body.position.x);
    minZ = Math.min(minZ, player.body.position.z);
    maxAngularSpeed = Math.max(maxAngularSpeed, player.body.angularVelocity.length());
    if (player.body.position.x > FIELD.halfX - FIELD.cornerRadius && player.body.position.z > FIELD.halfZ - FIELD.cornerRadius) {
      const dx = player.body.position.x - (FIELD.halfX - FIELD.cornerRadius);
      const dz = player.body.position.z - (FIELD.halfZ - FIELD.cornerRadius);
      const radius = Math.hypot(dx, dz) || 1;
      const expectedUp = { x: -dx / radius, y: 0, z: -dz / radius };
      const up = player.body.quaternion.vmult({ x: 0, y: 1, z: 0 });
      minAlignment = Math.min(minAlignment, up.x * expectedUp.x + up.z * expectedUp.z);
    }
  }
  assert.ok(maxX > FIELD.halfX - FIELD.cornerRadius + 12 && minZ < FIELD.halfZ - 3, `car failed to round the wall corner: maxX=${maxX}, minZ=${minZ}`);
  assert.ok(minAlignment > 0.72, `car detached or rolled in the corner: alignment=${minAlignment}`);
  assert.ok(maxAngularSpeed < 2.2, `corner wall contact spun the car at ${maxAngularSpeed} rad/s`);
});

test('rounded arena transitions use continuous heightfields instead of overlapping tangent boxes', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  const heightfields = simulation.world.bodies.flatMap(body => body.shapes).filter(shape => shape.constructor.name === 'Heightfield');
  assert.ok(heightfields.length >= 12, `expected continuous curved surfaces, found ${heightfields.length} heightfields`);
});

test('cars glance through all four low corners without escaping or getting caught on a seam', () => {
  for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) {
    const { simulation, player } = createPlayer();
    player.body.position.set(sideX * ((FIELD.halfX - FIELD.cornerRadius) - 32), 1.05, sideZ * ((FIELD.halfZ - FIELD.cornerRadius) + 16));
    player.body.velocity.set(sideX * 26, 0, 0);
    player.body.angularVelocity.setZero();
    player.heading = sideX > 0 ? 0 : Math.PI;
    player.body.quaternion.setFromEuler(0, player.heading, 0, 'XYZ');
    let consecutiveSlow = 0, maxConsecutiveSlow = 0, enteredCorner = false;
    for (let i = 0; i < 150; i++) {
      const speed = Math.hypot(player.body.velocity.x, player.body.velocity.z);
      if (speed > 0.2) player.heading = Math.atan2(-player.body.velocity.z, player.body.velocity.x);
      simulation.step(1 / 60);
      if (sideX * player.body.position.x > FIELD.halfX - FIELD.cornerRadius && sideZ * player.body.position.z > FIELD.halfZ - FIELD.cornerRadius) enteredCorner = true;
      if (enteredCorner && speed < 1.5) consecutiveSlow++; else consecutiveSlow = 0;
      maxConsecutiveSlow = Math.max(maxConsecutiveSlow, consecutiveSlow);
      assert.ok(Math.abs(player.body.position.x) < FIELD.halfX + 2 && Math.abs(player.body.position.z) < FIELD.halfZ + 2, `car escaped through corner ${sideX}/${sideZ}`);
    }
    assert.ok(enteredCorner, `trajectory never reached corner ${sideX}/${sideZ}`);
    assert.ok(maxConsecutiveSlow < 30, `car remained caught in corner ${sideX}/${sideZ} for ${maxConsecutiveSlow} frames`);
  }
});
