import { RAPIER } from './rapier-engine.js';
import { CAR_SOCCER_FIELD } from './car-soccer-contract.js';

export const RAPIER_ARENA_VERSION = 'neon-prism-bowl-v3';

const quaternionFromAxisAngle = (axis, angle) => {
  const half = angle / 2, sine = Math.sin(half);
  return { x: axis.x * sine, y: axis.y * sine, z: axis.z * sine, w: Math.cos(half) };
};

function cornerRampMesh({ roof = false, segments = 12 } = {}) {
  const field = CAR_SOCCER_FIELD;
  const vertices = [], indices = [];
  const innerRadius = field.cornerRadius - field.floorCurveRadius;
  for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) {
    const base = vertices.length / 3;
    const centerX = sideX * (field.halfLength - field.cornerRadius);
    const centerZ = sideZ * (field.halfWidth - field.cornerRadius);
    for (let radial = 0; radial <= 1; radial++) {
      const radius = innerRadius + radial * field.floorCurveRadius;
      const height = radial === 0 ? 0 : field.floorCurveRadius;
      const y = roof ? field.ceiling - height : height;
      for (let index = 0; index <= segments; index++) {
        const angle = index / segments * Math.PI / 2;
        vertices.push(
          centerX + sideX * Math.cos(angle) * radius,
          y,
          centerZ + sideZ * Math.sin(angle) * radius
        );
      }
    }
    for (let index = 0; index < segments; index++) {
      const inner = base + index, outer = base + segments + 1 + index;
      if (roof) indices.push(inner, outer + 1, outer, inner, inner + 1, outer + 1);
      else indices.push(inner, outer, outer + 1, inner, outer + 1, inner + 1);
    }
  }
  return Object.freeze({ vertices: Object.freeze(vertices), indices: Object.freeze(indices) });
}

export const RAPierArenaMeshes = Object.freeze({
  floorCornerRamps: cornerRampMesh(),
  roofCornerRamps: cornerRampMesh({ roof: true })
});

export function buildRapierArena(world) {
  const field = CAR_SOCCER_FIELD;
  const colliders = [];
  const parts = new Set();
  const addBox = (name, x, y, z, hx, hy, hz, rotation = null, friction = 0.9, restitution = 0.08) => {
    let descriptor = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(x, y, z)
      .setFriction(friction)
      .setRestitution(restitution);
    if (rotation) descriptor = descriptor.setRotation(rotation);
    const collider = world.createCollider(descriptor);
    collider.userData = { arenaPart: name };
    colliders.push(collider);
    return collider;
  };
  const addMesh = (name, mesh) => {
    const collider = world.createCollider(
      RAPIER.ColliderDesc.trimesh(new Float32Array(mesh.vertices), new Uint32Array(mesh.indices))
        .setFriction(0.95)
        .setRestitution(0.04)
    );
    collider.userData = { arenaPart: name };
    colliders.push(collider);
  };

  const shell = 2;
  addBox('floor', 0, -0.25, 0, field.halfLength + field.goalDepth + shell, 0.25, field.halfWidth + shell);
  addBox('ceiling', 0, field.ceiling + 0.25, 0, field.halfLength + field.goalDepth + shell, 0.25, field.halfWidth + shell);

  const bank = field.floorCurveRadius;
  const bankLength = Math.SQRT2 * bank;
  const verticalCenter = field.ceiling / 2;
  const verticalHalf = (field.ceiling - bank * 2) / 2;
  const straightHalfLength = field.halfLength - field.cornerRadius;
  for (const side of [-1, 1]) {
    addBox('side-wall', 0, verticalCenter, side * (field.halfWidth + 0.25), straightHalfLength, verticalHalf, 0.25);
    addBox('side-floor-bank', 0, bank / 2, side * (field.halfWidth - bank / 2), straightHalfLength, 0.14, bankLength / 2,
      quaternionFromAxisAngle({ x: 1, y: 0, z: 0 }, -side * Math.PI / 4));
    addBox('side-roof-bank', 0, field.ceiling - bank / 2, side * (field.halfWidth - bank / 2), straightHalfLength, 0.14, bankLength / 2,
      quaternionFromAxisAngle({ x: 1, y: 0, z: 0 }, side * Math.PI / 4));
  }
  parts.add('floor-banks');

  const flankWidth = (field.halfWidth - field.cornerRadius - field.goalHalfWidth) / 2;
  const flankCenter = field.goalHalfWidth + flankWidth;
  for (const side of [-1, 1]) {
    for (const sideZ of [-1, 1]) {
      addBox('end-wall-flank', side * (field.halfLength + 0.25), verticalCenter, sideZ * flankCenter, 0.25, verticalHalf, flankWidth);
      addBox('end-floor-bank', side * (field.halfLength - bank / 2), bank / 2, sideZ * flankCenter, bankLength / 2, 0.14, flankWidth,
        quaternionFromAxisAngle({ x: 0, y: 0, z: 1 }, side * Math.PI / 4));
      addBox('end-roof-bank', side * (field.halfLength - bank / 2), field.ceiling - bank / 2, sideZ * flankCenter, bankLength / 2, 0.14, flankWidth,
        quaternionFromAxisAngle({ x: 0, y: 0, z: 1 }, -side * Math.PI / 4));
    }
    const upperHalf = (field.ceiling - field.goalHeight) / 2;
    addBox('goal-crossbar-shell', side * (field.halfLength + 0.25), field.goalHeight + upperHalf, 0, 0.25, upperHalf, field.goalHalfWidth);
    const goalCenterX = side * (field.halfLength + field.goalDepth / 2);
    addBox('goal-back', side * (field.halfLength + field.goalDepth), field.goalHeight / 2, 0, 0.25, field.goalHeight / 2, field.goalHalfWidth + 0.4, null, 0.7, 0.25);
    addBox('goal-side', goalCenterX, field.goalHeight / 2, field.goalHalfWidth + 0.25, field.goalDepth / 2, field.goalHeight / 2, 0.25);
    addBox('goal-side', goalCenterX, field.goalHeight / 2, -field.goalHalfWidth - 0.25, field.goalDepth / 2, field.goalHeight / 2, 0.25);
    addBox('goal-roof', goalCenterX, field.goalHeight + 0.25, 0, field.goalDepth / 2, 0.25, field.goalHalfWidth + 0.5);
  }
  parts.add('goal-tunnels');

  const cornerSegments = 8;
  const arcStep = Math.PI / 2 / cornerSegments;
  const arcHalfLength = field.cornerRadius * Math.sin(arcStep / 2) * 1.02;
  for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) {
    const centerX = sideX * (field.halfLength - field.cornerRadius);
    const centerZ = sideZ * (field.halfWidth - field.cornerRadius);
    for (let index = 0; index < cornerSegments; index++) {
      const angle = (index + 0.5) * arcStep;
      const x = centerX + sideX * Math.cos(angle) * (field.cornerRadius + 0.25);
      const z = centerZ + sideZ * Math.sin(angle) * (field.cornerRadius + 0.25);
      const tangentX = -sideX * Math.sin(angle);
      const tangentZ = sideZ * Math.cos(angle);
      const yaw = Math.atan2(-tangentZ, tangentX);
      addBox('octagonal-corner', x, verticalCenter, z, arcHalfLength, verticalHalf, 0.25,
        quaternionFromAxisAngle({ x: 0, y: 1, z: 0 }, yaw));
    }
  }
  addMesh('floor-corner-ramp', RAPierArenaMeshes.floorCornerRamps);
  addMesh('roof-corner-ramp', RAPierArenaMeshes.roofCornerRamps);
  parts.add('octagonal-corners');

  return Object.freeze({
    version: RAPIER_ARENA_VERSION,
    field,
    colliders: Object.freeze(colliders),
    parts,
    renderMeshes: RAPierArenaMeshes
  });
}
