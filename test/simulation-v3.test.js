import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSimulation, FIELD, PHYSICS_VERSION } from '../shared/simulation-v3.js';

test('GameSimulation V3 is authoritative Rapier with compact arena and four-wheel players', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  try {
    const player = simulation.addPlayer({ id: 'me', team: 0 });
    assert.equal(PHYSICS_VERSION, 'rapier3d-deterministic-0.19.3@120hz');
    assert.equal(FIELD.halfX, 51.2);
    assert.equal(simulation.arena.version, 'neon-prism-bowl-v3');
    assert.equal(player.controller.vehicle.numWheels(), 4);
    assert.equal(player.body.engine, 'rapier');
  } finally {
    simulation.free();
  }
});

test('V3 public API drives, jumps and snapshots actual Rapier bodies', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  try {
    const player = simulation.addPlayer({ id: 'me', team: 0 });
    simulation.start();
    simulation.status = 'playing';
    simulation.setInput('me', { throttle: 1 });
    for (let tick = 0; tick < 360; tick++) simulation.step(1 / 120);
    const speed = Math.hypot(player.body.velocity.x, player.body.velocity.z);
    assert.ok(speed > 19 && speed < 25, `drive speed ${speed}`);
    simulation.setInput('me', { throttle: 0, jump: true });
    for (let tick = 0; tick < 18; tick++) simulation.step(1 / 120);
    assert.ok(player.body.position.y > 0.8, `jump y=${player.body.position.y}`);
    const snapshot = simulation.snapshot();
    assert.equal(snapshot.physics.engine, 'rapier3d-deterministic');
    assert.equal(snapshot.physics.tickRate, 120);
    assert.equal(snapshot.players[0].wheelContacts.length, 4);
    assert.ok(snapshot.players[0].suspensionLengths.length === 4);
  } finally {
    simulation.free();
  }
});

test('NOVA-WF remains a distinct controller on the Rapier simulation', () => {
  const simulation = new GameSimulation({ mode: 'duel' });
  try {
    simulation.addPlayer({ id: 'WF', team: 0, isBot: true, aiVersion: 3, controllerId: 'nova-wf-v3' });
    simulation.addPlayer({ id: 'N2', team: 1, isBot: true, aiVersion: 2 });
    simulation.start();
    simulation.status = 'playing';
    for (let tick = 0; tick < 36; tick++) simulation.step(1 / 120);
    const wf = simulation.snapshot().players.find(player => player.id === 'WF');
    assert.equal(wf.ai.version, 3);
    assert.equal(wf.ai.controllerId, 'nova-wf-v3');
    assert.ok(['kickoff', 'boost-route', 'wall-hit', 'patient-shot', 'clear', 'return', 'shadow', 'fallback'].includes(wf.ai.state));
  } finally {
    simulation.free();
  }
});

test('Rapier bots steer toward an off-axis target instead of mirroring it', () => {
  const simulation = new GameSimulation({ mode: 'solo' });
  try {
    const bot = simulation.addPlayer({ id: 'N1', team: 0, isBot: true, aiVersion: 1 });
    bot.body.position.set(0, 0.6, 0);
    bot.body.quaternion.setFromEuler(0, 0, 0, 'XYZ');
    simulation.ball.position.set(20, FIELD.ballRadius + 0.05, 8);
    simulation.ball.velocity.setZero();
    simulation.status = 'playing';
    simulation.step(1 / 120);
    assert.ok(bot.input.steer < 0, `target at +Z requires negative Rapier steer, got ${bot.input.steer}`);
    for (let tick = 0; tick < 119; tick++) simulation.step(1 / 120);
    assert.ok(bot.body.position.z > 0.5, `bot mirrored target and moved to z=${bot.body.position.z}`);
  } finally {
    simulation.free();
  }
});

test('duel anti-deadlock nudges a stationary ball without changing the score', () => {
  const simulation = new GameSimulation({ mode: 'duel' });
  try {
    simulation.addPlayer({ id: 'L', team: 0 });
    simulation.addPlayer({ id: 'R', team: 1 });
    simulation.status = 'playing';
    for (let tick = 0; tick < 400; tick++) simulation.step(1 / 120);
    const events = simulation.drainEvents();
    assert.ok(events.some(event => event.type === 'duelNudge'), 'missing duelNudge event');
    assert.deepEqual(simulation.score, [0, 0]);
    assert.ok(Math.hypot(simulation.ball.velocity.x, simulation.ball.velocity.z) > 2,
      `nudge did not create progress: ${JSON.stringify(simulation.ball.velocity)}`);
  } finally {
    simulation.free();
  }
});

test('duel anti-deadlock resets a match with no sustained goal-axis progress', () => {
  const simulation = new GameSimulation({ mode: 'duel' });
  try {
    simulation.addPlayer({ id: 'L', team: 0 });
    simulation.addPlayer({ id: 'R', team: 1 });
    simulation.status = 'playing';
    for (let tick = 0; tick < 1500; tick++) {
      simulation.ball.position.set(0, FIELD.ballRadius + 0.05, Math.sin(tick / 30) * 4);
      simulation.ball.velocity.setZero();
      simulation.step(1 / 120);
    }
    const events = simulation.drainEvents();
    assert.ok(events.some(event => event.type === 'duelReset'), 'missing duelReset event');
    assert.deepEqual(simulation.score, [0, 0]);
    assert.equal(simulation.status, 'countdown');
  } finally {
    simulation.free();
  }
});
