import { CAR_SOCCER_FIELD } from './car-soccer-contract.js';

const BOX_CORNERS = [
  [-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],
  [-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]
];
const BOX_FACES = [
  [0,3,2,0,2,1], [4,5,6,4,6,7],
  [0,4,7,0,7,3], [1,2,6,1,6,5],
  [0,1,5,0,5,4], [3,7,6,3,6,2]
];

function rotateAxisAngle([x, y, z], axis, angle) {
  if (!axis || !angle) return [x, y, z];
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  const dot = x * axis.x + y * axis.y + z * axis.z;
  return [
    x * cosine + (axis.y * z - axis.z * y) * sine + axis.x * dot * (1 - cosine),
    y * cosine + (axis.z * x - axis.x * z) * sine + axis.y * dot * (1 - cosine),
    z * cosine + (axis.x * y - axis.y * x) * sine + axis.z * dot * (1 - cosine)
  ];
}

export function buildCarSoccerArenaMesh({ cornerSegments = 12 } = {}) {
  const field = CAR_SOCCER_FIELD;
  const vertices = [], indices = [];
  const addBox = (center, half, rotation = null) => {
    const base = vertices.length / 3;
    for (const corner of BOX_CORNERS) {
      const local = [corner[0] * half.x, corner[1] * half.y, corner[2] * half.z];
      const rotated = rotation ? rotateAxisAngle(local, rotation.axis, rotation.angle) : local;
      vertices.push(center.x + rotated[0], center.y + rotated[1], center.z + rotated[2]);
    }
    for (const face of BOX_FACES) for (const index of face) indices.push(base + index);
  };
  const addCornerRamp = (roof = false) => {
    const innerRadius = field.cornerRadius - field.floorCurveRadius;
    for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) {
      const base = vertices.length / 3;
      const centerX = sideX * (field.halfLength - field.cornerRadius);
      const centerZ = sideZ * (field.halfWidth - field.cornerRadius);
      for (let radial = 0; radial <= 1; radial++) {
        const radius = innerRadius + radial * field.floorCurveRadius;
        const height = radial === 0 ? 0 : field.floorCurveRadius;
        const y = roof ? field.ceiling - height : height;
        for (let index = 0; index <= cornerSegments; index++) {
          const angle = index / cornerSegments * Math.PI / 2;
          vertices.push(centerX + sideX * Math.cos(angle) * radius, y, centerZ + sideZ * Math.sin(angle) * radius);
        }
      }
      for (let index = 0; index < cornerSegments; index++) {
        const inner = base + index, outer = base + cornerSegments + 1 + index;
        if (roof) indices.push(inner, outer + 1, outer, inner, inner + 1, outer + 1);
        else indices.push(inner, outer, outer + 1, inner, outer + 1, inner + 1);
      }
    }
  };

  const shell = 2;
  addBox({ x: 0, y: -.25, z: 0 }, { x: field.halfLength + field.goalDepth + shell, y: .25, z: field.halfWidth + shell });
  addBox({ x: 0, y: field.ceiling + .25, z: 0 }, { x: field.halfLength + field.goalDepth + shell, y: .25, z: field.halfWidth + shell });

  const bank = field.floorCurveRadius;
  const bankLength = Math.SQRT2 * bank;
  const verticalCenter = field.ceiling / 2;
  const verticalHalf = (field.ceiling - bank * 2) / 2;
  const straightHalfLength = field.halfLength - field.cornerRadius;
  for (const side of [-1, 1]) {
    addBox({ x: 0, y: verticalCenter, z: side * (field.halfWidth + .25) }, { x: straightHalfLength, y: verticalHalf, z: .25 });
    addBox({ x: 0, y: bank / 2, z: side * (field.halfWidth - bank / 2) }, { x: straightHalfLength, y: .14, z: bankLength / 2 }, { axis: { x: 1, y: 0, z: 0 }, angle: -side * Math.PI / 4 });
    addBox({ x: 0, y: field.ceiling - bank / 2, z: side * (field.halfWidth - bank / 2) }, { x: straightHalfLength, y: .14, z: bankLength / 2 }, { axis: { x: 1, y: 0, z: 0 }, angle: side * Math.PI / 4 });
  }

  const flankWidth = (field.halfWidth - field.cornerRadius - field.goalHalfWidth) / 2;
  const flankCenter = field.goalHalfWidth + flankWidth;
  for (const side of [-1, 1]) {
    for (const sideZ of [-1, 1]) {
      addBox({ x: side * (field.halfLength + .25), y: verticalCenter, z: sideZ * flankCenter }, { x: .25, y: verticalHalf, z: flankWidth });
      addBox({ x: side * (field.halfLength - bank / 2), y: bank / 2, z: sideZ * flankCenter }, { x: bankLength / 2, y: .14, z: flankWidth }, { axis: { x: 0, y: 0, z: 1 }, angle: side * Math.PI / 4 });
      addBox({ x: side * (field.halfLength - bank / 2), y: field.ceiling - bank / 2, z: sideZ * flankCenter }, { x: bankLength / 2, y: .14, z: flankWidth }, { axis: { x: 0, y: 0, z: 1 }, angle: -side * Math.PI / 4 });
    }
    const upperHalf = (field.ceiling - field.goalHeight) / 2;
    addBox({ x: side * (field.halfLength + .25), y: field.goalHeight + upperHalf, z: 0 }, { x: .25, y: upperHalf, z: field.goalHalfWidth });
    const goalCenterX = side * (field.halfLength + field.goalDepth / 2);
    addBox({ x: side * (field.halfLength + field.goalDepth), y: field.goalHeight / 2, z: 0 }, { x: .25, y: field.goalHeight / 2, z: field.goalHalfWidth + .4 });
    addBox({ x: goalCenterX, y: field.goalHeight / 2, z: field.goalHalfWidth + .25 }, { x: field.goalDepth / 2, y: field.goalHeight / 2, z: .25 });
    addBox({ x: goalCenterX, y: field.goalHeight / 2, z: -field.goalHalfWidth - .25 }, { x: field.goalDepth / 2, y: field.goalHeight / 2, z: .25 });
    addBox({ x: goalCenterX, y: field.goalHeight + .25, z: 0 }, { x: field.goalDepth / 2, y: .25, z: field.goalHalfWidth + .5 });
  }

  const arcStep = Math.PI / 2 / 8;
  const arcHalfLength = field.cornerRadius * Math.sin(arcStep / 2) * 1.02;
  for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) {
    const centerX = sideX * (field.halfLength - field.cornerRadius);
    const centerZ = sideZ * (field.halfWidth - field.cornerRadius);
    for (let index = 0; index < 8; index++) {
      const angle = (index + .5) * arcStep;
      const x = centerX + sideX * Math.cos(angle) * (field.cornerRadius + .25);
      const z = centerZ + sideZ * Math.sin(angle) * (field.cornerRadius + .25);
      const tangentX = -sideX * Math.sin(angle), tangentZ = sideZ * Math.cos(angle);
      const yaw = Math.atan2(-tangentZ, tangentX);
      addBox({ x, y: verticalCenter, z }, { x: arcHalfLength, y: verticalHalf, z: .25 }, { axis: { x: 0, y: 1, z: 0 }, angle: yaw });
    }
  }
  addCornerRamp(false);
  addCornerRamp(true);

  return Object.freeze({
    version: 'neon-prism-bowl-trimesh-v1',
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices)
  });
}
