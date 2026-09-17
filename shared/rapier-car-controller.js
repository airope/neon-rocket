import { OCTANE_CLASS_CAR } from './car-soccer-contract.js';

export function rotateLocalVector(vector, quaternion) {
  const tx = 2 * (quaternion.y * vector.z - quaternion.z * vector.y);
  const ty = 2 * (quaternion.z * vector.x - quaternion.x * vector.z);
  const tz = 2 * (quaternion.x * vector.y - quaternion.y * vector.x);
  return {
    x: vector.x + quaternion.w * tx + quaternion.y * tz - quaternion.z * ty,
    y: vector.y + quaternion.w * ty + quaternion.z * tx - quaternion.x * tz,
    z: vector.z + quaternion.w * tz + quaternion.x * ty - quaternion.y * tx
  };
}

export function configureRaycastVehicle(world, chassis) {
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
  return vehicle;
}

export class RapierCarController {
  constructor(world, chassis, { boost = 33 } = {}) {
    this.world = world;
    this.chassis = chassis;
    this.vehicle = configureRaycastVehicle(world, chassis);
    this.input = { throttle: 0, steer: 0, brake: 0, boost: false, jump: false, airRoll: 0, handbrake: false };
    this.previousJump = false;
    this.jumpAvailable = true;
    this.secondJumpAvailable = true;
    this.jumpHoldRemaining = 0;
    this.airborneTicks = 0;
    this.boost = boost;
    this.boosting = false;
    this.lastSurfaceNormal = { x: 0, y: 1, z: 0 };
    this.surfaceGraceRemaining = 0;
    this.invertedContactTime = 0;
    this.selfRightingRemaining = 0;
  }

  setInput(nextInput) {
    this.input = { ...this.input, ...nextInput };
  }

  wheelContacts() {
    return Array.from({ length: this.vehicle.numWheels() }, (_, index) => this.vehicle.wheelIsInContact(index));
  }

  surfaceContact() {
    let x = 0, y = 0, z = 0, count = 0;
    for (let index = 0; index < this.vehicle.numWheels(); index++) {
      if (!this.vehicle.wheelIsInContact(index)) continue;
      const normal = this.vehicle.wheelContactNormal(index);
      if (!normal) continue;
      x += normal.x; y += normal.y; z += normal.z; count++;
    }
    const length = Math.hypot(x, y, z);
    return count && length > 1e-6 ? { count, normal: { x: x / length, y: y / length, z: z / length } } : null;
  }

  #applySurfaceAdhesion(dt) {
    const contact = this.surfaceContact();
    if (contact?.count >= 2) {
      this.lastSurfaceNormal = contact.normal;
      this.surfaceGraceRemaining = 0.1;
    } else this.surfaceGraceRemaining = Math.max(0, this.surfaceGraceRemaining - dt);
    if (Math.abs(this.input.throttle) < 0.1) return;
    const normal = contact?.count >= 2 ? contact.normal : this.surfaceGraceRemaining > 0 ? this.lastSurfaceNormal : null;
    if (!normal) return;
    const up = rotateLocalVector({ x: 0, y: 1, z: 0 }, this.chassis.rotation());
    const alignment = up.x * normal.x + up.y * normal.y + up.z * normal.z;
    if (alignment < 0.55) return;
    const strength = contact?.count >= 2 ? 8 : 3;
    const impulse = this.chassis.mass() * strength * dt;
    this.chassis.applyImpulse({ x: -normal.x * impulse, y: -normal.y * impulse, z: -normal.z * impulse }, true);
  }

  #applyOpposingThrottleBrake(dt, active) {
    if (!active || (this.surfaceContact()?.count ?? 0) < 2) return;
    const forward = rotateLocalVector({ x: 1, y: 0, z: 0 }, this.chassis.rotation());
    const velocity = this.chassis.linvel();
    const longitudinalSpeed = velocity.x * forward.x + velocity.y * forward.y + velocity.z * forward.z;
    const speedDelta = Math.min(Math.abs(longitudinalSpeed), 26 * dt);
    if (speedDelta <= 0) return;
    const impulse = -Math.sign(longitudinalSpeed) * this.chassis.mass() * speedDelta;
    this.chassis.applyImpulse({ x: forward.x * impulse, y: forward.y * impulse, z: forward.z * impulse }, true);
  }

  #bodyTouchesStaticSurface() {
    const collider = this.chassis.collider(0);
    if (!collider) return false;
    let touching = false;
    this.world.contactPairsWith(collider, other => {
      const parent = other.parent();
      if (!parent || parent.isFixed()) touching = true;
    });
    return touching;
  }

  #applySelfRighting(dt, grounded) {
    const rotation = this.chassis.rotation();
    const up = rotateLocalVector({ x: 0, y: 1, z: 0 }, rotation);
    const velocity = this.chassis.linvel();
    const angular = this.chassis.angvel();
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    const angularSpeed = Math.hypot(angular.x, angular.y, angular.z);
    if (grounded) {
      this.invertedContactTime = 0;
      this.selfRightingRemaining = 0;
      return;
    }
    if (up.y > 0.72) {
      if (this.selfRightingRemaining > 0) this.chassis.setAngvel({ x: angular.x * 0.25, y: angular.y * 0.25, z: angular.z * 0.25 }, true);
      this.invertedContactTime = 0;
      this.selfRightingRemaining = 0;
      return;
    }
    if (this.selfRightingRemaining <= 0) {
      const stuck = up.y < -0.35 && speed < 0.8 && angularSpeed < 0.6 && this.#bodyTouchesStaticSurface();
      this.invertedContactTime = stuck ? this.invertedContactTime + dt : 0;
      if (this.invertedContactTime < 0.35) return;
      this.invertedContactTime = 0;
      this.selfRightingRemaining = 1.6;
      this.chassis.applyImpulse({ x: 0, y: this.chassis.mass() * 3.5, z: 0 }, true);
    }
    this.selfRightingRemaining = Math.max(0, this.selfRightingRemaining - dt);
    let axis = { x: -up.z, y: 0, z: up.x };
    let axisLength = Math.hypot(axis.x, axis.z);
    if (axisLength < 0.12) {
      axis = rotateLocalVector({ x: 1, y: 0, z: 0 }, rotation);
      axisLength = Math.hypot(axis.x, axis.y, axis.z);
    }
    axis.x /= axisLength; axis.y /= axisLength; axis.z /= axisLength;
    const alongAxis = angular.x * axis.x + angular.y * axis.y + angular.z * axis.z;
    const correction = Math.max(-0.35, Math.min(0.35, 5 - alongAxis));
    this.chassis.setAngvel({
      x: angular.x + axis.x * correction,
      y: angular.y + axis.y * correction,
      z: angular.z + axis.z * correction
    }, true);
  }

  preStep(dt) {
    const input = this.input, chassis = this.chassis, vehicle = this.vehicle;
    const grounded = this.wheelContacts().filter(Boolean).length >= 2;
    this.#applySelfRighting(dt, grounded);
    if (grounded && !input.jump) {
      this.jumpAvailable = true;
      this.secondJumpAvailable = true;
    }
    const jumpPressed = input.jump && !this.previousJump;
    if (jumpPressed && grounded && this.jumpAvailable) {
      const up = rotateLocalVector({ x: 0, y: 1, z: 0 }, chassis.rotation());
      const impulse = chassis.mass() * 5.8;
      chassis.applyImpulse({ x: up.x * impulse, y: up.y * impulse, z: up.z * impulse }, true);
      this.jumpAvailable = false;
      this.jumpHoldRemaining = 0.2;
    } else if (jumpPressed && !grounded && this.secondJumpAvailable) {
      const rotation = chassis.rotation();
      const forward = rotateLocalVector({ x: 1, y: 0, z: 0 }, rotation);
      const right = rotateLocalVector({ x: 0, y: 0, z: 1 }, rotation);
      const up = rotateLocalVector({ x: 0, y: 1, z: 0 }, rotation);
      const magnitude = Math.hypot(input.throttle, input.steer);
      if (magnitude >= OCTANE_CLASS_CAR.dodgeDeadzone) {
        const forwardAmount = input.throttle / magnitude, rightAmount = input.steer / magnitude;
        const impulse = chassis.mass() * 6.5, lift = chassis.mass() * 1.2;
        chassis.applyImpulse({
          x: (forward.x * forwardAmount + right.x * rightAmount) * impulse + up.x * lift,
          y: (forward.y * forwardAmount + right.y * rightAmount) * impulse + up.y * lift,
          z: (forward.z * forwardAmount + right.z * rightAmount) * impulse + up.z * lift
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
      this.secondJumpAvailable = false;
      this.jumpHoldRemaining = 0;
    }
    if (input.jump && this.jumpHoldRemaining > 0) {
      const up = rotateLocalVector({ x: 0, y: 1, z: 0 }, chassis.rotation());
      const impulse = chassis.mass() * 8 * dt;
      chassis.applyImpulse({ x: up.x * impulse, y: up.y * impulse, z: up.z * impulse }, true);
      this.jumpHoldRemaining = Math.max(0, this.jumpHoldRemaining - dt);
    } else if (!input.jump) this.jumpHoldRemaining = 0;

    if (!grounded) {
      const rotation = chassis.rotation();
      const forward = rotateLocalVector({ x: 1, y: 0, z: 0 }, rotation);
      const up = rotateLocalVector({ x: 0, y: 1, z: 0 }, rotation);
      const right = rotateLocalVector({ x: 0, y: 0, z: 1 }, rotation);
      const pitch = -input.throttle * 0.45, yaw = -input.steer * 0.32, roll = input.airRoll * 0.25;
      chassis.applyTorqueImpulse({
        x: right.x * pitch + up.x * yaw + forward.x * roll,
        y: right.y * pitch + up.y * yaw + forward.y * roll,
        z: right.z * pitch + up.z * yaw + forward.z * roll
      }, true);
    }

    this.boosting = false;
    if (input.boost && this.boost > 0) {
      const forward = rotateLocalVector({ x: 1, y: 0, z: 0 }, chassis.rotation());
      const impulse = chassis.mass() * 18 * dt;
      chassis.applyImpulse({ x: forward.x * impulse, y: forward.y * impulse, z: forward.z * impulse }, true);
      this.boost = Math.max(0, this.boost - 33.3 * dt);
      this.boosting = true;
    }

    const signedVehicleSpeed = vehicle.currentVehicleSpeed();
    const driveSurface = this.surfaceContact();
    const opposingThrottle = Math.abs(input.throttle) > 0.05
      && (driveSurface?.normal.y ?? 0) > 0.8
      && Math.abs(signedVehicleSpeed) > 0.75
      && input.throttle * signedVehicleSpeed < 0;
    const engineForce = !opposingThrottle && Math.abs(signedVehicleSpeed) < 23 ? input.throttle * 520 : 0;
    for (let index = 0; index < vehicle.numWheels(); index++) {
      vehicle.setWheelEngineForce(index, engineForce);
      vehicle.setWheelBrake(index, Math.max(input.brake * 9, opposingThrottle ? 9 : 0));
      vehicle.setWheelSteering(index, index < 2 ? input.steer * 0.38 : 0);
      vehicle.setWheelSideFrictionStiffness(index, input.handbrake ? (index < 2 ? 0.45 : 0.12) : 1.8);
    }
    vehicle.updateVehicle(dt);
    if (input.handbrake && this.surfaceContact()?.count >= 2) {
      const up = rotateLocalVector({ x: 0, y: 1, z: 0 }, this.chassis.rotation());
      this.chassis.applyTorqueImpulse({ x: up.x * input.steer * 0.18, y: up.y * input.steer * 0.18, z: up.z * input.steer * 0.18 }, true);
      const slideVelocity = this.chassis.linvel();
      const normalSpeed = slideVelocity.x * up.x + slideVelocity.y * up.y + slideVelocity.z * up.z;
      const tangent = {
        x: slideVelocity.x - up.x * normalSpeed,
        y: slideVelocity.y - up.y * normalSpeed,
        z: slideVelocity.z - up.z * normalSpeed
      };
      const tangentSpeed = Math.hypot(tangent.x, tangent.y, tangent.z);
      if (tangentSpeed > 1) {
        const sustainImpulse = this.chassis.mass() * 6.5 * dt / tangentSpeed;
        this.chassis.applyImpulse({ x: tangent.x * sustainImpulse, y: tangent.y * sustainImpulse, z: tangent.z * sustainImpulse }, true);
      }
    }
    this.#applyOpposingThrottleBrake(dt, opposingThrottle);
    this.#applySurfaceAdhesion(dt);
    this.previousJump = input.jump;
  }

  postStep() {
    const angular = this.chassis.angvel();
    const angularSpeed = Math.hypot(angular.x, angular.y, angular.z);
    if (angularSpeed > 5.5) this.chassis.setAngvel({
      x: angular.x * 5.5 / angularSpeed,
      y: angular.y * 5.5 / angularSpeed,
      z: angular.z * 5.5 / angularSpeed
    }, true);
    const velocity = this.chassis.linvel();
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    if (speed > 32) this.chassis.setLinvel({ x: velocity.x * 32 / speed, y: velocity.y * 32 / speed, z: velocity.z * 32 / speed }, true);
    if (!this.wheelContacts().some(Boolean)) this.airborneTicks++;
  }

  reset({ boost = 33 } = {}) {
    this.previousJump = false;
    this.jumpAvailable = true;
    this.secondJumpAvailable = true;
    this.jumpHoldRemaining = 0;
    this.airborneTicks = 0;
    this.boost = boost;
    this.boosting = false;
    this.lastSurfaceNormal = { x: 0, y: 1, z: 0 };
    this.surfaceGraceRemaining = 0;
    this.invertedContactTime = 0;
    this.selfRightingRemaining = 0;
    this.setInput({ throttle: 0, steer: 0, brake: 0, boost: false, jump: false, airRoll: 0, handbrake: false });
  }

  telemetry() {
    return {
      airborneTicks: this.airborneTicks,
      jumpAvailable: this.jumpAvailable,
      secondJumpAvailable: this.secondJumpAvailable,
      jumpHoldRemaining: this.jumpHoldRemaining,
      boost: this.boost,
      boosting: this.boosting,
      contacts: this.wheelContacts()
    };
  }
}
