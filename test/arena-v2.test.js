import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ARENA_VERSION,
  CAR,
  FIELD,
  curveHeight,
  transitionPoint,
  roundedCornerPoint
} from '../shared/arena-geometry.js';

test('Neon V2 exposes one versioned arena contract for physics and rendering', () => {
  assert.equal(ARENA_VERSION, 'neon-hyperdome-v2');
  assert.deepEqual(FIELD, {
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
  const simulationSource = readFileSync(new URL('../shared/simulation.js', import.meta.url), 'utf8');
  const renderSource = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  assert.match(simulationSource, /from '\.\/arena-geometry\.js'/);
  assert.match(renderSource, /from '\/shared\/arena-geometry\.js/);
});

test('floor-wall profile is continuous at the floor, wall and mirrored roof', () => {
  assert.equal(curveHeight(0), 0);
  assert.equal(curveHeight(FIELD.curveRadius), FIELD.curveRadius);
  const floorStart = transitionPoint(0, false);
  const floorEnd = transitionPoint(1, false);
  const roofStart = transitionPoint(0, true);
  const roofEnd = transitionPoint(1, true);
  assert.deepEqual(floorStart, { inset: FIELD.curveRadius, y: 0 });
  assert.ok(Math.abs(floorEnd.inset) < 1e-12);
  assert.ok(Math.abs(floorEnd.y - FIELD.curveRadius) < 1e-12);
  assert.ok(Math.abs(roofStart.y - FIELD.ceilingY) < 1e-12);
  assert.ok(Math.abs(roofEnd.y - (FIELD.ceilingY - FIELD.curveRadius)) < 1e-12);
});

test('rounded corner patch shares exact endpoints with both straight transitions', () => {
  const sideX = 1, sideZ = 1;
  const sideEndpoint = roundedCornerPoint({ sideX, sideZ, phi: 0, theta: 1, top: false });
  const endEndpoint = roundedCornerPoint({ sideX, sideZ, phi: 1, theta: 1, top: false });
  assert.ok(Math.abs(sideEndpoint.x - FIELD.halfX) < 1e-9);
  assert.ok(Math.abs(sideEndpoint.z - (FIELD.halfZ - FIELD.cornerRadius)) < 1e-9);
  assert.ok(Math.abs(endEndpoint.x - (FIELD.halfX - FIELD.cornerRadius)) < 1e-9);
  assert.ok(Math.abs(endEndpoint.z - FIELD.halfZ) < 1e-9);
  assert.ok(Math.abs(sideEndpoint.y - FIELD.curveRadius) < 1e-12);
  assert.ok(Math.abs(endEndpoint.y - FIELD.curveRadius) < 1e-12);
});

test('Aegis V2 visual dimensions are derived from the exact compound hitbox envelope', () => {
  assert.deepEqual(CAR.chassisHalf, { x: 1.45, y: 0.68, z: 0.88 });
  assert.deepEqual(CAR.bumperHalf, { x: 0.22, y: 0.32, z: 0.78 });
  assert.deepEqual(CAR.bumperOffset, { x: 1.55, y: -0.16, z: 0 });
  assert.equal(CAR.wheelRadius, 0.5);
  assert.ok(Math.abs((CAR.wheelCenterY - CAR.wheelRadius) + CAR.chassisHalf.y) < 1e-12);
  assert.ok(CAR.frontExtent >= CAR.bumperOffset.x + CAR.bumperHalf.x);
  assert.equal(CAR.rearExtent, -CAR.chassisHalf.x);
  assert.ok(CAR.wheelX + CAR.wheelRadius <= CAR.chassisHalf.x);
  assert.ok(CAR.wheelCenterY - CAR.wheelRadius >= -CAR.chassisHalf.y - 1e-12);
  assert.ok(CAR.wheelCenterY + CAR.wheelRadius <= CAR.chassisHalf.y);
  assert.ok(CAR.wheelZ + CAR.wheelWidth / 2 + .04 <= CAR.chassisHalf.z);

  const simulationSource = readFileSync(new URL('../shared/simulation.js', import.meta.url), 'utf8');
  const renderSource = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  assert.match(simulationSource, /CAR\.chassisHalf/);
  assert.match(simulationSource, /CAR\.bumperHalf/);
  assert.match(renderSource, /CAR\.wheelRadius/);
  assert.match(renderSource, /neonAegisShell/);
  assert.match(renderSource, /wheelArch/);
});

test('V2 rendering uses canonical arena coordinates without hidden collider offsets', () => {
  const source = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  const simulationSource = readFileSync(new URL('../shared/simulation.js', import.meta.url), 'utf8');
  const curves = source.slice(source.indexOf('function buildSmoothArenaCurves'), source.indexOf('function glowBox'));
  assert.doesNotMatch(curves, /\.02|lift/);
  assert.match(source, /polygonOffset: true/);
  assert.match(source, /const mouthX = side \* FIELD\.halfX, depth = FIELD\.goalDepth/);
  assert.match(simulationSource, /p\.body\.aabbNeedsUpdate = true/);
});

test('V3 chase camera frames the compact physical car without an extreme wide angle', () => {
  const source = readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  assert.match(source, /cameraDistance = 4\.3/);
  assert.match(source, /PerspectiveCamera\(70,/);
  assert.match(source, /function clampCameraInsideArena/);
  assert.match(source, /clampCameraInsideArena\(desired, 6\)/);
  assert.match(source, /cameraRaycaster\.near = \.15/);
});
