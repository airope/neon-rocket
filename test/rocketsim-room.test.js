import test from 'node:test';
import assert from 'node:assert/strict';

const MODULE_URL = new URL('../server/rocketsim-room.js', import.meta.url);

test('authoritative RocketSim room simulates two players and emits compact render snapshots', async () => {
  const { createRocketSimRoom } = await import(MODULE_URL);
  const sim = await createRocketSimRoom({ targetScore: 5 });
  sim.addPlayer({ id: 'A', name: 'Azur', team: 0 });
  sim.addPlayer({ id: 'B', name: 'Rose', team: 1 });
  sim.start();
  for (let tick = 0; tick < 360; tick++) sim.step(1 / 120);
  const before = sim.snapshot();
  sim.setInput('A', { throttle: 1, boost: true });
  for (let tick = 0; tick < 120; tick++) sim.step(1 / 120);
  const after = sim.snapshot();

  assert.equal(after.physics.engine, 'rocketsim-wasm');
  assert.equal(after.physics.tickRate, 120);
  assert.equal(after.players.length, 2);
  assert.equal(after.players[0].p.length, 3);
  assert.equal(after.players[0].q.length, 4);
  assert.equal(after.ball.q.length, 4);
  assert.ok(after.players.find(player => player.id === 'A').p[0] > before.players.find(player => player.id === 'A').p[0] + 5);
  assert.equal(Object.hasOwn(after, 'world'), false);
  assert.equal(JSON.stringify(after).includes('HEAP'), false);
  sim.free();
});

test('authoritative room preserves aerial zero axes and animates ball rolling', async () => {
  const { createRocketSimRoom } = await import(MODULE_URL);
  const sim = await createRocketSimRoom();
  sim.addPlayer({ id: 'A', team: 0 });
  sim.start();
  sim.setInput('A', { throttle: 1, steer: 1, pitch: 0, yaw: 0 });
  assert.equal(sim.players.get('A').input.pitch, 0);
  assert.equal(sim.players.get('A').input.yaw, 0);
  sim.ball.setState({ position: { x: 0, y: .92, z: 0 }, velocity: { x: 12, y: 0, z: 4 } });
  const before = sim.snapshot().ball.q;
  sim.step();
  const after = sim.snapshot().ball.q;
  assert.notDeepEqual(after, before);
  assert.ok(Math.abs(Math.hypot(...after) - 1) < 1e-9);
  sim.free();
});
