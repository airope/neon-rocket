import test from 'node:test';
import assert from 'node:assert/strict';
import { createRocketSimSoloSimulation, loadRocketSimModule, sanitizeRocketSimControls } from '../shared/rocketsim-local-simulation.js';

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('NOVA 1 local native backend preserves the Neon match contract', async () => {
  const sim = await createRocketSimSoloSimulation({ targetScore: 5 });
  sim.addPlayer({ id: 'LOCAL', name: 'Pilote', team: 0 });
  sim.addPlayer({ id: 'NOVA', name: 'NOVA 1', team: 1, isBot: true });
  sim.start();

  const kickoff = sim.snapshot();
  assert.equal(kickoff.status, 'countdown');
  assert.equal(kickoff.players.length, 2);
  assert.equal(kickoff.boostPads.length, 20);
  assert.equal(kickoff.boostPads.filter(pad => pad.active).length, 20);
  assert.ok(kickoff.players.find(player => player.id === 'LOCAL').p[0] <= -29.9);
  assert.ok(kickoff.players.find(player => player.id === 'NOVA').p[0] >= 29.9);

  for (let tick = 0; tick < 360; tick++) sim.step();
  assert.equal(sim.snapshot().status, 'playing');

  const player = sim.players.get('LOCAL');
  const pad = sim.boostPads.find(candidate => candidate.amount === 100);
  player.car.setState({ position: { x: pad.x, y: .37, z: pad.z }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, boost: 4 });
  const before = sim.snapshot().players.find(candidate => candidate.id === 'LOCAL');
  sim.step();
  const after = sim.snapshot().players.find(candidate => candidate.id === 'LOCAL');
  assert.equal(sim.snapshot().boostPads.find(candidate => candidate.id === pad.id).active, false);
  assert.ok(after.boost > 99);
  assert.ok(distance(before.p, after.p) < .2);

  sim.free();
});

test('native solo snapshots animate the rolling ball skin', async () => {
  const sim = await createRocketSimSoloSimulation();
  sim.ball.setState({ position: { x: 0, y: .92, z: 0 }, velocity: { x: 12, y: 0, z: 4 } });
  const before = sim.snapshot().ball.q;
  sim.step();
  const after = sim.snapshot().ball.q;
  assert.notDeepEqual(after, before);
  assert.ok(Math.abs(Math.hypot(...after) - 1) < 1e-9);
  sim.free();
});

test('explicit neutral aerial axes are not replaced by ground throttle and steer', async () => {
  const controls = sanitizeRocketSimControls({ throttle: 1, steer: 1, pitch: 0, yaw: 0, roll: 0 });
  assert.equal(controls.pitch, 0);
  assert.equal(controls.yaw, 0);

  const sim = await createRocketSimSoloSimulation();
  sim.addPlayer({ id: 'LOCAL', team: 0 });
  assert.doesNotThrow(() => sim.setInput('LOCAL', controls));
  assert.deepEqual(sim.players.get('LOCAL').input, controls);
  sim.free();
});

test('browser RocketSim loader retries WASM fetch and supplies a custom Emscripten instantiator', async () => {
  let fetches = 0;
  let receivedOptions;
  const module = { ready: true };
  const result = await loadRocketSimModule({
    preloadWasm: true,
    attempts: 3,
    fetchImpl: async () => {
      fetches++;
      if (fetches === 1) throw new TypeError('temporary tunnel failure');
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer };
    },
    createModule: async options => { receivedOptions = options; return module; }
  });

  assert.equal(fetches, 2);
  assert.equal(result, module);
  let instance;
  receivedOptions.instantiateWasm({}, value => { instance = value; });
  assert.ok(instance instanceof WebAssembly.Instance);
});

test('browser RocketSim loader uses bundled WASM without any runtime fetch', async () => {
  let fetches = 0;
  let receivedOptions;
  const bundledWasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  await loadRocketSimModule({
    preloadWasm: true,
    bundledWasm,
    fetchImpl: async () => { fetches++; throw new Error('network must not be used'); },
    createModule: async options => { receivedOptions = options; return {}; }
  });

  assert.equal(fetches, 0);
  let instance;
  receivedOptions.instantiateWasm({}, value => { instance = value; });
  assert.ok(instance instanceof WebAssembly.Instance);
});

test('every selectable NOVA opponent uses the same native Neon backend', async () => {
  for (const aiVersion of [1, 2, 3]) {
    const sim = await createRocketSimSoloSimulation({ targetScore: 5 });
    sim.addPlayer({ id: 'LOCAL', name: 'Pilote', team: 0 });
    sim.addPlayer({ id: 'NOVA', name: `NOVA ${aiVersion}`, team: 1, isBot: true, aiVersion });
    sim.start();
    const state = sim.snapshot();
    const nova = state.players.find(player => player.id === 'NOVA');
    assert.equal(state.physics.engine, 'native');
    assert.equal(nova.aiVersion, aiVersion);
    assert.equal(sim.players.get('NOVA').aiVersion, aiVersion);
    for (let tick = 0; tick <= 360; tick++) sim.step();
    const strategy = sim.players.get('NOVA').input.strategy;
    if (aiVersion === 1) assert.equal(strategy, 'direct');
    if (aiVersion === 2) assert.match(strategy, /^tactical-/);
    if (aiVersion === 3) assert.match(strategy, /^wildfire-/);
    sim.free();
  }
});
