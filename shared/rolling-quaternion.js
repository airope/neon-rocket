export function integrateRollingQuaternion(quaternion, velocity, radius, dt) {
  const [vx, , vz] = velocity;
  const speed = Math.hypot(vx, vz);
  if (!(speed > 1e-9) || !(radius > 0) || !(dt > 0)) return [...quaternion];
  const halfAngle = speed / radius * dt * .5;
  const sine = Math.sin(halfAngle);
  const dx = vz / speed * sine;
  const dy = 0;
  const dz = -vx / speed * sine;
  const dw = Math.cos(halfAngle);
  const [x, y, z, w] = quaternion;
  const next = [
    dw * x + dx * w + dy * z - dz * y,
    dw * y - dx * z + dy * w + dz * x,
    dw * z + dx * y - dy * x + dz * w,
    dw * w - dx * x - dy * y - dz * z
  ];
  const norm = Math.hypot(...next) || 1;
  return next.map(value => value / norm);
}
