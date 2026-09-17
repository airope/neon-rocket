export const ARENA_VERSION = 'neon-hyperdome-v2';

export const FIELD = Object.freeze({
  halfX: 120,
  halfZ: 76,
  goalHalf: 18,
  goalHeight: 16,
  goalDepth: 8,
  ballRadius: 1.875,
  ceilingY: 44,
  curveRadius: 16,
  cornerRadius: 28
});

export const CAR = Object.freeze({
  model: 'Aegis V2',
  chassisHalf: Object.freeze({ x: 1.45, y: 0.68, z: 0.88 }),
  bumperHalf: Object.freeze({ x: 0.22, y: 0.32, z: 0.78 }),
  bumperOffset: Object.freeze({ x: 1.55, y: -0.16, z: 0 }),
  frontExtent: 1.77,
  rearExtent: -1.45,
  wheelRadius: 0.5,
  wheelWidth: 0.3,
  wheelCenterY: -0.18,
  wheelX: 0.94,
  wheelZ: 0.69,
  restY: 0.68,
  curveClearance: 0.72
});

export function curveHeight(distance) {
  const d = Math.max(0, Math.min(FIELD.curveRadius, distance));
  return FIELD.curveRadius - Math.sqrt(Math.max(0, FIELD.curveRadius ** 2 - d ** 2));
}

export function transitionPoint(progress, top = false) {
  const t = Math.max(0, Math.min(1, progress));
  const theta = t * Math.PI / 2;
  const rise = FIELD.curveRadius - FIELD.curveRadius * Math.cos(theta);
  return {
    inset: FIELD.curveRadius - FIELD.curveRadius * Math.sin(theta),
    y: top ? FIELD.ceilingY - rise : rise
  };
}

export function roundedCornerPoint({ sideX, sideZ, phi, theta, top = false }) {
  const horizontal = Math.max(0, Math.min(1, phi)) * Math.PI / 2;
  const vertical = Math.max(0, Math.min(1, theta)) * Math.PI / 2;
  const radial = FIELD.cornerRadius - FIELD.curveRadius + FIELD.curveRadius * Math.sin(vertical);
  const centerX = sideX * (FIELD.halfX - FIELD.cornerRadius);
  const centerZ = sideZ * (FIELD.halfZ - FIELD.cornerRadius);
  const rise = FIELD.curveRadius - FIELD.curveRadius * Math.cos(vertical);
  return {
    x: centerX + sideX * radial * Math.cos(horizontal),
    y: top ? FIELD.ceilingY - rise : rise,
    z: centerZ + sideZ * radial * Math.sin(horizontal)
  };
}

export function arenaCurveProfile(position) {
  const ax = Math.abs(position.x), az = Math.abs(position.z);
  const sideX = position.x < 0 ? -1 : 1;
  const sideZ = position.z < 0 ? -1 : 1;
  const cornerX = FIELD.halfX - FIELD.cornerRadius;
  const cornerZ = FIELD.halfZ - FIELD.cornerRadius;
  if (ax > cornerX && az > cornerZ) {
    const dx = position.x - sideX * cornerX;
    const dz = position.z - sideZ * cornerZ;
    const radius = Math.hypot(dx, dz) || 1;
    return { distance: radius - (FIELD.cornerRadius - FIELD.curveRadius), outward: { x: dx / radius, y: 0, z: dz / radius } };
  }
  if (az > FIELD.halfZ - FIELD.curveRadius && ax <= cornerX) {
    return { distance: az - (FIELD.halfZ - FIELD.curveRadius), outward: { x: 0, y: 0, z: sideZ } };
  }
  if (ax > FIELD.halfX - FIELD.curveRadius && az >= FIELD.goalHalf && az <= cornerZ) {
    return { distance: ax - (FIELD.halfX - FIELD.curveRadius), outward: { x: sideX, y: 0, z: 0 } };
  }
  return null;
}
