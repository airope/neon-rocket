import { createRocketSimModule } from '../native/rocketsim/dist/rocketsim.mjs';
import { buildCarSoccerArenaMesh } from './car-soccer-arena-mesh.js';
import { CAR_SOCCER_FIELD, CAR_SOCCER_VERSION } from './car-soccer-contract.js';
import { BOOST_PAD_LAYOUT } from './boost-pad-layout.js';
import { goalTeamForBall } from './rocketsim-match.js';
import { controlsForNovaVersion } from './rocketsim-nova.js';
import { integrateRollingQuaternion } from './rolling-quaternion.js';
import { sanitizeRocketSimControls } from './rocketsim-controls.js';
import { bundledRocketSimWasm } from './rocketsim-wasm-bundled.js';
export { sanitizeRocketSimControls } from './rocketsim-controls.js';

const DT = 1 / 120;
let modulePromise;
const WASM_URL = new URL('../native/rocketsim/dist/rocketsim-raw.wasm', import.meta.url);

const moduleOptionsForWasm = wasmBinary => ({
  instantiateWasm(imports, receiveInstance) {
    const module = new WebAssembly.Module(wasmBinary);
    const instance = new WebAssembly.Instance(module, imports);
    receiveInstance(instance);
    return instance.exports;
  }
});

export async function loadRocketSimModule({
  preloadWasm = typeof window !== 'undefined',
  bundledWasm,
  attempts = 3,
  fetchImpl = globalThis.fetch,
  createModule = createRocketSimModule,
  wasmUrl = WASM_URL
} = {}) {
  if (!preloadWasm) return createModule();
  if (bundledWasm) return createModule(moduleOptionsForWasm(bundledWasm));
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(wasmUrl, { cache: attempt ? 'reload' : 'default' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const wasmBinary = new Uint8Array(await response.arrayBuffer());
      if (wasmBinary.length < 8 || wasmBinary[0] !== 0 || wasmBinary[1] !== 97 || wasmBinary[2] !== 115 || wasmBinary[3] !== 109) {
        throw new Error('invalid WASM payload');
      }
      return createModule(moduleOptionsForWasm(wasmBinary));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`RocketSim WASM unavailable after ${attempts} attempts: ${lastError?.message || lastError}`);
}

const rocketSimModule = () => {
  if (!modulePromise) modulePromise = loadRocketSimModule({
    bundledWasm: typeof window !== 'undefined' ? bundledRocketSimWasm() : undefined
  }).catch(error => {
    modulePromise = undefined;
    throw error;
  });
  return modulePromise;
};
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const neutral = () => ({ throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false });

function quaternionFromBasis(forward, up) {
  const right = {
    x: forward.y * up.z - forward.z * up.y,
    y: forward.z * up.x - forward.x * up.z,
    z: forward.x * up.y - forward.y * up.x
  };
  const m00 = forward.x, m01 = up.x, m02 = right.x;
  const m10 = forward.y, m11 = up.y, m12 = right.y;
  const m20 = forward.z, m21 = up.z, m22 = right.z;
  const trace = m00 + m11 + m22;
  let x, y, z, w;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = .25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = .25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = .25 * s; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = .25 * s;
  }
  return [x, y, z, w];
}

export async function createRocketSimSoloSimulation({ targetScore = 5 } = {}) {
  const rocketSim = await rocketSimModule();
  const arena = rocketSim.createArena({
    tickRate: 120,
    halfLength: CAR_SOCCER_FIELD.halfLength,
    halfWidth: CAR_SOCCER_FIELD.halfWidth,
    ceiling: CAR_SOCCER_FIELD.ceiling,
    simpleBounds: false
  });
  arena.addStaticMesh(buildCarSoccerArenaMesh());
  let ballVisualQuaternion = [0, 0, 0, 1];

  const sim = {
    mode: 'solo', targetScore, players: new Map(), score: [0, 0], status: 'waiting',
    ball: arena.ball,
    countdown: 0, winner: null, events: [], countdownTicks: 0, goalTicks: 0,
    boostPads: BOOST_PAD_LAYOUT.map(pad => ({ ...pad, active: true, timer: 0 })),
    addPlayer({ id, name = 'Player', team = 0, isBot = false, aiVersion = 1 } = {}) {
      const player = { id, name, team, isBot, aiVersion, car: arena.addOctane({ team }), input: neutral() };
      this.players.set(id, player);
      this.spawnPlayer(player);
      return player;
    },
    spawnPlayer(player) {
      const side = player.team === 0 ? -1 : 1;
      player.car.setState({
        position: { x: side * 30, y: .37, z: player.team === 0 ? -4 : 4 },
        velocity: { x: 0, y: 0, z: 0 },
        yaw: player.team === 0 ? 0 : Math.PI,
        boost: 33
      });
      player.car.setControls({});
      player.input = neutral();
    },
    kickoff() {
      arena.ball.setState({ position: { x: 0, y: CAR_SOCCER_FIELD.ballRadius + .05, z: 0 }, velocity: { x: 0, y: 0, z: 0 } });
      ballVisualQuaternion = [0, 0, 0, 1];
      for (const player of this.players.values()) this.spawnPlayer(player);
      for (const pad of this.boostPads) { pad.active = true; pad.timer = 0; }
      this.status = 'countdown'; this.countdownTicks = 360; this.countdown = 3; this.goalTicks = 0;
      this.events.push({ type: 'countdown', value: 3 });
    },
    start() { this.score = [0, 0]; this.winner = null; this.kickoff(); },
    setInput(id, input) { const player = this.players.get(id); if (player && !player.isBot) player.input = sanitizeRocketSimControls(input); },
    updateBoostPads(states) {
      for (const pad of this.boostPads) {
        if (!pad.active) {
          pad.timer -= DT;
          if (pad.timer <= 0) { pad.active = true; pad.timer = 0; }
          continue;
        }
        for (const player of this.players.values()) {
          const state = states.get(player.id);
          if (state.position.y < 1.2 && Math.hypot(state.position.x - pad.x, state.position.z - pad.z) < pad.radius) {
            player.car.setBoost(Math.min(100, state.boost + pad.amount));
            pad.active = false; pad.timer = pad.recharge;
            break;
          }
        }
      }
    },
    step() {
      if (this.status === 'finished') return;
      if (this.status === 'goal') {
        if (--this.goalTicks <= 0) this.kickoff();
        return;
      }
      if (this.status === 'countdown') {
        this.countdownTicks--;
        const next = Math.max(0, Math.ceil(this.countdownTicks / 120));
        if (next !== this.countdown) { this.countdown = next; if (next > 0) this.events.push({ type: 'countdown', value: next }); }
        if (this.countdownTicks <= 0) { this.status = 'playing'; this.countdown = 0; this.events.push({ type: 'go' }); }
      }
      const active = this.status === 'playing';
      const ball = arena.ball.getState();
      for (const player of this.players.values()) {
        if (player.isBot && active) player.input = controlsForNovaVersion(player.aiVersion, {
          team: player.team,
          car: player.car.getState(),
          ball,
          field: CAR_SOCCER_FIELD,
          boostPads: this.boostPads
        });
        player.car.setControls(active ? sanitizeRocketSimControls(player.input) : neutral());
      }
      arena.step(1);
      const steppedBall = arena.ball.getState();
      ballVisualQuaternion = integrateRollingQuaternion(
        ballVisualQuaternion,
        [steppedBall.velocity.x, steppedBall.velocity.y, steppedBall.velocity.z],
        CAR_SOCCER_FIELD.ballRadius,
        DT
      );
      if (!active) return;
      const states = new Map([...this.players].map(([id, player]) => [id, player.car.getState()]));
      this.updateBoostPads(states);
      const scoredBall = steppedBall;
      const team = goalTeamForBall(scoredBall, CAR_SOCCER_FIELD);
      if (team === null) return;
      this.score[team]++;
      this.events.push({ type: 'goal', team, score: [...this.score], position: [scoredBall.position.x, scoredBall.position.y, scoredBall.position.z] });
      if (this.score[team] >= this.targetScore) {
        this.status = 'finished'; this.winner = team;
        this.events.push({ type: 'finished', team, score: [...this.score] });
      } else { this.status = 'goal'; this.goalTicks = 180; }
    },
    drainEvents() { const events = this.events; this.events = []; return events; },
    snapshot() {
      const ball = arena.ball.getState();
      return {
        mode: this.mode, status: this.status, countdown: this.countdown, score: [...this.score], winner: this.winner,
        physics: { engine: 'native', version: 'neon-authoritative-v1', tickRate: 120, arena: 'neon-v1', contract: CAR_SOCCER_VERSION },
        ball: { p: [ball.position.x, ball.position.y, ball.position.z], q: [...ballVisualQuaternion], v: [ball.velocity.x, ball.velocity.y, ball.velocity.z] },
        boostPads: this.boostPads.map(pad => ({ id: pad.id, x: pad.x, z: pad.z, amount: pad.amount, active: pad.active, timer: pad.timer })),
        players: [...this.players.values()].map(player => {
          const state = player.car.getState();
          return {
            id: player.id, name: player.name, team: player.team, isBot: player.isBot, aiVersion: player.aiVersion,
            aiState: player.isBot ? player.input.strategy || null : null,
            boost: state.boost, boosting: state.isBoosting, wheelContacts: state.wheelContactCount,
            p: [state.position.x, state.position.y, state.position.z],
            q: quaternionFromBasis(state.rotation.forward, state.rotation.up),
            v: [state.velocity.x, state.velocity.y, state.velocity.z]
          };
        })
      };
    },
    free() { arena.destroy(); this.players.clear(); }
  };
  return sim;
}
