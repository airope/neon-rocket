import { createRocketSimModule } from '../native/rocketsim/dist/rocketsim.mjs';
import { buildCarSoccerArenaMesh } from '../shared/car-soccer-arena-mesh.js';
import { CAR_SOCCER_FIELD, CAR_SOCCER_VERSION } from '../shared/car-soccer-contract.js';
import { goalTeamForBall } from '../shared/rocketsim-match.js';
import { BOOST_PAD_LAYOUT } from '../shared/boost-pad-layout.js';
import { sanitizeRocketSimControls } from '../shared/rocketsim-controls.js';
import { integrateRollingQuaternion } from '../shared/rolling-quaternion.js';

const modulePromise = createRocketSimModule();
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

export async function createRocketSimRoom({ targetScore = 5 } = {}) {
  const rocketSim = await modulePromise;
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
    mode: 'multi', targetScore, players: new Map(), score: [0, 0], status: 'waiting', ball: arena.ball,
    countdown: 0, winner: null, events: [], countdownTicks: 0, goalTicks: 0,
    boostPads: BOOST_PAD_LAYOUT.map(pad => ({ ...pad, active: true, timer: 0 })),
    addPlayer({ id, name = 'Player', team = 0, isBot = false } = {}) {
      if (this.players.has(id)) return this.players.get(id);
      const player = { id, name, team, isBot, car: arena.addOctane({ team }), input: neutral() };
      this.players.set(id, player);
      this.spawnPlayer(player);
      return player;
    },
    removePlayer(id) { this.players.delete(id); if (this.status !== 'waiting') this.status = 'waiting'; },
    spawnPlayer(player) {
      const side = player.team === 0 ? -1 : 1;
      player.car.setState({ position: { x: side * 30, y: .37, z: player.team === 0 ? -4 : 4 }, velocity: { x: 0, y: 0, z: 0 }, yaw: player.team === 0 ? 0 : Math.PI, boost: 33 });
      player.car.setControls({}); player.input = neutral();
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
      for (const player of this.players.values()) player.car.setControls(active ? player.input : neutral());
      arena.step(1);
      const steppedBall = arena.ball.getState();
      ballVisualQuaternion = integrateRollingQuaternion(ballVisualQuaternion, [steppedBall.velocity.x, steppedBall.velocity.y, steppedBall.velocity.z], CAR_SOCCER_FIELD.ballRadius, 1 / 120);
      if (!active) return;
      for (const pad of this.boostPads) {
        if (!pad.active) {
          pad.timer -= 1 / 120;
          if (pad.timer <= 0) { pad.active = true; pad.timer = 0; }
          continue;
        }
        for (const player of this.players.values()) {
          const state = player.car.getState();
          if (state.position.y < 1.2 && Math.hypot(state.position.x - pad.x, state.position.z - pad.z) < pad.radius) {
            player.car.setBoost(Math.min(100, state.boost + pad.amount));
            pad.active = false; pad.timer = pad.recharge;
            break;
          }
        }
      }
      const team = goalTeamForBall(steppedBall, CAR_SOCCER_FIELD);
      if (team === null) return;
      this.score[team]++;
      const goalBall = steppedBall;
      this.events.push({ type: 'goal', team, score: [...this.score], position: [goalBall.position.x, goalBall.position.y, goalBall.position.z] });
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
        physics: { engine: 'rocketsim-wasm', version: 'RocketSim-2.2.1-wasm', tickRate: 120, arena: 'neon-shared-trimesh-v1', contract: CAR_SOCCER_VERSION },
        ball: { p: [ball.position.x, ball.position.y, ball.position.z], q: [...ballVisualQuaternion], v: [ball.velocity.x, ball.velocity.y, ball.velocity.z] },
        boostPads: this.boostPads.map(pad => ({ id: pad.id, x: pad.x, z: pad.z, amount: pad.amount, active: pad.active, timer: pad.timer })),
        players: [...this.players.values()].map(player => {
          const state = player.car.getState();
          return {
            id: player.id, name: player.name, team: player.team, isBot: player.isBot,
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
