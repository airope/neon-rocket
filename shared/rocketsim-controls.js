const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function sanitizeRocketSimControls(input = {}) {
  const throttle = clamp(Number(input.throttle) || 0, -1, 1);
  const steer = clamp(Number(input.steer) || 0, -1, 1);
  const explicitAxis = (value, fallback) => value === undefined || value === null
    ? fallback
    : clamp(Number.isFinite(Number(value)) ? Number(value) : fallback, -1, 1);
  return {
    throttle,
    steer,
    pitch: explicitAxis(input.pitch, -throttle),
    yaw: explicitAxis(input.yaw, -steer),
    roll: clamp(Number(input.roll ?? input.airRoll) || 0, -1, 1),
    jump: Boolean(input.jump),
    boost: Boolean(input.boost),
    handbrake: Boolean(input.handbrake)
  };
}
