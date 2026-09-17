import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { CAR_SOCCER_FIELD, OCTANE_CLASS_CAR } from './car-soccer-contract.js';

await RAPIER.init({});

export const ENGINE_CONTRACT = Object.freeze({
  id: 'rapier3d-deterministic',
  version: '0.19.3',
  tickRate: 120,
  vehicleModel: 'four-wheel-raycast-suspension'
});

function rotateVector(vector, quaternion) {
  const tx = 2 * (quaternion.y * vector.z - quaternion.z * vector.y);
  const ty = 2 * (quaternion.z * vector.x - quaternion.x * vector.z);
  const tz = 2 * (quaternion.x * vector.y - quaternion.y * vector.x);
  return {
    x: vector.x + quaternion.w * tx + quaternion.y * tz - quaternion.z * ty,
    y: vector.y + quaternion.w * ty + quaternion.z * tx - quaternion.x * tz,
    z: vector.z + quaternion.w * tz + quaternion.x * ty - quaternion.y * tx
  };
}

export function createVehiclePhysicsHarness() {
  const dt = 1 / ENGINE_CONTRACT.tickRate;
  const world = new RAPIER.World({ x: 0, y: -13, z: 0 });
  world.timestep = dt;
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(CAR_SOCCER_FIELD.halfLength + 10, 0.25, CAR_SOCCER_FIELD.halfWidth + 10)
      .setTranslation(0, -0.25, 0)
      .setFriction(1)
  );
  const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 0.65, 0)
      .setCanSleep(false)
      .setLinearDamping(0.08)
      .setAngularDamping(0.16)
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(
      OCTANE_CLASS_CAR.hitboxSize.x / 2,
      OCTANE_CLASS_CAR.hitboxSize.y / 2,
      OCTANE_CLASS_CAR.hitboxSize.z / 2
    )
      .setTranslation(
        OCTANE_CLASS_CAR.hitboxOffset.x,
        OCTANE_CLASS_CAR.hitboxOffset.y,
        OCTANE_CLASS_CAR.hitboxOffset.z
      )
      .setMass(OCTANE_CLASS_CAR.mass)
      .setFriction(0.15),
    chassis
  );
  const vehicle = world.createVehicleController(chassis);
  vehicle.indexUpAxis = 1;
  vehicle.setIndexForwardAxis = 0;
  for (const wheelConfig of OCTANE_CLASS_CAR.wheels) {
    vehicle.addWheel(
      { x: wheelConfig.x, y: wheelConfig.y, z: wheelConfig.z },
      { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: 1 },
      wheelConfig.suspensionRest,
      wheelConfig.radius
    );
    const wheel = vehicle.numWheels() - 1;
    vehicle.setWheelSuspensionStiffness(wheel, 34);
    vehicle.setWheelSuspensionCompression(wheel, 4.4);
    vehicle.setWheelSuspensionRelaxation(wheel, 5);
    vehicle.setWheelMaxSuspensionTravel(wheel, 0.22);
    vehicle.setWheelMaxSuspensionForce(wheel, 8000);
    vehicle.setWheelFrictionSlip(wheel, 3.2);
    vehicle.setWheelSideFrictionStiffness(wheel, 1.8);
  }
  let input = { throttle: 0, steer: 0, brake: 0, boost: false, jump: false, airRoll: 0 };
  let previousJump = false, jumpAvailable = true, secondJumpAvailable = true, jumpHoldRemaining = 0, airborneTicks = 0, boost = 100;
  return {
    world,
    chassis,
    vehicle,
    step() {
      const groundedBeforeStep = Array.from(
        { length: vehicle.numWheels() },
        (_, index) => vehicle.wheelIsInContact(index)
      ).filter(Boolean).length >= 2;
      if (groundedBeforeStep && !input.jump) {
        jumpAvailable = true;
        secondJumpAvailable = true;
      }
      const jumpPressed = input.jump && !previousJump;
      if (jumpPressed && groundedBeforeStep && jumpAvailable) {
        const up = rotateVector({ x: 0, y: 1, z: 0 }, chassis.rotation());
        const impulse = chassis.mass() * 5.8;
        chassis.applyImpulse({ x: up.x * impulse, y: up.y * impulse, z: up.z * impulse }, true);
        jumpAvailable = false;
        jumpHoldRemaining = 0.2;
      } else if (jumpPressed && !groundedBeforeStep && secondJumpAvailable) {
        const rotation = chassis.rotation();
        const forward = rotateVector({ x: 1, y: 0, z: 0 }, rotation);
        const right = rotateVector({ x: 0, y: 0, z: 1 }, rotation);
        const up = rotateVector({ x: 0, y: 1, z: 0 }, rotation);
        const directionLength = Math.hypot(input.throttle, input.steer);
        if (directionLength >= OCTANE_CLASS_CAR.dodgeDeadzone) {
          const forwardAmount = input.throttle / directionLength;
          const rightAmount = input.steer / directionLength;
          const impulse = chassis.mass() * 6.5;
          chassis.applyImpulse({
            x: (forward.x * forwardAmount + right.x * rightAmount) * impulse + up.x * chassis.mass() * 1.2,
            y: (forward.y * forwardAmount + right.y * rightAmount) * impulse + up.y * chassis.mass() * 1.2,
            z: (forward.z * forwardAmount + right.z * rightAmount) * impulse + up.z * chassis.mass() * 1.2
          }, true);
          chassis.applyTorqueImpulse({
            x: right.x * (-forwardAmount * 45) + forward.x * (rightAmount * 45),
            y: right.y * (-forwardAmount * 45) + forward.y * (rightAmount * 45),
            z: right.z * (-forwardAmount * 45) + forward.z * (rightAmount * 45)
          }, true);
        } else {
          const impulse = chassis.mass() * 5.2;
          chassis.applyImpulse({ x: up.x * impulse, y: up.y * impulse, z: up.z * impulse }, true);
        }
        secondJumpAvailable = false;
        jumpHoldRemaining = 0;
      }
      if (input.jump && jumpHoldRemaining > 0) {
        const up = rotateVector({ x: 0, y: 1, z: 0 }, chassis.rotation());
        const impulse = chassis.mass() * 8 * dt;
        chassis.applyImpulse({ x: up.x * impulse, y: up.y * impulse, z: up.z * impulse }, true);
        jumpHoldRemaining = Math.max(0, jumpHoldRemaining - dt);
      } else if (!input.jump) jumpHoldRemaining = 0;
      if (!groundedBeforeStep) {
        const rotation = chassis.rotation();
        const forward = rotateVector({ x: 1, y: 0, z: 0 }, rotation);
        const up = rotateVector({ x: 0, y: 1, z: 0 }, rotation);
        const right = rotateVector({ x: 0, y: 0, z: 1 }, rotation);
        const pitch = -input.throttle * 0.45;
        const yaw = -input.steer * 0.32;
        const roll = input.airRoll * 0.25;
        chassis.applyTorqueImpulse({
          x: right.x * pitch + up.x * yaw + forward.x * roll,
          y: right.y * pitch + up.y * yaw + forward.y * roll,
          z: right.z * pitch + up.z * yaw + forward.z * roll
        }, true);
      }
      if (input.boost && boost > 0) {
        const forward = rotateVector({ x: 1, y: 0, z: 0 }, chassis.rotation());
        const boostImpulse = chassis.mass() * 18 * dt;
        chassis.applyImpulse({ x: forward.x * boostImpulse, y: forward.y * boostImpulse, z: forward.z * boostImpulse }, true);
        boost = Math.max(0, boost - 33.3 * dt);
      }
      const speed = Math.abs(vehicle.currentVehicleSpeed());
      const engineForce = speed < 23 ? input.throttle * 520 : 0;
      for (let index = 0; index < vehicle.numWheels(); index++) {
        vehicle.setWheelEngineForce(index, engineForce);
        vehicle.setWheelBrake(index, input.brake ? 9 : 0);
        vehicle.setWheelSteering(index, index < 2 ? input.steer * 0.38 : 0);
      }
      vehicle.updateVehicle(dt);
      world.step();
      const angularVelocity = chassis.angvel();
      const angularSpeed = Math.hypot(angularVelocity.x, angularVelocity.y, angularVelocity.z);
      if (angularSpeed > 5.5) chassis.setAngvel({
        x: angularVelocity.x * 5.5 / angularSpeed,
        y: angularVelocity.y * 5.5 / angularSpeed,
        z: angularVelocity.z * 5.5 / angularSpeed
      }, true);
      if (!Array.from({ length: vehicle.numWheels() }, (_, index) => vehicle.wheelIsInContact(index)).some(Boolean)) airborneTicks++;
      previousJump = input.jump;
    },
    setInput(nextInput) {
      input = { ...input, ...nextInput };
    },
    wheelContacts() {
      return Array.from({ length: vehicle.numWheels() }, (_, index) => vehicle.wheelIsInContact(index));
    },
    telemetry() {
      return { airborneTicks, jumpAvailable, secondJumpAvailable, jumpHoldRemaining, boost };
    },
    free() {
      world.free();
    }
  };
}

export { RAPIER };
