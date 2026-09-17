const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

function driveTo({ car, target, strategy, jumpHeight = 1.6, boostDistance = 10 }) {
  const dx = target.x - car.position.x;
  const dz = target.z - car.position.z;
  const desired = Math.atan2(-dz, dx);
  const heading = Math.atan2(-car.rotation.forward.z, car.rotation.forward.x);
  const angle = wrap(desired - heading);
  const distance = Math.hypot(dx, dz);
  const steer = clamp(angle * 1.8, -1, 1);
  return {
    throttle: 1,
    steer,
    pitch: -1,
    yaw: -steer,
    roll: 0,
    jump: distance < 3.5 && target.y > jumpHeight,
    boost: Math.abs(angle) < .22 && distance > boostDistance && car.boost > 5,
    handbrake: Math.abs(angle) > 1.35,
    strategy
  };
}

export function novaDirectControls({ team, car, ball }) {
  const attack = team === 0 ? 1 : -1;
  return driveTo({
    car,
    target: { x: ball.position.x - attack * 1.8, y: ball.position.y, z: ball.position.z },
    strategy: 'direct'
  });
}

export function novaTacticalControls({ team, car, ball, field }) {
  const attack = team === 0 ? 1 : -1;
  const speed = Math.hypot(ball.velocity.x, ball.velocity.z);
  const lowRecoverable = ball.position.y < 2.8 && speed < 14;
  const ownGoalThreat = attack * ball.position.x < -field.halfLength * .3 && ball.velocity.x * -attack > 3;
  let target;
  let strategy;
  if (lowRecoverable) {
    target = { x: ball.position.x - attack * 1.8, y: ball.position.y, z: ball.position.z };
    strategy = 'tactical-hunt';
  } else if (ownGoalThreat) {
    target = { x: ball.position.x - attack * 2.2, y: ball.position.y, z: ball.position.z + Math.sign(ball.position.z || 1) * 1.1 };
    strategy = 'tactical-save';
  } else {
    const horizon = clamp(Math.hypot(ball.position.x - car.position.x, ball.position.z - car.position.z) / 22, .2, 1.2);
    target = {
      x: ball.position.x + ball.velocity.x * horizon - attack * 1.8,
      y: ball.position.y,
      z: ball.position.z + ball.velocity.z * horizon
    };
    strategy = 'tactical-intercept';
  }
  return driveTo({ car, target, strategy });
}

export function novaWildfireControls({ team, car, ball, field, boostPads = [] }) {
  const attack = team === 0 ? 1 : -1;
  const ownHalfDanger = attack * ball.position.x < -field.halfLength * .15;
  const safeForBoost = attack * ball.position.x > field.halfLength * .2 && car.boost < 24;
  let target;
  let strategy;
  if (safeForBoost) {
    const pad = boostPads.filter(candidate => candidate.active).sort((a, b) =>
      (a.x - car.position.x) ** 2 + (a.z - car.position.z) ** 2 -
      ((b.x - car.position.x) ** 2 + (b.z - car.position.z) ** 2)
    )[0];
    if (pad) {
      target = { x: pad.x, y: .3, z: pad.z };
      strategy = 'wildfire-boost-route';
    }
  }
  if (!target && ownHalfDanger) {
    target = {
      x: -attack * (field.halfLength - 7),
      y: .3,
      z: clamp(ball.position.z * .42, -field.goalHalfWidth, field.goalHalfWidth)
    };
    strategy = 'wildfire-shadow';
  }
  if (!target) {
    const lead = clamp(Math.hypot(ball.position.x - car.position.x, ball.position.z - car.position.z) / 30, .15, .7);
    target = {
      x: ball.position.x + ball.velocity.x * lead - attack * 2.6,
      y: ball.position.y,
      z: ball.position.z + ball.velocity.z * lead
    };
    strategy = 'wildfire-attack';
  }
  return driveTo({ car, target, strategy, boostDistance: 7 });
}

export function controlsForNovaVersion(aiVersion, context) {
  if (aiVersion === 2) return novaTacticalControls(context);
  if (aiVersion === 3) return novaWildfireControls(context);
  return novaDirectControls(context);
}
