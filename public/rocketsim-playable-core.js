export { integrateRollingQuaternion } from '../shared/rolling-quaternion.js';

export function chaseCameraPose(position, forward, ballPosition) {
  const lookAt = {
    x: position.x + forward.x * 2.4,
    y: position.y + 0.8,
    z: position.z + forward.z * 2.4
  };
  if (ballPosition) {
    const dx = ballPosition.x - lookAt.x;
    const dy = ballPosition.y - lookAt.y;
    const dz = ballPosition.z - lookAt.z;
    const distance = Math.hypot(dx, dy, dz) || 1;
    const scale = Math.min(distance, 10) / distance * 0.12;
    lookAt.x += dx * scale;
    lookAt.y += dy * scale;
    lookAt.z += dz * scale;
  }
  return {
    position: {
      x: position.x - forward.x * 6.4,
      y: Math.max(2.8, position.y + 3.4),
      z: position.z - forward.z * 6.4
    },
    lookAt
  };
}

const axis = (positive, negative) => Number(positive) - Number(negative);

export function controlsFromHeldKeys(held) {
  return {
    throttle: axis(held.has('KeyW') || held.has('ArrowUp') || held.has('throttle'), held.has('KeyS') || held.has('ArrowDown') || held.has('brake')),
    steer: axis(held.has('KeyA') || held.has('ArrowLeft') || held.has('left'), held.has('KeyD') || held.has('ArrowRight') || held.has('right')),
    pitch: axis(held.has('ArrowDown'), held.has('ArrowUp')),
    yaw: axis(held.has('ArrowLeft'), held.has('ArrowRight')),
    roll: axis(held.has('KeyE'), held.has('KeyQ')),
    jump: held.has('Space') || held.has('jump'),
    boost: held.has('ShiftLeft') || held.has('ShiftRight') || held.has('boost'),
    handbrake: held.has('KeyC') || held.has('handbrake')
  };
}

