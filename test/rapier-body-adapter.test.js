import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, RapierBodyAdapter, Vec3 } from '../shared/rapier-body-adapter.js';

const close = (actual, expected, epsilon = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} ≈ ${expected}`);
};

const closeVec = (actual, expected, epsilon = 1e-12) => {
  close(actual.x, expected.x, epsilon);
  close(actual.y, expected.y, epsilon);
  close(actual.z, expected.z, epsilon);
};

test('Vec3 implements the mutable vector operations used by the simulation', () => {
  const vector = new Vec3(1, 2, 3);
  assert.equal(vector.set(4, 5, 6), vector);
  assert.deepEqual(vector.clone(), new Vec3(4, 5, 6));
  assert.equal(new Vec3().copy(vector).x, 4);

  const target = new Vec3();
  assert.equal(vector.vadd(new Vec3(1, -2, 3), target), target);
  assert.deepEqual(target, new Vec3(5, 3, 9));
  assert.deepEqual(vector.vsub(new Vec3(1, 2, 4)), new Vec3(3, 3, 2));
  assert.deepEqual(vector.scale(2), new Vec3(8, 10, 12));
  assert.equal(vector.dot(new Vec3(2, 0, -1)), 2);
  assert.deepEqual(new Vec3(1, 0, 0).cross(new Vec3(0, 1, 0)), new Vec3(0, 0, 1));
  assert.equal(new Vec3(2, 3, 6).lengthSquared(), 49);
  assert.equal(new Vec3(2, 3, 6).length(), 7);
  const normal = new Vec3(3, 0, 4);
  assert.equal(normal.normalize(), 5);
  closeVec(normal, { x: 0.6, y: 0, z: 0.8 });
  assert.equal(new Vec3().normalize(), 0);
  assert.deepEqual(vector.setZero(), new Vec3());
});

test('Quaternion implements XYZ Euler rotation, composition, vector rotation and slerp', () => {
  const yaw = new Quaternion().setFromEuler(0, Math.PI / 2, 0, 'XYZ');
  closeVec(yaw.vmult(new Vec3(1, 0, 0)), { x: 0, y: 0, z: -1 });

  const roll = new Quaternion().setFromAxisAngle(new Vec3(1, 0, 0), Math.PI / 2);
  const composed = yaw.mult(roll);
  closeVec(composed.vmult(new Vec3(0, 1, 0)), { x: 1, y: 0, z: 0 });
  assert.deepEqual(new Quaternion().copy(yaw).clone(), yaw);

  const aligned = new Quaternion().setFromVectors(new Vec3(0, 1, 0), new Vec3(0, 0, 1));
  closeVec(aligned.vmult(new Vec3(0, 1, 0)), { x: 0, y: 0, z: 1 });

  const halfway = new Quaternion();
  assert.equal(new Quaternion().slerp(yaw, 0.5, halfway), halfway);
  const diagonal = halfway.vmult(new Vec3(1, 0, 0));
  closeVec(diagonal, { x: Math.SQRT1_2, y: 0, z: -Math.SQRT1_2 });
  assert.throws(() => new Quaternion().setFromEuler(0, 0, 0, 'ZYX'), /XYZ/);
});

function fakeRigidBody() {
  const state = {
    translation: { x: 1, y: 2, z: 3 },
    linvel: { x: 4, y: 5, z: 6 },
    angvel: { x: 7, y: 8, z: 9 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    calls: []
  };
  const save = (name, value, wakeUp) => {
    state[name === 'setTranslation' ? 'translation' : name === 'setLinvel' ? 'linvel' : name === 'setAngvel' ? 'angvel' : 'rotation'] = { ...value };
    state.calls.push([name, { ...value }, wakeUp]);
  };
  return {
    state,
    translation: () => ({ ...state.translation }),
    linvel: () => ({ ...state.linvel }),
    angvel: () => ({ ...state.angvel }),
    rotation: () => ({ ...state.rotation }),
    setTranslation: (value, wakeUp) => save('setTranslation', value, wakeUp),
    setLinvel: (value, wakeUp) => save('setLinvel', value, wakeUp),
    setAngvel: (value, wakeUp) => save('setAngvel', value, wakeUp),
    setRotation: (value, wakeUp) => save('setRotation', value, wakeUp),
    applyImpulse: (value, wakeUp) => state.calls.push(['applyImpulse', { ...value }, wakeUp]),
    addForce: (value, wakeUp) => state.calls.push(['addForce', { ...value }, wakeUp]),
    addTorque: (value, wakeUp) => state.calls.push(['addTorque', { ...value }, wakeUp])
  };
}

test('RapierBodyAdapter turns direct component mutations into Rapier setters', () => {
  const rigidBody = fakeRigidBody();
  const body = new RapierBodyAdapter(rigidBody);

  body.position.x = 10;
  body.velocity.y *= 2;
  body.angularVelocity.setZero();
  body.quaternion.z = 0.5;

  assert.deepEqual(rigidBody.state.calls, [
    ['setTranslation', { x: 10, y: 2, z: 3 }, true],
    ['setLinvel', { x: 4, y: 10, z: 6 }, true],
    ['setAngvel', { x: 0, y: 0, z: 0 }, true],
    ['setRotation', { x: 0, y: 0, z: 0.5, w: 1 }, true]
  ]);

  rigidBody.state.translation = { x: -1, y: -2, z: -3 };
  assert.deepEqual(body.position.clone(), new Vec3(-1, -2, -3));
});

test('RapierBodyAdapter forwards impulses, forces and torques with Rapier wake-up semantics', () => {
  const rigidBody = fakeRigidBody();
  const body = new RapierBodyAdapter(rigidBody);

  body.applyImpulse(new Vec3(1, 2, 3), false);
  body.applyForce({ x: 4, y: 5, z: 6 });
  body.applyTorque(new Vec3(7, 8, 9), false);

  assert.deepEqual(rigidBody.state.calls, [
    ['applyImpulse', { x: 1, y: 2, z: 3 }, false],
    ['addForce', { x: 4, y: 5, z: 6 }, true],
    ['addTorque', { x: 7, y: 8, z: 9 }, false]
  ]);
});
