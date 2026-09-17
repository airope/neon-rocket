const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const flatDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export const NOVA_WF_DEFAULTS = Object.freeze({
  schemaVersion: 1,
  physicsDt: 1 / 120,
  engineAcceleration: 2350 / 145,
  brakingAcceleration: 10500 / 145,
  boostAcceleration: 3000 / 145,
  boostConsumption: 31,
  normalSpeedCap: 25,
  boostSpeedCap: 34,
  linearDamping: .055,
  contactRadius: 1.7,
  stateCommitSeconds: .22,
  urgentCommitSeconds: .38,
  boostAngle: .16,
  boostDistance: 8,
  shadowDistance: 10,
  boostRouteThreshold: 15,
  contestMargin: .2,
  dangerEnterFraction: .3,
  dangerUrgentFraction: .55,
  dangerVelocity: 3,
  wallHeight: 3
});

export const NOVA_WF_PARAMETER_RANGES = Object.freeze({
  contactRadius: [.8, 3],
  stateCommitSeconds: [.08, .8],
  urgentCommitSeconds: [.1, 1.2],
  boostAngle: [.05, .45],
  boostDistance: [4, 20],
  shadowDistance: [5, 25],
  boostRouteThreshold: [5, 50],
  contestMargin: [0, .8],
  dangerEnterFraction: [.15, .55],
  dangerUrgentFraction: [.35, .8],
  dangerVelocity: [1, 10],
  wallHeight: [1.5, 6]
});

export function normalizeNovaWfParameters(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('NOVA-WF parameters must be an object');
  const parameters = { ...NOVA_WF_DEFAULTS };
  for (const [key, value] of Object.entries(overrides)) {
    const range = NOVA_WF_PARAMETER_RANGES[key];
    if (!range) {
      if (Object.hasOwn(NOVA_WF_DEFAULTS, key) && value === NOVA_WF_DEFAULTS[key]) continue;
      throw new RangeError(`unsupported NOVA-WF parameter ${key}`);
    }
    if (!Number.isFinite(value) || value < range[0] || value > range[1]) throw new RangeError(`${key} must be between ${range[0]} and ${range[1]}`);
    parameters[key] = value;
  }
  return Object.freeze(parameters);
}

export function simulateCar1D({
  seconds,
  initialSpeed = 0,
  boost = 0,
  targetDistance = Infinity,
  parameters = NOVA_WF_DEFAULTS
}) {
  if (!(seconds >= 0) || !Number.isFinite(initialSpeed) || !(boost >= 0)) throw new RangeError('invalid Car1D input');
  const dt = parameters.physicsDt;
  let speed = initialSpeed;
  let distance = 0;
  let boostRemaining = boost;
  let arrivalTime = targetDistance <= 0 ? 0 : null;
  const steps = Math.ceil(seconds / dt);
  for (let step = 0; step < steps; step++) {
    const stepDt = Math.min(dt, seconds - step * dt);
    if (stepDt <= 0) break;
    let acceleration;
    let boosting = false;
    if (speed < 0) acceleration = parameters.brakingAcceleration;
    else {
      boosting = boostRemaining > 0 && speed < parameters.boostSpeedCap;
      acceleration = parameters.engineAcceleration + (boosting ? parameters.boostAcceleration : 0);
    }
    speed += acceleration * stepDt;
    if (boosting) boostRemaining = Math.max(0, boostRemaining - parameters.boostConsumption * stepDt);
    const cap = boosting || speed > parameters.normalSpeedCap ? parameters.boostSpeedCap : parameters.normalSpeedCap;
    speed = clamp(speed, -parameters.normalSpeedCap, cap);
    speed *= Math.pow(1 - parameters.linearDamping, stepDt);
    distance += Math.max(0, speed) * stepDt;
    if (arrivalTime === null && distance >= targetDistance) arrivalTime = (step + 1) * dt;
  }
  return { distance, speed, boostRemaining, arrivalTime };
}

export function findReachableIntercept({ car, trajectory, target, field, parameters = NOVA_WF_DEFAULTS }) {
  for (const slice of trajectory) {
    if (slice.position.y > 4.4 || slice.goalTeam != null) continue;
    const dx = slice.position.x - car.position.x;
    const dz = slice.position.z - car.position.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    const direction = { x: dx / length, z: dz / length };
    const initialSpeed = car.velocity.x * direction.x + car.velocity.z * direction.z;
    const desiredYaw = Math.atan2(-dz, dx);
    const turnTime = Number.isFinite(car.yaw) ? Math.abs(wrap(desiredYaw - car.yaw)) / 3 : 0;
    const driveSeconds = slice.time - turnTime;
    if (driveSeconds <= 0) continue;
    const targetDistance = Math.max(0, length - (field.ballRadius + parameters.contactRadius));
    const drive = simulateCar1D({ seconds: driveSeconds, initialSpeed, boost: car.boost, targetDistance, parameters });
    if (drive.arrivalTime === null) continue;
    const shotDx = target.x - slice.position.x;
    const shotDz = target.z - slice.position.z;
    const shotLength = Math.hypot(shotDx, shotDz) || 1;
    const shotDirection = { x: shotDx / shotLength, z: shotDz / shotLength };
    const standOff = field.ballRadius + parameters.contactRadius;
    return {
      time: slice.time,
      frame: Math.round(slice.time * 60),
      ballPosition: { ...slice.position },
      contactPosition: {
        x: slice.position.x - shotDirection.x * standOff,
        y: Math.max(.7, slice.position.y),
        z: slice.position.z - shotDirection.z * standOff
      },
      arrivalSlack: slice.time - (turnTime + drive.arrivalTime),
      turnTime,
      type: 'ground'
    };
  }
  return null;
}

export function chooseNovaWfState({
  kickoff,
  attack,
  field,
  ball,
  selfArrival,
  opponentArrival,
  cleanShot,
  laterCleanShot,
  boost,
  safeBoostRoute = false,
  nearWall = false,
  parameters = NOVA_WF_DEFAULTS
}) {
  if (kickoff) return 'kickoff';
  const progress = attack * ball.position.x;
  const ownGoalVelocity = -attack * ball.velocity.x;
  if (progress < -field.halfX * parameters.dangerEnterFraction && (ownGoalVelocity > parameters.dangerVelocity || progress < -field.halfX * parameters.dangerUrgentFraction)) return 'clear';
  if (nearWall && ball.position.y > parameters.wallHeight) return 'wall-hit';
  if (boost < parameters.boostRouteThreshold && safeBoostRoute && selfArrival + .75 < opponentArrival) return 'boost-route';
  if (!cleanShot && laterCleanShot) return 'patient-shot';
  if (opponentArrival + parameters.contestMargin < selfArrival) return progress < field.halfX * .1 ? 'shadow' : 'return';
  return 'fallback';
}

export function driveToTarget(car, target, { urgent = false, jump = false, allowReverse = true, parameters = NOVA_WF_DEFAULTS } = {}) {
  const dx = target.x - car.position.x;
  const dz = target.z - car.position.z;
  const distance = Math.hypot(dx, dz);
  const desired = Math.atan2(-dz, dx);
  const diff = wrap(desired - car.yaw);
  const reverse = allowReverse && Math.abs(diff) > 2.55 && distance < 4;
  return {
    throttle: reverse ? -.65 : 1,
    steer: clamp(-diff * (urgent ? 1.9 : 1.65), -1, 1),
    boost: !reverse && Math.abs(diff) < parameters.boostAngle && distance > parameters.boostDistance && car.boost > 10,
    jump,
    airRoll: 0
  };
}

export function attackingContact(ballPosition, target, field, parameters = NOVA_WF_DEFAULTS) {
  const dx = target.x - ballPosition.x;
  const dz = target.z - ballPosition.z;
  const length = Math.hypot(dx, dz) || 1;
  const standOff = field.ballRadius + parameters.contactRadius;
  return {
    x: ballPosition.x - dx / length * standOff,
    y: ballPosition.y,
    z: ballPosition.z - dz / length * standOff
  };
}

export function shadowTarget(ballPosition, attack, field, parameters = NOVA_WF_DEFAULTS) {
  const ownGoal = { x: -attack * field.halfX, z: 0 };
  const distance = flatDistance(ballPosition, ownGoal) || 1;
  const travel = Math.min(parameters.shadowDistance, Math.max(0, distance - 1));
  return {
    x: ballPosition.x + (ownGoal.x - ballPosition.x) / distance * travel,
    y: .7,
    z: ballPosition.z + (ownGoal.z - ballPosition.z) / distance * travel
  };
}
