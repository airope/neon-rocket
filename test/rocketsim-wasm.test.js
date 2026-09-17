import test from 'node:test';
import assert from 'node:assert/strict';

const MODULE_URL = new URL('../native/rocketsim/dist/rocketsim.mjs', import.meta.url);

test('RocketSim WASM executes the complete car control surface in Node', async () => {
  const { createRocketSimModule } = await import(MODULE_URL);
  const rocketSim = await createRocketSimModule();
  const arena = rocketSim.createArena({ tickRate: 120 });
  const car = arena.addOctane({ team: 0 });

  car.setControls({});
  arena.step(90);
  assert.equal(car.getState().wheelContactCount, 4);

  car.setControls({
    throttle: 1,
    steer: 0.25,
    pitch: -0.5,
    yaw: 0.4,
    roll: -0.3,
    jump: true,
    boost: true,
    handbrake: false
  });
  arena.step(1);

  const state = car.getState();
  assert.equal(state.tickCount, 91);
  assert.equal(state.lastControls.throttle, 1);
  assert.ok(Math.abs(state.lastControls.steer - 0.25) < 1e-6);
  assert.ok(Math.abs(state.lastControls.pitch + 0.5) < 1e-6);
  assert.ok(Math.abs(state.lastControls.yaw - 0.4) < 1e-6);
  assert.ok(Math.abs(state.lastControls.roll + 0.3) < 1e-6);
  assert.equal(state.lastControls.jump, true);
  assert.equal(state.lastControls.boost, true);
  assert.equal(state.lastControls.handbrake, false);
  assert.equal(state.hasJumped, true);
  assert.ok(state.position.y > 0);

  arena.destroy();
});

test('RocketSim WASM refills boost without moving or reorienting the car', async () => {
  const { createRocketSimModule } = await import(MODULE_URL);
  const rocketSim = await createRocketSimModule();
  const arena = rocketSim.createArena();
  const car = arena.addOctane();
  car.setState({ position: { x: -12, y: .4, z: 3 }, velocity: { x: 0, y: 0, z: 0 }, yaw: .35, boost: 7 });
  const before = car.getState();
  car.setBoost(88);
  const after = car.getState();
  assert.ok(Math.abs(after.boost - 88) < .01);
  assert.deepEqual(after.position, before.position);
  assert.deepEqual(after.rotation, before.rotation);
  arena.destroy();
});

test('RocketSim WASM places a car at a playable Neon kickoff pose', async () => {
  const { createRocketSimModule } = await import(MODULE_URL);
  const rocketSim = await createRocketSimModule();
  const arena = rocketSim.createArena();
  const car = arena.addOctane({ team: 0 });

  car.setState({
    position: { x: -20, y: 0.37, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    boost: 33
  });
  arena.step(1);

  const state = car.getState();
  assert.ok(Math.abs(state.position.x + 20) < 0.2);
  assert.ok(state.position.y > 0.1 && state.position.y < 1);
  assert.equal(Math.round(state.boost), 33);
  arena.destroy();
});

test('RocketSim WASM ball enters and remains inside the shared Neon goal tunnel', async () => {
  const [{ createRocketSimModule }, { buildCarSoccerArenaMesh }] = await Promise.all([
    import(MODULE_URL),
    import('../shared/car-soccer-arena-mesh.js')
  ]);
  const rocketSim = await createRocketSimModule();
  const arena = rocketSim.createArena({ simpleBounds: false });
  arena.addStaticMesh(buildCarSoccerArenaMesh());
  arena.ball.setState({ position: { x: 45, y: 2, z: 0 }, velocity: { x: 40, y: 0, z: 0 } });

  arena.step(30);
  const insideGoal = arena.ball.getState();
  assert.ok(insideGoal.position.x > 51.2, `ball did not cross goal line: ${insideGoal.position.x}`);
  assert.ok(insideGoal.position.x < 60.3);

  arena.step(120);
  const afterBackWall = arena.ball.getState();
  assert.ok(afterBackWall.position.x <= 60.3);
  assert.ok(afterBackWall.velocity.x < 0, 'goal back must return the ball toward the field');
  arena.destroy();
});

test('RocketSim WASM confines its native ball inside Neon arena dimensions', async () => {
  const { createRocketSimModule } = await import(MODULE_URL);
  const rocketSim = await createRocketSimModule();
  const arena = rocketSim.createArena({
    tickRate: 120,
    halfLength: 51.2,
    halfWidth: 40.96,
    ceiling: 20.44
  });

  arena.ball.setState({
    position: { x: 0, y: 10, z: 0 },
    velocity: { x: 90, y: 8, z: 70 }
  });
  arena.step(240);

  const ball = arena.ball.getState();
  assert.ok(Math.abs(ball.position.x) <= 51.2 - 0.9);
  assert.ok(Math.abs(ball.position.z) <= 40.96 - 0.9);
  assert.ok(ball.position.y >= 0.9);
  assert.ok(ball.position.y <= 20.44 - 0.9);
  assert.ok(ball.tickCount >= 240);
  arena.destroy();
});
