import { RAPIER, ENGINE_CONTRACT } from './rapier-engine.js';
import { CAR_SOCCER_FIELD, CAR_SOCCER_VERSION, OCTANE_CLASS_CAR } from './car-soccer-contract.js';
import { buildRapierArena, RAPIER_ARENA_VERSION } from './rapier-arena.js';
import { RapierCarController } from './rapier-car-controller.js';
import { Quaternion, RapierBodyAdapter, Vec3 } from './rapier-body-adapter.js';
import { attackingContact, chooseNovaWfState, driveToTarget, findReachableIntercept, normalizeNovaWfParameters, shadowTarget } from './nova-wf.js';
export { BOOST_PAD_LAYOUT } from './boost-pad-layout.js';
import { BOOST_PAD_LAYOUT } from './boost-pad-layout.js';

export const PHYSICS_VERSION = `rapier3d-deterministic-${ENGINE_CONTRACT.version}@${ENGINE_CONTRACT.tickRate}hz`;
export const ARENA_VERSION = RAPIER_ARENA_VERSION;
export const FIELD = Object.freeze({
  halfX: CAR_SOCCER_FIELD.halfLength,
  halfZ: CAR_SOCCER_FIELD.halfWidth,
  ceilingY: CAR_SOCCER_FIELD.ceiling,
  ballRadius: CAR_SOCCER_FIELD.ballRadius,
  goalHalf: CAR_SOCCER_FIELD.goalHalfWidth,
  goalHeight: CAR_SOCCER_FIELD.goalHeight,
  goalDepth: CAR_SOCCER_FIELD.goalDepth,
  curveRadius: CAR_SOCCER_FIELD.floorCurveRadius,
  cornerRadius: CAR_SOCCER_FIELD.cornerRadius
});
export const CAR = Object.freeze({
  chassisHalf: Object.freeze({
    x: OCTANE_CLASS_CAR.hitboxSize.x / 2,
    y: OCTANE_CLASS_CAR.hitboxSize.y / 2,
    z: OCTANE_CLASS_CAR.hitboxSize.z / 2
  }),
  bumperHalf: Object.freeze({ x: 0.18, y: 0.12, z: 0.36 }),
  bumperOffset: Object.freeze({ x: 0.56, y: 0.12, z: 0 }),
  restY: 0.28,
  curveClearance: 0.28,
  visualScale: 0.48,
  wheelRadius: 0.31,
  wheelWidth: 0.25,
  wheelX: 0.89,
  wheelZ: 0.58,
  wheelCenterY: -0.28
});

const DT = 1 / ENGINE_CONTRACT.tickRate;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

export class GameSimulation {
  constructor({ mode = 'multi', targetScore = 5, random = Math.random, kickoffRandom = random, novaWfParameters = {}, evaluationKickoffVariation = false } = {}) {
    if (typeof random !== 'function') throw new TypeError('random must be a function');
    if (typeof kickoffRandom !== 'function') throw new TypeError('kickoffRandom must be a function');
    if (typeof evaluationKickoffVariation !== 'boolean') throw new TypeError('evaluationKickoffVariation must be a boolean');
    this.mode = mode;
    this.targetScore = targetScore;
    this.random = random;
    this.kickoffRandom = kickoffRandom;
    this.evaluationKickoffVariation = evaluationKickoffVariation;
    this.novaWfParameters = normalizeNovaWfParameters(novaWfParameters);
    this.players = new Map();
    this.score = [0, 0];
    this.status = 'waiting';
    this.countdown = 0;
    this.winner = null;
    this.events = [];
    this.elapsed = 0;
    this.accumulator = 0;
    this.kickoffScenarios = [];
    this.duelKickoffIndex = 0;
    this.duelStallTime = 0;
    this.duelCollectiveStallTime = 0;
    this.duelNudgeIndex = 0;
    this.duelProgressAnchorX = 0;
    this.boostPads = BOOST_PAD_LAYOUT.map(pad => ({ ...pad, active: true, timer: 0 }));
    this.world = new RAPIER.World({ x: 0, y: -13, z: 0 });
    this.world.timestep = DT;
    this.arena = buildRapierArena(this.world);
    this.ballRigidBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, FIELD.ballRadius + 0.05, 0)
        .setLinearDamping(0.018)
        .setAngularDamping(0.025)
        .setCanSleep(false)
        .setCcdEnabled(true)
        .setAdditionalSolverIterations(4)
    );
    this.ballCollider = this.world.createCollider(
      RAPIER.ColliderDesc.ball(FIELD.ballRadius)
        .setMass(28)
        .setFriction(0.22)
        .setRestitution(0.71),
      this.ballRigidBody
    );
    this.ball = new RapierBodyAdapter(this.ballRigidBody);
    this.ball.engine = 'rapier';
  }

  addPlayer({ id, name = 'Player', team = 0, isBot = false, aiVersion = 2, controllerId = aiVersion, aiParameters = null } = {}) {
    const rigidBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, CAR.restY + 0.25, 0)
        .setCanSleep(false)
        .setCcdEnabled(true)
        .setLinearDamping(0.08)
        .setAngularDamping(0.16)
        .setAdditionalSolverIterations(4)
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(
        CAR.chassisHalf.x,
        CAR.chassisHalf.y,
        CAR.chassisHalf.z,
        0.06
      )
        .setTranslation(
          OCTANE_CLASS_CAR.hitboxOffset.x,
          OCTANE_CLASS_CAR.hitboxOffset.y,
          OCTANE_CLASS_CAR.hitboxOffset.z
        )
        .setMass(OCTANE_CLASS_CAR.mass)
        .setFriction(0.12)
        .setRestitution(0.16),
      rigidBody
    );
    const body = new RapierBodyAdapter(rigidBody);
    body.engine = 'rapier';
    const controller = new RapierCarController(this.world, rigidBody, { boost: 33 });
    const player = {
      id, name, team, isBot, aiVersion, controllerId, rigidBody, body, controller,
      novaWfParameters: aiVersion === 3 && aiParameters ? normalizeNovaWfParameters(aiParameters) : this.novaWfParameters,
      boost: 33, boosting: false, input: blankInput(), heading: team === 0 ? 0 : Math.PI,
      aiState: isBot ? 'kickoff' : null, aiTarget: new Vec3(), aiInterceptTime: 0,
      aiJumpCooldown: 0, aiCommitTimer: 0, aiStateSince: 0, aiAction: null,
      aiPrediction: null, aiPredictionTimer: 0, aiKickoffActive: true
    };
    this.players.set(id, player);
    this.#spawnCar(player);
    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    this.world.removeVehicleController(player.controller.vehicle);
    this.world.removeRigidBody(player.rigidBody);
    this.players.delete(id);
    if (this.mode === 'multi') this.status = 'waiting';
  }

  start() {
    this.score = [0, 0];
    this.winner = null;
    this.#kickoff();
  }

  setInput(id, input = {}) {
    const player = this.players.get(id);
    if (!player || player.isBot) return;
    player.input = sanitizeInput(input);
  }

  #spawnCar(player) {
    const side = player.team === 0 ? -1 : 1;
    player.body.position.set(side * 18, CAR.restY + 0.32, player.team === 0 ? -2.4 : 2.4);
    player.body.velocity.setZero();
    player.body.angularVelocity.setZero();
    player.heading = player.team === 0 ? 0 : Math.PI;
    player.body.quaternion.setFromEuler(0, player.heading, 0, 'XYZ');
    player.controller.reset({ boost: 33 });
    player.boost = 33;
    player.boosting = false;
    player.aiState = player.isBot ? 'kickoff' : null;
    player.aiTarget.set(0, 0, 0);
    player.aiInterceptTime = 0;
    player.aiJumpCooldown = 0;
    player.aiCommitTimer = 0;
    player.aiAction = null;
    player.aiPrediction = null;
    player.aiPredictionTimer = 0;
    player.aiKickoffActive = true;
  }

  #kickoff() {
    const kickoffZ = this.evaluationKickoffVariation
      ? (this.kickoffRandom() * 2 - 1) * 4
      : this.mode === 'duel' ? (this.duelKickoffIndex++ % 2 === 0 ? -2 : 2) : 0;
    this.ball.position.set(0, FIELD.ballRadius + 0.05, kickoffZ);
    this.ball.velocity.setZero();
    this.ball.angularVelocity.setZero();
    this.ball.quaternion.set(0, 0, 0, 1);
    if (this.evaluationKickoffVariation) this.kickoffScenarios.push({ index: this.kickoffScenarios.length, ballZ: kickoffZ });
    for (const player of this.players.values()) this.#spawnCar(player);
    for (const pad of this.boostPads) { pad.active = true; pad.timer = 0; }
    this.status = 'countdown';
    this.countdown = 3;
    this.countdownClock = 1;
    this.duelStallTime = 0;
    this.duelCollectiveStallTime = 0;
    this.duelProgressAnchorX = this.ball.position.x;
    this.events.push({ type: 'countdown', value: 3 });
  }

  #goal(team) {
    if (this.status !== 'playing') return;
    this.score[team]++;
    this.events.push({ type: 'goal', team, score: [...this.score], position: [this.ball.position.x, this.ball.position.y, this.ball.position.z] });
    if (this.score[team] >= this.targetScore) {
      this.status = 'finished';
      this.winner = team;
      this.events.push({ type: 'finished', team, score: [...this.score] });
    } else {
      this.status = 'goal';
      this.goalClock = 1.5;
    }
  }

  #botInput(player, dt) {
    player.aiJumpCooldown = Math.max(0, player.aiJumpCooldown - dt);
    player.aiCommitTimer = Math.max(0, player.aiCommitTimer - dt);
    if (player.aiVersion === 3) return this.#novaWfInput(player, dt);
    const attack = player.team === 0 ? 1 : -1;
    const position = player.body.position, ball = this.ball.position;
    const ownGoalThreat = attack * ball.x < -FIELD.halfX * 0.3 && this.ball.velocity.x * -attack > 3;
    const lowRecoverable = ball.y < 2.8 && Math.hypot(this.ball.velocity.x, this.ball.velocity.z) < 14;
    let target;
    if (player.aiVersion === 1 || lowRecoverable) {
      player.aiState = player.aiVersion === 1 ? 'nova1' : 'hunt';
      target = new Vec3(ball.x - attack * 1.8, 0.3, ball.z);
    } else if (ownGoalThreat) {
      player.aiState = 'save';
      target = new Vec3(ball.x - attack * 2.2, 0.3, ball.z + Math.sign(ball.z || 1) * 1.1);
    } else {
      player.aiState = 'intercept';
      const horizon = clamp(Math.hypot(ball.x - position.x, ball.z - position.z) / 22, 0.2, 1.2);
      player.aiInterceptTime = horizon;
      target = new Vec3(ball.x + this.ball.velocity.x * horizon - attack * 1.8, 0.3, ball.z + this.ball.velocity.z * horizon);
    }
    player.aiTarget.copy(target);
    const dx = target.x - position.x, dz = target.z - position.z;
    const desired = Math.atan2(-dz, dx);
    const forward = player.body.quaternion.vmult(new Vec3(1, 0, 0));
    const heading = Math.atan2(-forward.z, forward.x);
    const angle = wrap(desired - heading);
    const distance = Math.hypot(dx, dz);
    const jump = distance < 3.5 && ball.y > 1.6 && player.aiJumpCooldown <= 0;
    if (jump) player.aiJumpCooldown = 1;
    return {
      throttle: 1,
      steer: clamp(angle * 1.8, -1, 1),
      boost: Math.abs(angle) < 0.22 && distance > 10 && player.controller.boost > 5,
      jump,
      airRoll: 0
    };
  }

  #updateNovaWfAction(player, dt, target) {
    if (!player.aiAction) return null;
    player.aiAction.elapsed += dt;
    if (player.aiAction.elapsed >= 0.24) {
      player.aiAction = null;
      player.aiJumpCooldown = 0.75;
      return null;
    }
    const forward = player.body.quaternion.vmult(new Vec3(1, 0, 0));
    const car = { position: player.body.position, yaw: Math.atan2(-forward.z, forward.x), boost: player.boost };
    const input = driveToTarget(car, target, { urgent: true, allowReverse: false, parameters: player.novaWfParameters });
    input.jump = player.aiAction.elapsed < 0.09 || player.aiAction.elapsed >= 0.16;
    return { ...input, steer: -input.steer };
  }

  #predictBotTrajectory(horizon = 2.4, sliceDt = 1 / 30) {
    const position = this.ball.position.clone();
    const velocity = this.ball.velocity.clone();
    const slices = [];
    for (let time = sliceDt; time <= horizon + 1e-9; time += sliceDt) {
      velocity.y -= 13 * sliceDt;
      position.x += velocity.x * sliceDt;
      position.y += velocity.y * sliceDt;
      position.z += velocity.z * sliceDt;
      if (position.y < FIELD.ballRadius) {
        position.y = FIELD.ballRadius;
        velocity.y = Math.abs(velocity.y) * 0.71;
      }
      const zLimit = FIELD.halfZ - FIELD.ballRadius;
      if (Math.abs(position.z) > zLimit) {
        position.z = Math.sign(position.z) * zLimit;
        velocity.z *= -0.71;
      }
      const inGoal = Math.abs(position.z) < FIELD.goalHalf && position.y < FIELD.goalHeight;
      const xLimit = FIELD.halfX - FIELD.ballRadius;
      if (!inGoal && Math.abs(position.x) > xLimit) {
        position.x = Math.sign(position.x) * xLimit;
        velocity.x *= -0.71;
      }
      const line = FIELD.halfX + FIELD.ballRadius;
      const goalTeam = inGoal && position.x > line ? 0 : inGoal && position.x < -line ? 1 : null;
      slices.push({
        time,
        position: { x: position.x, y: position.y, z: position.z },
        velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
        goalTeam
      });
      if (goalTeam !== null) break;
    }
    return slices;
  }

  #novaWfInput(player, dt) {
    const attack = player.team === 0 ? 1 : -1;
    const forward = player.body.quaternion.vmult(new Vec3(1, 0, 0));
    const car = {
      position: player.body.position,
      velocity: player.body.velocity,
      yaw: Math.atan2(-forward.z, forward.x),
      boost: player.boost
    };
    const activeAction = this.#updateNovaWfAction(player, dt, player.aiTarget);
    if (activeAction) return activeAction;

    player.aiPredictionTimer -= dt;
    if (!player.aiPrediction || player.aiPredictionTimer <= 0) {
      player.aiPrediction = this.#predictBotTrajectory(2.4, 1 / 30);
      player.aiPredictionTimer = 0.25;
    }
    const trajectory = player.aiPrediction;
    const opponentGoal = { x: attack * (FIELD.halfX + FIELD.goalDepth), y: 1.2, z: 0 };
    const ownGoal = { x: -attack * FIELD.halfX, y: 0.7, z: 0 };
    const intercept = findReachableIntercept({ car, trajectory, target: opponentGoal, field: FIELD, parameters: player.novaWfParameters });
    const selectedBall = intercept?.ballPosition || { x: this.ball.position.x, y: this.ball.position.y, z: this.ball.position.z };

    let opponentArrival = Infinity;
    for (const opponent of this.players.values()) {
      if (opponent.team === player.team) continue;
      const opponentForward = opponent.body.quaternion.vmult(new Vec3(1, 0, 0));
      const opponentCar = {
        position: opponent.body.position,
        velocity: opponent.body.velocity,
        yaw: Math.atan2(-opponentForward.z, opponentForward.x),
        boost: opponent.boost
      };
      const opponentTarget = { x: -attack * (FIELD.halfX + FIELD.goalDepth), y: 1.2, z: 0 };
      const opponentIntercept = findReachableIntercept({ car: opponentCar, trajectory, target: opponentTarget, field: FIELD, parameters: player.novaWfParameters });
      opponentArrival = Math.min(opponentArrival, opponentIntercept?.time ?? Infinity);
    }

    const selfArrival = intercept?.time ?? Infinity;
    const cleanShot = attack * (opponentGoal.x - selectedBall.x) > 0 && Math.abs(selectedBall.z) < FIELD.goalHalf * 1.6;
    const laterTrajectory = trajectory.filter(slice => slice.time > (intercept?.time ?? 0) + 0.3);
    const laterIntercept = findReachableIntercept({ car, trajectory: laterTrajectory, target: opponentGoal, field: FIELD, parameters: player.novaWfParameters });
    const laterCleanShot = Boolean(laterIntercept && Math.abs(laterIntercept.ballPosition.z) < FIELD.goalHalf * 1.35);
    const ballSpeed = Math.hypot(this.ball.velocity.x, this.ball.velocity.z);
    if (ballSpeed > 2 || Math.hypot(this.ball.position.x, this.ball.position.z) > 7) player.aiKickoffActive = false;
    const kickoff = player.aiKickoffActive && Math.hypot(this.ball.position.x, this.ball.position.z) < 7;
    const nearWall = (
      Math.abs(selectedBall.z) > FIELD.halfZ - FIELD.curveRadius ||
      Math.abs(selectedBall.x) > FIELD.halfX - FIELD.cornerRadius
    ) && Math.hypot(selectedBall.x - player.body.position.x, selectedBall.z - player.body.position.z) < 16;
    const safeBoostRoute = attack * this.ball.position.x > FIELD.halfX * 0.2 && this.boostPads.some(pad => pad.active && Math.hypot(pad.x - player.body.position.x, pad.z - player.body.position.z) < 24);

    const validStates = new Set(['kickoff', 'boost-route', 'wall-hit', 'patient-shot', 'clear', 'return', 'shadow', 'fallback']);
    if (player.aiCommitTimer <= 0 || !validStates.has(player.aiState)) {
      player.aiState = chooseNovaWfState({
        kickoff,
        attack,
        field: FIELD,
        ball: { position: this.ball.position, velocity: this.ball.velocity },
        selfArrival,
        opponentArrival,
        cleanShot,
        laterCleanShot,
        boost: player.boost,
        safeBoostRoute,
        nearWall,
        parameters: player.novaWfParameters
      });
      player.aiStateSince = this.elapsed;
      player.aiCommitTimer = ['clear', 'kickoff', 'return'].includes(player.aiState)
        ? player.novaWfParameters.urgentCommitSeconds
        : player.novaWfParameters.stateCommitSeconds;
    }

    let target;
    let chosenIntercept = intercept;
    if (player.aiState === 'shadow') target = shadowTarget(selectedBall, attack, FIELD, player.novaWfParameters);
    else if (player.aiState === 'return') target = { x: ownGoal.x + attack * 5, y: 0.7, z: clamp(selectedBall.z * 0.35, -FIELD.goalHalf, FIELD.goalHalf) };
    else if (player.aiState === 'boost-route') {
      const pad = this.boostPads.filter(candidate => candidate.active).sort((a, b) =>
        (a.x - player.body.position.x) ** 2 + (a.z - player.body.position.z) ** 2 -
        ((b.x - player.body.position.x) ** 2 + (b.z - player.body.position.z) ** 2)
      )[0];
      target = pad ? { x: pad.x, y: 0.7, z: pad.z } : attackingContact(selectedBall, opponentGoal, FIELD, player.novaWfParameters);
    } else {
      if (player.aiState === 'patient-shot' && laterIntercept) chosenIntercept = laterIntercept;
      target = attackingContact(chosenIntercept?.ballPosition || selectedBall, opponentGoal, FIELD, player.novaWfParameters);
    }

    player.aiTarget.set(target.x, target.y ?? 0.7, target.z);
    player.aiInterceptTime = chosenIntercept?.time ?? 0;
    const ballDx = this.ball.position.x - player.body.position.x;
    const ballDz = this.ball.position.z - player.body.position.z;
    const distanceToBall = Math.hypot(ballDx, ballDz);
    const facingBall = distanceToBall > 0 && (forward.x * ballDx + forward.z * ballDz) / distanceToBall > 0.72;
    const shotDx = opponentGoal.x - this.ball.position.x;
    const shotDz = opponentGoal.z - this.ball.position.z;
    const behindBallForShot = ballDx * shotDx + ballDz * shotDz > 0;
    if (distanceToBall < 3.3 && facingBall && behindBallForShot && this.ball.position.y < 2.8 && player.aiJumpCooldown <= 0 && ['kickoff', 'clear', 'fallback'].includes(player.aiState)) {
      player.aiAction = { type: 'smart-dodge', elapsed: 0 };
      const actionInput = this.#updateNovaWfAction(player, dt, player.aiTarget);
      if (actionInput) return actionInput;
      const fallbackInput = driveToTarget(car, target, { urgent: true, parameters: player.novaWfParameters });
      return { ...fallbackInput, steer: -fallbackInput.steer };
    }
    const jump = Boolean(chosenIntercept && chosenIntercept.time < 0.32 && chosenIntercept.ballPosition.y > 1.7 && player.aiJumpCooldown <= 0);
    const input = driveToTarget(car, target, { urgent: ['kickoff', 'clear'].includes(player.aiState), jump, parameters: player.novaWfParameters });
    if (player.aiState === 'boost-route') input.boost = false;
    return { ...input, steer: -input.steer };
  }

  #updateBoostPads(dt) {
    for (const pad of this.boostPads) {
      if (!pad.active) {
        pad.timer -= dt;
        if (pad.timer <= 0) { pad.active = true; pad.timer = 0; }
        continue;
      }
      for (const player of this.players.values()) {
        const position = player.body.position;
        if (position.y < 1.2 && Math.hypot(position.x - pad.x, position.z - pad.z) < pad.radius) {
          player.controller.boost = Math.min(100, player.controller.boost + pad.amount);
          player.boost = player.controller.boost;
          pad.active = false;
          pad.timer = pad.recharge;
          break;
        }
      }
    }
  }

  #updateDuelAntiDeadlock(dt) {
    if (this.mode !== 'duel' || this.status !== 'playing') {
      this.duelStallTime = 0;
      return;
    }
    const velocity = this.ballRigidBody.linvel();
    const planarSpeed = Math.hypot(velocity.x, velocity.z);
    const ballX = this.ballRigidBody.translation().x;
    if (Math.abs(ballX - this.duelProgressAnchorX) >= 4) {
      this.duelProgressAnchorX = ballX;
      this.duelCollectiveStallTime = 0;
    } else this.duelCollectiveStallTime += dt;
    if (this.duelCollectiveStallTime >= 12) {
      this.events.push({ type: 'duelReset', reason: 'no-goal-axis-progress' });
      this.#kickoff();
      return;
    }
    this.duelStallTime = planarSpeed < 0.8
      ? this.duelStallTime + dt
      : Math.max(0, this.duelStallTime - dt * 2);
    if (this.duelStallTime < 3) return;
    const index = this.duelNudgeIndex++;
    const xDirection = index % 2 === 0 ? 1 : -1;
    const zDirection = Math.floor(index / 2) % 2 === 0 ? 1 : -1;
    this.ballRigidBody.setLinvel({ x: xDirection * 7, y: 2.5, z: zDirection * 3 }, true);
    this.ballRigidBody.setAngvel({ x: zDirection * 2, y: xDirection * 1.5, z: 0 }, true);
    this.duelStallTime = 0;
    this.events.push({ type: 'duelNudge', index, velocity: [xDirection * 7, 2.5, zDirection * 3] });
  }

  #physicsTick() {
    const active = this.status === 'playing';
    for (const player of this.players.values()) {
      if (player.isBot && active) player.input = this.#botInput(player, DT);
      player.controller.setInput(active ? player.input : blankInput());
      player.controller.preStep(DT);
    }
    this.world.step();
    for (const player of this.players.values()) {
      player.controller.postStep();
      player.boost = player.controller.boost;
      player.boosting = player.controller.boosting;
    }
    this.#updateBoostPads(DT);
    this.#updateDuelAntiDeadlock(DT);
  }

  step(dt = DT) {
    dt = clamp(dt, 0, 1 / 20);
    this.elapsed += dt;
    if (this.status === 'countdown') {
      this.countdownClock -= dt;
      while (this.countdownClock <= 0 && this.status === 'countdown') {
        this.countdown--;
        this.countdownClock += 1;
        if (this.countdown <= 0) { this.status = 'playing'; this.events.push({ type: 'go' }); }
        else this.events.push({ type: 'countdown', value: this.countdown });
      }
    } else if (this.status === 'goal') {
      this.goalClock -= dt;
      if (this.goalClock <= 0) this.#kickoff();
    } else if (this.status === 'finished') return;

    this.accumulator += dt;
    let substeps = 0;
    while (this.accumulator + 1e-10 >= DT && substeps < 8) {
      this.#physicsTick();
      this.accumulator -= DT;
      substeps++;
    }
    if (substeps === 8 && this.accumulator >= DT) this.accumulator = 0;

    const ball = this.ball.position;
    const inGoal = Math.abs(ball.z) < FIELD.goalHalf && ball.y < FIELD.goalHeight;
    const crossedGoalLine = FIELD.halfX + FIELD.ballRadius;
    if (inGoal && ball.x > crossedGoalLine) this.#goal(0);
    else if (inGoal && ball.x < -crossedGoalLine) this.#goal(1);
    if (ball.y < -1 || Math.abs(ball.z) > FIELD.halfZ + 2 || Math.abs(ball.x) > FIELD.halfX + FIELD.goalDepth + 2) {
      this.ball.position.set(0, 3, 0);
      this.ball.velocity.setZero();
      this.ball.angularVelocity.setZero();
    }
  }

  predictBallTrajectory({ horizon = 4, sliceDt = 1 / 60, physicsDt = DT } = {}) {
    if (!(horizon > 0) || !(sliceDt > 0) || !(physicsDt > 0)) throw new RangeError('prediction intervals must be positive');
    const substeps = Math.round(sliceDt / physicsDt);
    if (substeps < 1 || Math.abs(substeps * physicsDt - sliceDt) > 1e-10) throw new RangeError('sliceDt must be an integer multiple of physicsDt');
    const world = new RAPIER.World({ x: 0, y: -13, z: 0 });
    world.timestep = physicsDt;
    buildRapierArena(world);
    const sourcePosition = this.ball.position, sourceVelocity = this.ball.velocity, sourceAngular = this.ball.angularVelocity;
    const rigidBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(sourcePosition.x, sourcePosition.y, sourcePosition.z)
        .setLinvel(sourceVelocity.x, sourceVelocity.y, sourceVelocity.z)
        .setAngvel(sourceAngular.x, sourceAngular.y, sourceAngular.z)
        .setLinearDamping(0.018)
        .setAngularDamping(0.025)
        .setCanSleep(false)
        .setCcdEnabled(true)
    );
    world.createCollider(RAPIER.ColliderDesc.ball(FIELD.ballRadius).setMass(28).setFriction(0.22).setRestitution(0.71), rigidBody);
    const slices = [];
    const count = Math.floor(horizon / sliceDt + 1e-9);
    for (let index = 0; index < count; index++) {
      for (let tick = 0; tick < substeps; tick++) world.step();
      const position = rigidBody.translation(), velocity = rigidBody.linvel(), angularVelocity = rigidBody.angvel();
      const inGoal = Math.abs(position.z) < FIELD.goalHalf && position.y < FIELD.goalHeight;
      const line = FIELD.halfX + FIELD.ballRadius;
      const goalTeam = inGoal && position.x > line ? 0 : inGoal && position.x < -line ? 1 : null;
      slices.push({
        time: (index + 1) * sliceDt,
        position: { ...position }, velocity: { ...velocity }, angularVelocity: { ...angularVelocity }, goalTeam
      });
      if (goalTeam !== null) break;
    }
    world.free();
    return slices;
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  snapshot() {
    const bodyState = body => ({
      p: [body.position.x, body.position.y, body.position.z],
      q: [body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w],
      v: [body.velocity.x, body.velocity.y, body.velocity.z]
    });
    return {
      mode: this.mode,
      status: this.status,
      countdown: this.countdown,
      score: [...this.score],
      winner: this.winner,
      physics: { engine: ENGINE_CONTRACT.id, version: ENGINE_CONTRACT.version, tickRate: ENGINE_CONTRACT.tickRate, arena: RAPIER_ARENA_VERSION, contract: CAR_SOCCER_VERSION },
      ball: bodyState(this.ball),
      boostPads: this.boostPads.map(pad => ({ id: pad.id, x: pad.x, z: pad.z, amount: pad.amount, active: pad.active, timer: pad.timer })),
      players: [...this.players.values()].map(player => {
        const telemetry = player.controller.telemetry();
        return {
          id: player.id, name: player.name, team: player.team, isBot: player.isBot,
          boost: player.boost, boosting: player.boosting,
          wheelContacts: telemetry.contacts,
          suspensionLengths: Array.from({ length: player.controller.vehicle.numWheels() }, (_, index) => player.controller.vehicle.wheelSuspensionLength(index)),
          ...(player.isBot ? { ai: { version: player.aiVersion, controllerId: player.controllerId, state: player.aiState, action: player.aiAction?.type || null, commitTime: player.aiCommitTimer, stateSince: player.aiStateSince, target: [player.aiTarget.x, player.aiTarget.y, player.aiTarget.z], interceptTime: player.aiInterceptTime } } : {}),
          ...bodyState(player.body)
        };
      })
    };
  }

  free() {
    this.world.free();
  }
}

export function blankInput() {
  return { throttle: 0, steer: 0, brake: 0, boost: false, jump: false, airRoll: 0, handbrake: false };
}

export function sanitizeInput(input = {}) {
  return {
    throttle: clamp(Number(input.throttle) || 0, -1, 1),
    steer: clamp(Number(input.steer) || 0, -1, 1),
    brake: clamp(Number(input.brake) || 0, 0, 1),
    boost: Boolean(input.boost),
    jump: Boolean(input.jump),
    airRoll: clamp(Number(input.airRoll) || 0, -1, 1),
    handbrake: Boolean(input.handbrake)
  };
}

export { Vec3, Quaternion };
