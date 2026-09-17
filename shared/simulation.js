import * as CANNON from 'cannon-es';
import { attackingContact, chooseNovaWfState, driveToTarget, findReachableIntercept, normalizeNovaWfParameters, shadowTarget } from './nova-wf.js';
import { ARENA_VERSION, CAR, FIELD, arenaCurveProfile, curveHeight } from './arena-geometry.js';

export { ARENA_VERSION, CAR, FIELD };
export const BOOST_PAD_LAYOUT = (() => {
  const pads = [];
  const add = (x, z, amount = 12) => pads.push({ id: `P${pads.length}`, x, z, amount, radius: amount === 100 ? 2.8 : 2.15, recharge: amount === 100 ? 10 : 4 });
  for (const [x, z] of [[-96, 0], [96, 0], [-74, -54], [-74, 54], [74, -54], [74, 54]]) add(x, z, 100);
  for (const z of [-28, 28]) for (const x of [-90, -60, -30, 0, 30, 60, 90]) add(x, z);
  for (const x of [-60, -20, 20, 60]) add(x, 0);
  for (const z of [-54, 54]) for (const x of [-34, 0, 34]) add(x, z);
  return pads;
})();
const DT = 1 / 60;
const COLLISION = { car: 1, ball: 2, arena: 4, curve: 8 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

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
    this.kickoffScenarios = [];
    this.elapsed = 0;
    this.duelKickoffIndex = 0;
    this.duelStallTime = 0;
    this.duelCollectiveStallTime = 0;
    this.duelNudgeIndex = 0;
    this.boostPads = BOOST_PAD_LAYOUT.map(pad => ({ ...pad, active: true, timer: 0 }));
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -18, 0) });
    this.world.allowSleep = false;
    this.world.solver.iterations = 14;
    this.world.defaultContactMaterial.friction = 0.35;
    this.world.defaultContactMaterial.restitution = 0.1;
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.carMaterial = new CANNON.Material('car');
    this.ballMaterial = new CANNON.Material('ball');
    this.arenaMaterial = new CANNON.Material('arena');
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.ballMaterial, this.arenaMaterial, { friction: 0.22, restitution: 0.71 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.ballMaterial, this.carMaterial, { friction: 0.18, restitution: 0.7 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.carMaterial, this.carMaterial, { friction: 0.12, restitution: 0.24 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.carMaterial, this.arenaMaterial, { friction: 0, restitution: 0 }));
    this.#buildArena();
    this.ball = new CANNON.Body({ mass: 28, material: this.ballMaterial, linearDamping: 0.018, angularDamping: 0.025, collisionFilterGroup: COLLISION.ball, collisionFilterMask: COLLISION.car | COLLISION.arena | COLLISION.curve });
    this.ball.addShape(new CANNON.Sphere(FIELD.ballRadius));
    this.ball.position.set(0, FIELD.ballRadius + 0.05, 0);
    this.world.addBody(this.ball);
  }

  predictBallTrajectory({ horizon = 4, sliceDt = 1 / 60, physicsDt = 1 / 120 } = {}) {
    if (!(horizon > 0) || !(sliceDt > 0) || !(physicsDt > 0)) throw new RangeError('prediction intervals must be positive');
    const substeps = Math.round(sliceDt / physicsDt);
    if (substeps < 1 || Math.abs(substeps * physicsDt - sliceDt) > 1e-12) throw new RangeError('sliceDt must be an integer multiple of physicsDt');
    if (!this.predictionSimulation) this.predictionSimulation = new GameSimulation({ mode: 'multi', random: () => 0 });
    const prediction = this.predictionSimulation;
    prediction.ball.position.copy(this.ball.position);
    prediction.ball.quaternion.copy(this.ball.quaternion);
    prediction.ball.velocity.copy(this.ball.velocity);
    prediction.ball.angularVelocity.copy(this.ball.angularVelocity);
    prediction.ball.force.setZero();
    prediction.ball.torque.setZero();
    prediction.ball.aabbNeedsUpdate = true;
    prediction.world.broadphase.dirty = true;
    prediction.world.time = 0;
    prediction.world.stepnumber = 0;

    const slices = [];
    const count = Math.floor(horizon / sliceDt + 1e-9);
    for (let index = 0; index < count; index++) {
      for (let step = 0; step < substeps; step++) prediction.world.step(physicsDt);
      const position = { x: prediction.ball.position.x, y: prediction.ball.position.y, z: prediction.ball.position.z };
      const velocity = { x: prediction.ball.velocity.x, y: prediction.ball.velocity.y, z: prediction.ball.velocity.z };
      const angularVelocity = { x: prediction.ball.angularVelocity.x, y: prediction.ball.angularVelocity.y, z: prediction.ball.angularVelocity.z };
      const inGoal = Math.abs(position.z) < FIELD.goalHalf && position.y < FIELD.goalHeight;
      const crossedGoalLine = FIELD.halfX + FIELD.ballRadius;
      const goalTeam = inGoal && position.x > crossedGoalLine ? 0 : inGoal && position.x < -crossedGoalLine ? 1 : null;
      slices.push({ time: (index + 1) * sliceDt, position, velocity, angularVelocity, goalTeam });
      if (goalTeam !== null) break;
    }
    return slices;
  }

  #staticBox(x, y, z, hx, hy, hz, rx = 0, ry = 0, rz = 0) {
    const b = new CANNON.Body({ mass: 0, material: this.arenaMaterial, collisionFilterGroup: COLLISION.arena, collisionFilterMask: COLLISION.car | COLLISION.ball });
    b.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)));
    b.position.set(x, y, z);
    b.quaternion.setFromEuler(rx, ry, rz, 'XYZ');
    this.world.addBody(b);
    return b;
  }

  #staticCurveBox(...args) {
    const body = this.#staticBox(...args);
    body.collisionFilterGroup = COLLISION.curve;
    body.collisionFilterMask = COLLISION.ball;
    return body;
  }

  #staticHeightfield(xMin, xMax, zMin, zMax, elementSize, heightAt, topY = null) {
    const columns = Math.round((xMax - xMin) / elementSize);
    const rows = Math.round((zMax - zMin) / elementSize);
    const data = [];
    for (let i = 0; i <= columns; i++) {
      const column = [];
      const x = xMin + i * elementSize;
      for (let j = 0; j <= rows; j++) {
        const z = topY === null ? zMax - j * elementSize : zMin + j * elementSize;
        column.push(heightAt(x, z));
      }
      data.push(column);
    }
    const body = new CANNON.Body({ mass: 0, material: this.arenaMaterial, collisionFilterGroup: COLLISION.curve, collisionFilterMask: COLLISION.ball });
    body.addShape(new CANNON.Heightfield(data, { elementSize }));
    body.position.set(xMin, topY ?? 0, topY === null ? zMax : zMin);
    body.quaternion.setFromEuler(topY === null ? -Math.PI / 2 : Math.PI / 2, 0, 0, 'XYZ');
    this.world.addBody(body);
    return body;
  }

  #buildArena() {
    const { halfX, halfZ, goalHalf, goalHeight, goalDepth, ceilingY, curveRadius, cornerRadius } = FIELD;
    const verticalHalfHeight = Math.max(0.5, (ceilingY - 2 * curveRadius) / 2);
    const verticalCenterY = curveRadius + verticalHalfHeight;
    const straightHalfX = halfX - cornerRadius;
    const flankHalf = (halfZ - cornerRadius - goalHalf) / 2;

    // Closed shell: floor, roof, straight side walls and goal-side end walls.
    const shellMargin = goalDepth + 2;
    this.#staticBox(0, -0.5, 0, halfX + shellMargin, 0.5, halfZ + shellMargin);
    this.#staticBox(0, ceilingY + 0.5, 0, halfX + shellMargin, 0.5, halfZ + shellMargin);
    for (const sideZ of [-1, 1]) this.#staticCurveBox(0, verticalCenterY, sideZ * (halfZ + 0.5), straightHalfX, verticalHalfHeight, 0.5);

    for (const sideX of [-1, 1]) {
      const x = sideX * (halfX + 0.5);
      for (const sideZ of [-1, 1]) {
        const z = sideZ * (goalHalf + flankHalf);
        this.#staticCurveBox(x, verticalCenterY, z, 0.5, verticalHalfHeight, flankHalf);
      }
      const upperHalf = (ceilingY - goalHeight) / 2;
      this.#staticBox(x, goalHeight + upperHalf, 0, 0.5, upperHalf, goalHalf);

      // Fully enclosed goal box.
      const back = sideX * (halfX + goalDepth);
      this.#staticBox(back, goalHeight / 2, 0, 0.35, goalHeight / 2, goalHalf + 0.5);
      this.#staticBox(sideX * (halfX + goalDepth / 2), goalHeight / 2, goalHalf + 0.35, goalDepth / 2, goalHeight / 2, 0.35);
      this.#staticBox(sideX * (halfX + goalDepth / 2), goalHeight / 2, -goalHalf - 0.35, goalDepth / 2, goalHeight / 2, 0.35);
      this.#staticBox(sideX * (halfX + goalDepth / 2), goalHeight + 0.3, 0, goalDepth / 2, 0.3, goalHalf + 0.7);
    }

    // Continuous quarter-pipes. Heightfields share vertices at every grid edge, so there are no
    // overlapping lips or gaps for a wheel/chassis corner to catch on.
    const grid = 0.5;
    const cornerX = halfX - cornerRadius, cornerZ = halfZ - cornerRadius;
    const innerGoal = Math.floor(goalHalf / grid) * grid;

    for (const sideZ of [-1, 1]) {
      const zMin = sideZ > 0 ? halfZ - curveRadius : -halfZ;
      const zMax = sideZ > 0 ? halfZ : -halfZ + curveRadius;
      const heightAt = (_x, z) => curveHeight(Math.abs(z) - (halfZ - curveRadius));
      this.#staticHeightfield(-cornerX, cornerX, zMin, zMax, grid, heightAt);
      this.#staticHeightfield(-cornerX, cornerX, zMin, zMax, grid, heightAt, ceilingY);
    }

    for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) {
      const xMin = sideX > 0 ? halfX - curveRadius : -halfX;
      const xMax = sideX > 0 ? halfX : -halfX + curveRadius;
      const zMin = sideZ > 0 ? innerGoal : -cornerZ;
      const zMax = sideZ > 0 ? cornerZ : -innerGoal;
      const heightAt = x => curveHeight(Math.abs(x) - (halfX - curveRadius));
      this.#staticHeightfield(xMin, xMax, zMin, zMax, grid, heightAt);
      this.#staticHeightfield(xMin, xMax, zMin, zMax, grid, heightAt, ceilingY);
    }

    // Toroidal floor/ceiling patches make each corner a true double curve rather than crossing ramps.
    for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) {
      const xMin = sideX > 0 ? cornerX : -halfX;
      const xMax = sideX > 0 ? halfX : -cornerX;
      const zMin = sideZ > 0 ? cornerZ : -halfZ;
      const zMax = sideZ > 0 ? halfZ : -cornerZ;
      const heightAt = (x, z) => {
        const radius = Math.hypot(x - sideX * cornerX, z - sideZ * cornerZ);
        return curveHeight(radius - (cornerRadius - curveRadius));
      };
      this.#staticHeightfield(xMin, xMax, zMin, zMax, grid, heightAt);
      this.#staticHeightfield(xMin, xMax, zMin, zMax, grid, heightAt, ceilingY);
    }

    // Thin tangent panels sit wholly outside the playable arc. Their inner faces meet without
    // overlap, avoiding the protruding ridges produced by the old centered boxes.
    const cornerSegments = 24;
    const delta = (Math.PI / 2) / cornerSegments;
    const cornerArcHalf = cornerRadius * Math.sin(delta / 2) * 1.015;
    const wallThickness = 0.36;
    for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) {
      for (let i = 0; i < cornerSegments; i++) {
        const phi = (i + 0.5) * delta;
        const radius = cornerRadius + wallThickness;
        const x = sideX * (cornerX + radius * Math.cos(phi));
        const z = sideZ * (cornerZ + radius * Math.sin(phi));
        const dx = -sideX * Math.sin(phi), dz = sideZ * Math.cos(phi);
        const yaw = Math.atan2(-dz, dx);
        this.#staticCurveBox(x, verticalCenterY, z, cornerArcHalf, verticalHalfHeight, wallThickness, 0, yaw, 0);
      }
    }
  }

  addPlayer({ id, name = 'Pilote', team = 0, isBot = false, aiVersion = 2, controllerId = aiVersion, aiParameters = null }) {
    const body = new CANNON.Body({ mass: 145, material: this.carMaterial, linearDamping: 0.055, angularDamping: 0.2, collisionFilterGroup: COLLISION.car, collisionFilterMask: COLLISION.car | COLLISION.ball | COLLISION.arena });
    body.addShape(new CANNON.Box(new CANNON.Vec3(CAR.chassisHalf.x, CAR.chassisHalf.y, CAR.chassisHalf.z)));
    body.addShape(
      new CANNON.Box(new CANNON.Vec3(CAR.bumperHalf.x, CAR.bumperHalf.y, CAR.bumperHalf.z)),
      new CANNON.Vec3(CAR.bumperOffset.x, CAR.bumperOffset.y, CAR.bumperOffset.z)
    );
    body.allowSleep = false;
    this.world.addBody(body);
    const p = { id, name, team, isBot, aiVersion, controllerId, novaWfParameters: aiVersion === 3 && aiParameters ? normalizeNovaWfParameters(aiParameters) : this.novaWfParameters, body, boost: 33, boosting: false, input: blankInput(), jumpHeld: false, jumpSustain: 0, jumpBoosted: false, jumpNormal: new CANNON.Vec3(0, 1, 0), airJumps: 1, heading: team === 0 ? 0 : Math.PI, recoveryTimer: 0, airTime: 0, aiState: isBot ? 'kickoff' : null, aiTarget: new CANNON.Vec3(), aiInterceptTime: 0, aiJumpCooldown: 0, aiJumpHold: 0, aiCommitTimer: 0, aiStateSince: 0, aiAction: null, aiPrediction: null, aiPredictionTimer: 0, aiKickoffActive: true };
    this.players.set(id, p);
    this.#spawnCar(p);
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.world.removeBody(p.body);
    this.players.delete(id);
    if (this.mode === 'multi') this.status = 'waiting';
  }

  start() {
    this.score = [0, 0];
    this.winner = null;
    this.#kickoff();
  }

  setInput(id, input = {}) {
    const p = this.players.get(id);
    if (!p || p.isBot) return;
    p.input = sanitizeInput(input);
  }

  #spawnCar(p) {
    const side = p.team === 0 ? -1 : 1;
    p.body.position.set(side * 24, CAR.restY + 0.1, p.team === 0 ? -3.2 : 3.2);
    p.body.velocity.setZero();
    p.body.angularVelocity.setZero();
    p.heading = p.team === 0 ? 0 : Math.PI;
    p.body.quaternion.setFromEuler(0, p.heading, 0, 'XYZ');
    p.boost = 33;
    p.boosting = false;
    p.airJumps = 1;
    p.jumpHeld = false;
    p.jumpSustain = 0;
    p.jumpBoosted = false;
    p.jumpNormal.set(0, 1, 0);
    p.recoveryTimer = 0;
    p.airTime = 0;
    p.aiCommitTimer = 0;
    p.aiStateSince = 0;
    p.aiAction = null;
    p.aiPrediction = null;
    p.aiPredictionTimer = 0;
    p.aiKickoffActive = true;
  }

  #kickoff() {
    const kickoffZ = this.evaluationKickoffVariation
      ? (this.kickoffRandom() * 2 - 1) * 8
      : this.mode === 'duel' ? (this.duelKickoffIndex++ % 2 === 0 ? -4 : 4) : 0;
    this.ball.position.set(0, FIELD.ballRadius + 0.05, kickoffZ);
    if (this.evaluationKickoffVariation) this.kickoffScenarios.push({ index: this.kickoffScenarios.length, ballZ: kickoffZ });
    this.ball.velocity.setZero();
    this.ball.angularVelocity.setZero();
    this.duelStallTime = 0;
    this.duelCollectiveStallTime = 0;
    for (const p of this.players.values()) this.#spawnCar(p);
    for (const pad of this.boostPads) { pad.active = true; pad.timer = 0; }
    this.status = 'countdown';
    this.countdown = 3;
    this.countdownClock = 1;
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

  #curveProfile(position) {
    const profile = arenaCurveProfile(position);
    if (!profile) return null;
    return { distance: profile.distance, outward: new CANNON.Vec3(profile.outward.x, profile.outward.y, profile.outward.z) };
  }

  #drivingSurface(p, requireAlignment = true) {
    const b = p.body, profile = this.#curveProfile(b.position);
    const clearance = CAR.curveClearance, targetRadius = FIELD.curveRadius - clearance;
    let contact = null;
    if (profile && profile.distance > -0.4) {
      const qh = profile.distance;
      const bottomY = b.position.y - FIELD.curveRadius;
      if (b.position.y <= FIELD.curveRadius + 0.4) {
        const length = Math.hypot(bottomY, qh) || 1;
        const gap = targetRadius - length;
        if (gap < 0.85 && bottomY < 0.4) contact = {
          normal: new CANNON.Vec3(-profile.outward.x * qh / length, -bottomY / length, -profile.outward.z * qh / length),
          penetration: Math.max(0, -gap)
        };
      }
      const topCenter = FIELD.ceilingY - FIELD.curveRadius;
      const topY = b.position.y - topCenter;
      if (!contact && b.position.y >= topCenter - 0.4) {
        const length = Math.hypot(topY, qh) || 1;
        const gap = targetRadius - length;
        if (gap < 0.85 && topY > -0.4) contact = {
          normal: new CANNON.Vec3(-profile.outward.x * qh / length, -topY / length, -profile.outward.z * qh / length),
          penetration: Math.max(0, -gap)
        };
      }
      if (!contact && qh > targetRadius - 0.85 && b.position.y > FIELD.curveRadius - 0.5 && b.position.y < topCenter + 0.5) contact = {
        normal: profile.outward.scale(-1),
        penetration: Math.max(0, qh - targetRadius)
      };
    }
    if (!contact && b.position.y < 0.98) contact = { normal: new CANNON.Vec3(0, 1, 0), penetration: 0 };
    if (!contact) return null;
    if (requireAlignment) {
      const carUp = b.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
      if (carUp.dot(contact.normal) < 0.9 || b.velocity.dot(contact.normal) < -4) return null;
    }
    return contact;
  }

  #resolveCurveContact(p) {
    const contact = this.#drivingSurface(p, false);
    if (!contact || contact.penetration <= 0) return;
    const correction = contact.normal.scale(contact.penetration + 0.002);
    p.body.position.vadd(correction, p.body.position);
    p.body.aabbNeedsUpdate = true;
    const inwardSpeed = p.body.velocity.dot(contact.normal);
    if (inwardSpeed < 0) p.body.velocity.vsub(contact.normal.scale(inwardSpeed), p.body.velocity);
  }

  #isGrounded(p) {
    return this.#drivingSurface(p) !== null;
  }

  #orientationOnSurface(surfaceUp, desiredForward) {
    const forward = desiredForward.clone();
    forward.vsub(surfaceUp.scale(forward.dot(surfaceUp)), forward);
    if (forward.lengthSquared() < 0.001) forward.set(1, 0, 0);
    forward.normalize();
    const alignUp = new CANNON.Quaternion();
    alignUp.setFromVectors(new CANNON.Vec3(0, 1, 0), surfaceUp);
    const baseForward = alignUp.vmult(new CANNON.Vec3(1, 0, 0));
    const cross = baseForward.cross(forward);
    const angle = Math.atan2(surfaceUp.dot(cross), clamp(baseForward.dot(forward), -1, 1));
    const twist = new CANNON.Quaternion(); twist.setFromAxisAngle(surfaceUp, angle);
    return twist.mult(alignUp);
  }

  #applySelfRighting(p, dt) {
    const b = p.body;
    const up = b.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
    let horizontalSpeed = Math.hypot(b.velocity.x, b.velocity.z);
    const nearWall = this.#curveProfile(b.position) !== null;
    const scraping = !nearWall && b.position.y < 1.25 && Math.abs(b.velocity.y) < 5 && up.y < 0.75;
    if (scraping && horizontalSpeed > 0.001) {
      const scrapeFactor = clamp((0.82 - up.y) / 0.82, 0.35, 1);
      const nextSpeed = Math.max(0, horizontalSpeed - 16 * scrapeFactor * dt);
      const scale = nextSpeed / horizontalSpeed;
      b.velocity.x *= scale;
      b.velocity.z *= scale;
      horizontalSpeed = nextSpeed;
    }
    const recoverable = !nearWall && b.position.y < 1.75 && Math.abs(b.velocity.y) < 3.5 && horizontalSpeed < 18 && up.y < 0.92;
    p.recoveryTimer = recoverable ? p.recoveryTimer + dt : Math.max(0, p.recoveryTimer - dt * 2);
    const roundedRoofContact = up.y < -0.35;
    const vansRecovery = recoverable && up.y < 0.75;
    const activationDelay = roundedRoofContact ? 0.22 : 0.6;
    if (p.recoveryTimer < activationDelay) return vansRecovery;

    const worldUp = new CANNON.Vec3(0, 1, 0);
    let axis = up.cross(worldUp);
    if (axis.lengthSquared() < 0.025) {
      // At exactly 180 degrees the cross product is ambiguous: roll around the car's longitudinal axis.
      axis = b.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
      axis.y = 0;
    }
    if (axis.lengthSquared() < 0.001) axis.set(1, 0, 0);
    axis.normalize();
    const stuckBoost = p.recoveryTimer > 1.8 ? 1.25 : 1;
    const tiltError = clamp(1 - up.y, 0, 2);
    const strength = (roundedRoofContact ? 900 + 950 * tiltError : 500 + 650 * tiltError) * stuckBoost;
    b.applyTorque(axis.scale(strength));
    // This virtual support force mimics a convex roof shell against the arena only; it never participates in ball contacts.
    b.force.y += (roundedRoofContact ? 2300 : up.y < 0.2 ? 1850 : 850) * stuckBoost;
    b.angularVelocity.x *= 0.91;
    b.angularVelocity.y *= 0.94;
    b.angularVelocity.z *= 0.91;

    const forward = b.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
    if (forward.x * forward.x + forward.z * forward.z > 0.05) p.heading = Math.atan2(-forward.z, forward.x);
    return vansRecovery;
  }

  #applyAirLeveling(p, dt, grounded) {
    const b = p.body;
    const nearWall = Math.abs(b.position.z) > FIELD.halfZ - FIELD.curveRadius - 2 || Math.abs(b.position.x) > FIELD.halfX - FIELD.curveRadius - 2;
    const freeAir = !grounded && b.position.y > 1.15 && !nearWall;
    p.airTime = freeAir ? p.airTime + dt : 0;
    if (p.airTime < 0.08) return;

    const up = b.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
    if (up.y > 0.995) return;
    let axis = up.cross(new CANNON.Vec3(0, 1, 0));
    if (axis.lengthSquared() < 0.02) axis = b.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
    if (axis.lengthSquared() < 0.001) axis.set(1, 0, 0);
    axis.normalize();
    const manualAerial = Math.abs(p.input.airRoll) > 0.08 || Math.abs(p.input.throttle) > 0.08 || Math.abs(p.input.steer) > 0.08;
    const strength = (manualAerial ? 170 : 1080) * clamp(1 - up.y, 0.12, 2);
    b.applyTorque(axis.scale(strength));
    const damping = manualAerial ? 0.992 : 0.91;
    b.angularVelocity.x *= damping;
    b.angularVelocity.z *= damping;
  }

  #updateCar(p, dt) {
    if (p.isBot) p.input = this.#botInput(p, dt);
    const b = p.body, input = p.input;
    const recovering = this.#applySelfRighting(p, dt);
    const surface = this.#drivingSurface(p);
    const grounded = surface !== null;
    p.boosting = false;
    this.#applyAirLeveling(p, dt, grounded);
    const forward = b.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
    const surfaceUp = surface?.normal ?? new CANNON.Vec3(0, 1, 0);
    const yaw = new CANNON.Quaternion(); yaw.setFromEuler(0, p.heading, 0, 'XYZ');
    const tilt = new CANNON.Quaternion(); tilt.setFromVectors(new CANNON.Vec3(0, 1, 0), surfaceUp);
    const verticalRide = grounded && Math.abs(surfaceUp.y) < 0.35;
    const driveOrientation = verticalRide ? this.#orientationOnSurface(surfaceUp, forward) : tilt.mult(yaw);
    const flatForward = grounded
      ? driveOrientation.vmult(new CANNON.Vec3(1, 0, 0))
      : new CANNON.Vec3(forward.x, 0, forward.z);
    if (flatForward.lengthSquared() > 0.01) flatForward.normalize();
    const right = grounded
      ? driveOrientation.vmult(new CANNON.Vec3(0, 0, 1))
      : b.quaternion.vmult(new CANNON.Vec3(0, 0, 1));
    const speedForward = b.velocity.dot(flatForward);
    const speedSide = b.velocity.dot(right);

    if (grounded) {
      p.airJumps = 1;
      const engine = input.throttle >= 0 ? 2350 : 1550;
      const opposingDrive = Math.abs(input.throttle) > 0.05 && input.throttle * speedForward < -1;
      let force = opposingDrive ? -Math.sign(speedForward) * 10500 : input.throttle * engine;
      if (!opposingDrive && input.boost && p.boost > 0 && input.throttle >= 0) {
        p.boosting = true;
        force += 3000;
        p.boost = Math.max(0, p.boost - 31 * dt);
      }
      b.applyForce(flatForward.scale(force));
      const grip = 1 - Math.exp(-18 * dt);
      b.velocity.x -= right.x * speedSide * grip;
      b.velocity.y -= right.y * speedSide * grip;
      b.velocity.z -= right.z * speedSide * grip;
      const steerStrength = 2.8 * clamp(Math.abs(speedForward) / 8, 0.25, 1);
      const reverse = speedForward < -1 ? -0.72 : 1;
      p.heading = wrap(p.heading - input.steer * steerStrength * reverse * dt);
      b.angularVelocity.x *= 0.2;
      b.angularVelocity.y *= 0.2;
      b.angularVelocity.z *= 0.2;
      const steerYaw = new CANNON.Quaternion(); steerYaw.setFromEuler(0, p.heading, 0, 'XYZ');
      let target;
      if (verticalRide) {
        const wallSteer = new CANNON.Quaternion();
        wallSteer.setFromAxisAngle(surfaceUp, -input.steer * steerStrength * reverse * dt);
        target = this.#orientationOnSurface(surfaceUp, wallSteer.vmult(forward));
      } else target = tilt.mult(steerYaw);
      b.quaternion.slerp(target, 1 - Math.exp(-18 * dt), b.quaternion);
    } else if (!recovering) {
      const localUp = b.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
      const localRight = b.quaternion.vmult(new CANNON.Vec3(0, 0, 1));
      b.applyTorque(localRight.scale(-input.throttle * 1050));
      b.applyTorque(localUp.scale(-input.steer * 820));
      b.applyTorque(forward.scale(-input.airRoll * 980));
      b.angularVelocity.scale(0.992, b.angularVelocity);
      const spin = b.angularVelocity.length();
      if (spin > 4.8) b.angularVelocity.scale(4.8 / spin, b.angularVelocity);
      if (input.boost && p.boost > 0) {
        p.boosting = true;
        b.applyForce(forward.scale(4200));
        p.boost = Math.max(0, p.boost - 33.3 * dt);
      }
    }

    if (input.jump && !p.jumpHeld) {
      if (grounded) {
        b.position.vadd(surface.normal.scale(0.28), b.position);
        const normalSpeed = b.velocity.dot(surface.normal);
        p.jumpBoosted = input.boost && p.boost > 0;
        const takeoffSpeed = p.jumpBoosted ? 9 : 8;
        if (normalSpeed < takeoffSpeed) b.velocity.vadd(surface.normal.scale(takeoffSpeed - normalSpeed), b.velocity);
        p.jumpSustain = 0.22;
        p.jumpNormal.copy(surface.normal);
      } else if (p.airJumps > 0) {
        const dodge = forward.scale(input.throttle).vadd(right.scale(input.steer));
        if (dodge.lengthSquared() > 0.04) {
          dodge.normalize();
          b.velocity.vadd(dodge.scale(7), b.velocity);
          b.velocity.y += 2.2;
          b.angularVelocity.vadd(right.scale(-input.throttle * 4.1), b.angularVelocity);
          b.angularVelocity.vadd(forward.scale(input.steer * 4.1), b.angularVelocity);
        } else b.velocity.y = Math.max(b.velocity.y + 6.2, 6.2);
        p.jumpSustain = 0;
        p.jumpBoosted = false;
        p.airJumps--;
      }
    }
    if (!grounded && input.jump && p.jumpSustain > 0) {
      const boostedSustain = p.jumpBoosted && input.boost && p.boost > 0;
      b.applyForce(p.jumpNormal.scale(boostedSustain ? 4500 : 3500));
      p.jumpSustain = Math.max(0, p.jumpSustain - dt);
    } else if (!input.jump) {
      p.jumpSustain = 0;
      p.jumpBoosted = false;
    }
    p.jumpHeld = input.jump;

    const horizontal = Math.hypot(b.velocity.x, b.velocity.z);
    const max = input.boost ? 34 : 25;
    if (horizontal > max) { b.velocity.x *= max / horizontal; b.velocity.z *= max / horizontal; }
    b.position.x = clamp(b.position.x, -FIELD.halfX - 3.5, FIELD.halfX + 3.5);
    b.position.z = clamp(b.position.z, -FIELD.halfZ + 0.35, FIELD.halfZ - 0.35);

  }

  #updateBoostPads(dt) {
    for (const pad of this.boostPads) {
      if (!pad.active) {
        pad.timer = Math.max(0, pad.timer - dt);
        if (pad.timer === 0) pad.active = true;
        continue;
      }
      for (const p of this.players.values()) {
        if (p.boost >= 100 || p.body.position.y > 2.4) continue;
        const dx = p.body.position.x - pad.x, dz = p.body.position.z - pad.z;
        if (dx * dx + dz * dz > pad.radius * pad.radius) continue;
        p.boost = Math.min(100, p.boost + pad.amount);
        pad.active = false;
        pad.timer = pad.recharge;
        this.events.push({ type: 'boostPickup', playerId: p.id, padId: pad.id, amount: pad.amount });
        break;
      }
    }
  }

  #novaOneInput(p) {
    const b = p.body.position, ball = this.ball.position;
    const attack = p.team === 0 ? 1 : -1;
    const defending = p.team === 0 ? ball.x < -FIELD.halfX * .5 : ball.x > FIELD.halfX * .5;
    const target = new CANNON.Vec3(defending ? ball.x - attack * 1.2 : ball.x - attack * 2.8, ball.y, ball.z * (defending ? .75 : 1));
    const dx = target.x - b.x, dz = target.z - b.z;
    const desired = Math.atan2(-dz, dx);
    const forward = p.body.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
    const yaw = Math.atan2(-forward.z, forward.x);
    const diff = wrap(desired - yaw);
    const distance = Math.hypot(dx, dz);
    p.aiState = 'nova1';
    p.aiTarget.copy(target);
    p.aiInterceptTime = 0;
    return {
      throttle: Math.abs(diff) > 2.35 && distance < 5 ? -.65 : 1,
      steer: clamp(-diff * 1.6, -1, 1),
      boost: Math.abs(diff) < .18 && distance > 9 && p.boost > 15,
      jump: distance < 4 && ball.y > 2.1 && this.random() < .035,
      airRoll: 0
    };
  }

  #predictBall(seconds) {
    const position = this.ball.position.clone();
    const velocity = this.ball.velocity.clone();
    const radius = FIELD.ballRadius;
    const step = 1 / 30;
    for (let elapsed = 0; elapsed < seconds; elapsed += step) {
      const dt = Math.min(step, seconds - elapsed);
      velocity.y += this.world.gravity.y * dt;
      position.x += velocity.x * dt;
      position.y += velocity.y * dt;
      position.z += velocity.z * dt;
      if (position.y < radius) { position.y = radius; velocity.y = Math.abs(velocity.y) * .71; }
      const zLimit = FIELD.halfZ - radius;
      if (Math.abs(position.z) > zLimit) { position.z = Math.sign(position.z) * zLimit; velocity.z *= -.71; }
      const xLimit = FIELD.halfX - radius;
      const inGoalMouth = Math.abs(position.z) < FIELD.goalHalf && position.y < FIELD.goalHeight;
      if (!inGoalMouth && Math.abs(position.x) > xLimit) { position.x = Math.sign(position.x) * xLimit; velocity.x *= -.71; }
    }
    return position;
  }

  #arrivalTime(p, target) {
    const dx = target.x - p.body.position.x, dz = target.z - p.body.position.z;
    const distance = Math.hypot(dx, dz);
    const desired = Math.atan2(-dz, dx);
    const forward = p.body.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
    const yaw = Math.atan2(-forward.z, forward.x);
    const turnDelay = Math.abs(wrap(desired - yaw)) * .18;
    const speed = Math.hypot(p.body.velocity.x, p.body.velocity.z);
    return distance / clamp(speed + 8, 14, 30) + turnDelay;
  }

  #chooseIntercept(p) {
    let choice = { time: 1.6, position: this.#predictBall(1.6) };
    for (let time = .2; time <= 1.6; time += .2) {
      const position = this.#predictBall(time);
      const nearWall = Math.abs(position.z) > FIELD.halfZ - FIELD.curveRadius || Math.abs(position.x) > FIELD.halfX - FIELD.cornerRadius;
      const reachableHeight = nearWall ? 7.5 : 2.4 + time * 3.8;
      if (position.y > reachableHeight) continue;
      if (this.#arrivalTime(p, position) <= time + .12) { choice = { time, position }; break; }
    }
    return choice;
  }

  #attackingContact(p, ballPosition, distance) {
    const attack = p.team === 0 ? 1 : -1;
    const opponentGoal = new CANNON.Vec3(attack * (FIELD.halfX + FIELD.goalDepth), ballPosition.y, 0);
    const shotDirection = opponentGoal.vsub(ballPosition);
    shotDirection.y = 0;
    if (shotDirection.lengthSquared() < .001) shotDirection.set(attack, 0, 0);
    shotDirection.normalize();
    return ballPosition.vsub(shotDirection.scale(distance));
  }

  #driveBotToward(p, target, { urgent = false, jump = false } = {}) {
    const dx = target.x - p.body.position.x, dz = target.z - p.body.position.z;
    const distance = Math.hypot(dx, dz);
    const desired = Math.atan2(-dz, dx);
    const forward = p.body.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
    const yaw = Math.atan2(-forward.z, forward.x);
    const diff = wrap(desired - yaw);
    const reverseManeuver = Math.abs(diff) > 2.35 && distance < 5;
    const throttle = reverseManeuver ? -.65 : 1;
    return {
      throttle,
      steer: clamp(-diff * (urgent ? 1.8 : 1.6), -1, 1),
      boost: !reverseManeuver && Math.abs(diff) < (urgent ? .16 : .18) && distance > (urgent ? 8 : 10) && p.boost > 15,
      jump,
      airRoll: 0
    };
  }

  #updateNovaWfAction(p, dt, target) {
    if (!p.aiAction) return null;
    p.aiAction.elapsed += dt;
    if (p.aiAction.elapsed >= .24) {
      p.aiAction = null;
      p.aiJumpCooldown = .75;
      return null;
    }
    const forward = p.body.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
    const car = { position: p.body.position, yaw: Math.atan2(-forward.z, forward.x), boost: p.boost };
    const input = driveToTarget(car, target, { urgent: true, allowReverse: false, parameters: p.novaWfParameters });
    input.jump = p.aiAction.elapsed < .09 || p.aiAction.elapsed >= .16;
    return input;
  }

  #novaWfInput(p, dt) {
    const attack = p.team === 0 ? 1 : -1;
    const forward = p.body.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
    const yaw = Math.atan2(-forward.z, forward.x);
    const car = {
      position: p.body.position,
      velocity: p.body.velocity,
      yaw,
      boost: p.boost
    };
    const activeAction = this.#updateNovaWfAction(p, dt, p.aiTarget);
    if (activeAction) return activeAction;

    const up = p.body.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
    const drivingSurface = this.#drivingSurface(p, false);
    if (!drivingSurface && p.body.position.y > 2.2 && up.y < .55) {
      p.aiState = 'recovery';
      p.aiCommitTimer = Math.max(p.aiCommitTimer, .25);
      const recovery = driveToTarget(car, p.aiTarget, { urgent: true, allowReverse: false, parameters: p.novaWfParameters });
      recovery.airRoll = clamp(-forward.z * .8, -1, 1);
      return recovery;
    }

    p.aiPredictionTimer -= dt;
    if (!p.aiPrediction || p.aiPredictionTimer <= 0) {
      p.aiPrediction = this.predictBallTrajectory({ horizon: 2.4, sliceDt: 1 / 30, physicsDt: 1 / 120 });
      p.aiPredictionTimer = .25;
    }
    const trajectory = p.aiPrediction;
    const opponentGoal = { x: attack * (FIELD.halfX + FIELD.goalDepth), y: 1.2, z: 0 };
    const ownGoal = { x: -attack * FIELD.halfX, y: .7, z: 0 };
    const intercept = findReachableIntercept({ car, trajectory, target: opponentGoal, field: FIELD, parameters: p.novaWfParameters });
    const selectedBall = intercept?.ballPosition || { x: this.ball.position.x, y: this.ball.position.y, z: this.ball.position.z };
    const opponents = [...this.players.values()].filter(other => other.team !== p.team);
    let opponentArrival = Infinity;
    for (const opponent of opponents) {
      const opponentForward = opponent.body.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
      const opponentCar = {
        position: opponent.body.position,
        velocity: opponent.body.velocity,
        yaw: Math.atan2(-opponentForward.z, opponentForward.x),
        boost: opponent.boost
      };
      const opponentTarget = { x: -attack * (FIELD.halfX + FIELD.goalDepth), y: 1.2, z: 0 };
      const opponentIntercept = findReachableIntercept({ car: opponentCar, trajectory, target: opponentTarget, field: FIELD, parameters: p.novaWfParameters });
      opponentArrival = Math.min(opponentArrival, opponentIntercept?.time ?? Infinity);
    }
    const selfArrival = intercept?.time ?? Infinity;
    const cleanShot = attack * (opponentGoal.x - selectedBall.x) > 0 && Math.abs(selectedBall.z) < FIELD.goalHalf * 1.6;
    const laterTrajectory = trajectory.filter(slice => slice.time > (intercept?.time ?? 0) + .3);
    const laterIntercept = findReachableIntercept({ car, trajectory: laterTrajectory, target: opponentGoal, field: FIELD, parameters: p.novaWfParameters });
    const laterCleanShot = Boolean(laterIntercept && Math.abs(laterIntercept.ballPosition.z) < FIELD.goalHalf * 1.35);
    const ballSpeed = Math.hypot(this.ball.velocity.x, this.ball.velocity.z);
    if (ballSpeed > 2 || Math.hypot(this.ball.position.x, this.ball.position.z) > 7) p.aiKickoffActive = false;
    const kickoff = p.aiKickoffActive && Math.hypot(this.ball.position.x, this.ball.position.z) < 7;
    const ballNearWall = Math.abs(selectedBall.z) > FIELD.halfZ - FIELD.curveRadius || Math.abs(selectedBall.x) > FIELD.halfX - FIELD.cornerRadius;
    const nearWall = ballNearWall && Math.hypot(selectedBall.x - p.body.position.x, selectedBall.z - p.body.position.z) < 22;
    const safeBoostRoute = attack * this.ball.position.x > FIELD.halfX * .2 && this.boostPads.some(pad => pad.active && Math.hypot(pad.x - p.body.position.x, pad.z - p.body.position.z) < 45);

    const validStates = new Set(['kickoff', 'boost-route', 'wall-hit', 'patient-shot', 'clear', 'return', 'shadow', 'fallback']);
    if (p.aiCommitTimer <= 0 || !validStates.has(p.aiState)) {
      p.aiState = chooseNovaWfState({
        kickoff, attack, field: FIELD,
        ball: { position: this.ball.position, velocity: this.ball.velocity },
        selfArrival, opponentArrival, cleanShot, laterCleanShot,
        boost: p.boost, safeBoostRoute, nearWall,
        parameters: p.novaWfParameters
      });
      p.aiStateSince = this.elapsed;
      p.aiCommitTimer = ['clear', 'kickoff', 'return'].includes(p.aiState)
        ? p.novaWfParameters.urgentCommitSeconds
        : p.novaWfParameters.stateCommitSeconds;
    }

    let target;
    let chosenIntercept = intercept;
    if (p.aiState === 'shadow') target = shadowTarget(selectedBall, attack, FIELD, p.novaWfParameters);
    else if (p.aiState === 'return') target = { x: ownGoal.x + attack * 8, y: .7, z: clamp(selectedBall.z * .35, -FIELD.goalHalf, FIELD.goalHalf) };
    else if (p.aiState === 'boost-route') {
      const pad = this.boostPads.filter(candidate => candidate.active).sort((a, b) => (a.x - p.body.position.x) ** 2 + (a.z - p.body.position.z) ** 2 - ((b.x - p.body.position.x) ** 2 + (b.z - p.body.position.z) ** 2))[0];
      target = pad ? { x: pad.x, y: .7, z: pad.z } : attackingContact(selectedBall, opponentGoal, FIELD, p.novaWfParameters);
    } else {
      if (p.aiState === 'patient-shot' && laterIntercept) chosenIntercept = laterIntercept;
      const ballPosition = chosenIntercept?.ballPosition || selectedBall;
      target = attackingContact(ballPosition, opponentGoal, FIELD, p.novaWfParameters);
    }

    p.aiTarget.set(target.x, target.y ?? .7, target.z);
    p.aiInterceptTime = chosenIntercept?.time ?? 0;
    const ballDx = this.ball.position.x - p.body.position.x;
    const ballDz = this.ball.position.z - p.body.position.z;
    const distanceToBall = Math.hypot(ballDx, ballDz);
    const facingBall = distanceToBall > 0 && (forward.x * ballDx + forward.z * ballDz) / distanceToBall > .72;
    const shotDx = opponentGoal.x - this.ball.position.x;
    const shotDz = opponentGoal.z - this.ball.position.z;
    const behindBallForShot = ballDx * shotDx + ballDz * shotDz > 0;
    if (distanceToBall < 5 && facingBall && behindBallForShot && this.ball.position.y < 4.2 && p.aiJumpCooldown <= 0 && ['kickoff', 'clear', 'fallback'].includes(p.aiState)) {
      p.aiAction = { type: 'smart-dodge', elapsed: 0 };
      return this.#updateNovaWfAction(p, dt, p.aiTarget) || driveToTarget(car, target, { urgent: true, parameters: p.novaWfParameters });
    }
    const jump = Boolean(chosenIntercept && chosenIntercept.time < .32 && chosenIntercept.ballPosition.y > 3.1 && p.aiJumpCooldown <= 0);
    const input = driveToTarget(car, target, { urgent: ['kickoff', 'clear'].includes(p.aiState), jump, parameters: p.novaWfParameters });
    if (p.aiState === 'boost-route') input.boost = false;
    return input;
  }

  #botInput(p, dt) {
    const b = p.body.position, ball = this.ball.position;
    p.aiJumpCooldown = Math.max(0, p.aiJumpCooldown - dt);
    p.aiJumpHold = Math.max(0, p.aiJumpHold - dt);
    p.aiCommitTimer = Math.max(0, p.aiCommitTimer - dt);
    if (p.aiVersion === 1) return this.#novaOneInput(p);
    if (p.aiVersion === 3) return this.#novaWfInput(p, dt);
    const attack = p.team === 0 ? 1 : -1;
    const ownGoalDirection = -attack;
    const deepInOwnHalf = attack * ball.x < -FIELD.halfX * .3;
    const movingTowardOwnGoal = this.ball.velocity.x * ownGoalDirection > 4;
    if (deepInOwnHalf && movingTowardOwnGoal) {
      const predicted = this.#predictBall(.6);
      const clearanceTarget = this.#attackingContact(p, predicted, 2.2);
      p.aiState = 'save';
      p.aiTarget.copy(clearanceTarget);
      p.aiInterceptTime = .6;
      return this.#driveBotToward(p, clearanceTarget, { urgent: true });
    }
    const ballDistanceNow = Math.hypot(ball.x - b.x, ball.z - b.z);
    const ballSpeed = Math.hypot(this.ball.velocity.x, this.ball.velocity.z);
    const directlyRecoverable = ball.y < 3.4 && ballSpeed < 14;
    if (directlyRecoverable) {
      const huntTarget = this.#attackingContact(p, ball, 2.8);
      p.aiCommitTimer = 2.2;
      p.aiState = 'hunt';
      p.aiTarget.copy(huntTarget);
      p.aiInterceptTime = 0;
      return this.#driveBotToward(p, huntTarget);
    }
    if (p.aiCommitTimer > 0 && ball.y < 4.5) {
      const carryTarget = this.#attackingContact(p, ball, 2.2);
      p.aiState = 'carry';
      p.aiTarget.copy(carryTarget);
      p.aiInterceptTime = 0;
      return this.#driveBotToward(p, carryTarget);
    }
    const ballSafelyAway = attack * ball.x > FIELD.halfX * .3;
    if (p.boost < 12 && ballSafelyAway && ballDistanceNow > 28) {
      const pad = this.boostPads.filter(candidate => candidate.active).sort((a, c) => {
        const da = (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
        const dc = (c.x - b.x) ** 2 + (c.z - b.z) ** 2;
        return da - dc;
      })[0];
      if (pad) {
        const padTarget = new CANNON.Vec3(pad.x, 0, pad.z);
        p.aiState = 'boost';
        p.aiTarget.copy(padTarget);
        p.aiInterceptTime = 0;
        const input = this.#driveBotToward(p, padTarget);
        input.boost = false;
        return input;
      }
    }
    const intercept = this.#chooseIntercept(p);
    const predicted = intercept.position;
    const opponents = [...this.players.values()].filter(other => other.team !== p.team);
    const opponentArrival = opponents.reduce((best, opponent) => Math.min(best, this.#arrivalTime(opponent, predicted)), Infinity);
    const novaArrival = this.#arrivalTime(p, predicted);
    const ballNearOwnHalf = attack * ball.x < FIELD.halfX * .15;
    if (ballNearOwnHalf && opponentArrival + .25 < novaArrival) {
      const ownGoal = new CANNON.Vec3(-attack * FIELD.halfX, 0, 0);
      const coverDirection = ownGoal.vsub(predicted);
      coverDirection.y = 0;
      if (coverDirection.lengthSquared() < .001) coverDirection.set(-attack, 0, 0);
      coverDirection.normalize();
      const shadowTarget = predicted.vadd(coverDirection.scale(clamp(7 + ballSpeed * .08, 7, 12)));
      p.aiState = 'shadow';
      p.aiTarget.copy(shadowTarget);
      p.aiInterceptTime = intercept.time;
      return this.#driveBotToward(p, shadowTarget);
    }
    const shotTarget = new CANNON.Vec3(attack * (FIELD.halfX + FIELD.goalDepth), 1.2, 0);
    const shotDirection = shotTarget.vsub(predicted);
    shotDirection.y = 0;
    if (shotDirection.lengthSquared() < .001) shotDirection.set(attack, 0, 0);
    shotDirection.normalize();
    const setupDistance = clamp(2.8 + ballSpeed * .045, 2.8, 5.2);
    const target = predicted.vsub(shotDirection.scale(setupDistance));
    const defending = attack * ball.x < -FIELD.halfX * .45;
    if (defending) {
      target.x = predicted.x - attack * 1.3;
      target.z = predicted.z * .72;
    }
    p.aiState = defending ? 'defend' : ballSpeed > 5 ? 'intercept' : 'attack';
    p.aiTarget.copy(target);
    p.aiInterceptTime = intercept.time;
    const ballDistance = Math.hypot(predicted.x - b.x, predicted.z - b.z);
    if (p.aiJumpCooldown === 0 && intercept.time <= .8 && ballDistance < 5.5 && predicted.y > 2.2 && predicted.y < 6.8) {
      p.aiJumpHold = .18;
      p.aiJumpCooldown = 1.05;
    }
    const jump = p.aiJumpHold > 0;
    return this.#driveBotToward(p, target, { jump });
  }

  step(dt = DT) {
    dt = Math.min(dt, 1 / 30);
    this.elapsed += dt;
    if (this.status === 'countdown') {
      this.countdownClock -= dt;
      if (this.countdownClock <= 0) {
        this.countdown--;
        this.countdownClock += 1;
        if (this.countdown <= 0) { this.status = 'playing'; this.events.push({ type: 'go' }); }
        else this.events.push({ type: 'countdown', value: this.countdown });
      }
      for (const p of this.players.values()) p.boosting = false;
      return;
    } else if (this.status === 'goal') {
      this.goalClock -= dt;
      if (this.goalClock <= 0) this.#kickoff();
      return;
    } else if (this.status === 'finished') {
      return;
    }

    for (const p of this.players.values()) this.#updateCar(p, dt);
    this.world.step(DT, dt, 3);
    for (const p of this.players.values()) this.#resolveCurveContact(p);
    this.#updateBoostPads(dt);
    if (this.mode === 'duel') {
      const bots = [...this.players.values()].filter(player => player.isBot);
      const bothCarsImmobile = bots.length >= 2 && bots.every(player => Math.hypot(player.body.velocity.x, player.body.velocity.z) < .85);
      const noGoalwardBallProgress = Math.abs(this.ball.velocity.x) < 1;
      this.duelCollectiveStallTime = bothCarsImmobile && noGoalwardBallProgress ? this.duelCollectiveStallTime + dt : 0;
      if (this.duelCollectiveStallTime >= 5) {
        this.events.push({ type: 'duelReset', reason: 'collective-deadlock', score: [...this.score] });
        this.#kickoff();
        return;
      }
      const planarBallSpeed = Math.hypot(this.ball.velocity.x, this.ball.velocity.z);
      this.duelStallTime = planarBallSpeed < 1.25 ? this.duelStallTime + dt : 0;
      if (this.duelStallTime >= 8) {
        const direction = this.duelNudgeIndex++ % 2 === 0 ? 1 : -1;
        this.ball.velocity.z = direction * 9;
        this.ball.angularVelocity.x = -direction * 2.5;
        this.duelStallTime = 0;
        this.events.push({ type: 'duelNudge', direction });
      }
    }
    // Safety contact constraint: prevents a fast chassis from tunnelling through the thin floor.
    for (const p of this.players.values()) {
      if (p.body.position.y < 0.40) {
        p.body.position.y = 0.54;
        if (p.body.velocity.y < 0) p.body.velocity.y = 0;
        p.body.angularVelocity.x *= 0.35;
        p.body.angularVelocity.z *= 0.35;
      }
    }

    const bp = this.ball.position;
    const inGoal = Math.abs(bp.z) < FIELD.goalHalf && bp.y < FIELD.goalHeight;
    const crossedGoalLine = FIELD.halfX + FIELD.ballRadius;
    if (inGoal && bp.x > crossedGoalLine) this.#goal(0);
    if (inGoal && bp.x < -crossedGoalLine) this.#goal(1);
    if (bp.y < -4 || Math.abs(bp.z) > FIELD.halfZ + 8 || Math.abs(bp.x) > FIELD.halfX + 10) {
      this.ball.position.set(0, 4, 0); this.ball.velocity.setZero();
    }
  }

  drainEvents() { const events = this.events; this.events = []; return events; }

  snapshot() {
    const bodyState = body => ({
      p: [body.position.x, body.position.y, body.position.z],
      q: [body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w],
      v: [body.velocity.x, body.velocity.y, body.velocity.z]
    });
    return {
      mode: this.mode, status: this.status, countdown: this.countdown, score: [...this.score], winner: this.winner,
      ball: bodyState(this.ball),
      boostPads: this.boostPads.map(pad => ({ id: pad.id, x: pad.x, z: pad.z, amount: pad.amount, active: pad.active, timer: pad.timer })),
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, isBot: p.isBot, boost: p.boost, boosting: p.boosting, ...(p.isBot ? { ai: { version: p.aiVersion, controllerId: p.controllerId, state: p.aiState, action: p.aiAction?.type || null, commitTime: p.aiCommitTimer, stateSince: p.aiStateSince, target: [p.aiTarget.x, p.aiTarget.y, p.aiTarget.z], interceptTime: p.aiInterceptTime } } : {}), ...bodyState(p.body) }))
    };
  }
}

export function blankInput() { return { throttle: 0, steer: 0, boost: false, jump: false, airRoll: 0 }; }
export function sanitizeInput(i) {
  return { throttle: clamp(Number(i.throttle) || 0, -1, 1), steer: clamp(Number(i.steer) || 0, -1, 1), boost: Boolean(i.boost), jump: Boolean(i.jump), airRoll: clamp(Number(i.airRoll) || 0, -1, 1) };
}
