const changed = instance => instance._onChange?.(instance);

export class Vec3 {
  constructor(x = 0, y = 0, z = 0, onChange = null) {
    this._x = x;
    this._y = y;
    this._z = z;
    Object.defineProperty(this, '_onChange', { value: onChange, writable: true });
  }

  get x() { return this._x; }
  set x(value) { this._x = value; changed(this); }
  get y() { return this._y; }
  set y(value) { this._y = value; changed(this); }
  get z() { return this._z; }
  set z(value) { this._z = value; changed(this); }

  _setSilently(x, y, z) {
    this._x = x;
    this._y = y;
    this._z = z;
    return this;
  }

  set(x, y, z) {
    this._setSilently(x, y, z);
    changed(this);
    return this;
  }

  setZero() { return this.set(0, 0, 0); }

  copy(vector) { return this.set(vector.x, vector.y, vector.z); }

  clone() { return new Vec3(this.x, this.y, this.z); }

  vadd(vector, target = new Vec3()) {
    return target.set(this.x + vector.x, this.y + vector.y, this.z + vector.z);
  }

  vsub(vector, target = new Vec3()) {
    return target.set(this.x - vector.x, this.y - vector.y, this.z - vector.z);
  }

  scale(scalar, target = new Vec3()) {
    return target.set(this.x * scalar, this.y * scalar, this.z * scalar);
  }

  dot(vector) { return this.x * vector.x + this.y * vector.y + this.z * vector.z; }

  cross(vector, target = new Vec3()) {
    const x = this.y * vector.z - this.z * vector.y;
    const y = this.z * vector.x - this.x * vector.z;
    const z = this.x * vector.y - this.y * vector.x;
    return target.set(x, y, z);
  }

  lengthSquared() { return this.dot(this); }

  length() { return Math.sqrt(this.lengthSquared()); }

  normalize() {
    const length = this.length();
    if (length > 0) this.set(this.x / length, this.y / length, this.z / length);
    return length;
  }
}

export class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1, onChange = null) {
    this._x = x;
    this._y = y;
    this._z = z;
    this._w = w;
    Object.defineProperty(this, '_onChange', { value: onChange, writable: true });
  }

  get x() { return this._x; }
  set x(value) { this._x = value; changed(this); }
  get y() { return this._y; }
  set y(value) { this._y = value; changed(this); }
  get z() { return this._z; }
  set z(value) { this._z = value; changed(this); }
  get w() { return this._w; }
  set w(value) { this._w = value; changed(this); }

  _setSilently(x, y, z, w) {
    this._x = x;
    this._y = y;
    this._z = z;
    this._w = w;
    return this;
  }

  set(x, y, z, w) {
    this._setSilently(x, y, z, w);
    changed(this);
    return this;
  }

  copy(quaternion) {
    return this.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  }

  clone() { return new Quaternion(this.x, this.y, this.z, this.w); }

  setFromEuler(x, y, z, order = 'XYZ') {
    if (order !== 'XYZ') throw new RangeError('Quaternion.setFromEuler only supports XYZ order');
    const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
    const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    return this.set(
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3,
      c1 * c2 * c3 - s1 * s2 * s3
    );
  }

  setFromAxisAngle(axis, angle) {
    const halfAngle = angle / 2;
    const scale = Math.sin(halfAngle);
    return this.set(axis.x * scale, axis.y * scale, axis.z * scale, Math.cos(halfAngle));
  }

  setFromVectors(from, to) {
    const fromLength = from.length();
    const toLength = to.length();
    if (fromLength === 0 || toLength === 0) return this.set(0, 0, 0, 1);
    const ax = from.x / fromLength, ay = from.y / fromLength, az = from.z / fromLength;
    const bx = to.x / toLength, by = to.y / toLength, bz = to.z / toLength;
    const dot = ax * bx + ay * by + az * bz;
    if (dot < -0.999999) {
      let x = 0, y = az, z = -ay;
      if (Math.hypot(x, y, z) < 1e-6) { x = -az; y = 0; z = ax; }
      const length = Math.hypot(x, y, z);
      return this.set(x / length, y / length, z / length, 0);
    }
    const x = ay * bz - az * by;
    const y = az * bx - ax * bz;
    const z = ax * by - ay * bx;
    const w = 1 + dot;
    const inverseLength = 1 / Math.hypot(x, y, z, w);
    return this.set(x * inverseLength, y * inverseLength, z * inverseLength, w * inverseLength);
  }

  vmult(vector, target = new Vec3()) {
    const tx = 2 * (this.y * vector.z - this.z * vector.y);
    const ty = 2 * (this.z * vector.x - this.x * vector.z);
    const tz = 2 * (this.x * vector.y - this.y * vector.x);
    return target.set(
      vector.x + this.w * tx + this.y * tz - this.z * ty,
      vector.y + this.w * ty + this.z * tx - this.x * tz,
      vector.z + this.w * tz + this.x * ty - this.y * tx
    );
  }

  mult(quaternion, target = new Quaternion()) {
    const ax = this.x, ay = this.y, az = this.z, aw = this.w;
    const bx = quaternion.x, by = quaternion.y, bz = quaternion.z, bw = quaternion.w;
    return target.set(
      ax * bw + aw * bx + ay * bz - az * by,
      ay * bw + aw * by + az * bx - ax * bz,
      az * bw + aw * bz + ax * by - ay * bx,
      aw * bw - ax * bx - ay * by - az * bz
    );
  }

  slerp(to, t, target = new Quaternion()) {
    let bx = to.x, by = to.y, bz = to.z, bw = to.w;
    let cosine = this.x * bx + this.y * by + this.z * bz + this.w * bw;
    if (cosine < 0) {
      cosine = -cosine;
      bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    let fromScale, toScale;
    if (1 - cosine > 1e-8) {
      const angle = Math.acos(Math.min(1, cosine));
      const sine = Math.sin(angle);
      fromScale = Math.sin((1 - t) * angle) / sine;
      toScale = Math.sin(t * angle) / sine;
    } else {
      fromScale = 1 - t;
      toScale = t;
    }
    const x = fromScale * this.x + toScale * bx;
    const y = fromScale * this.y + toScale * by;
    const z = fromScale * this.z + toScale * bz;
    const w = fromScale * this.w + toScale * bw;
    const inverseLength = 1 / Math.hypot(x, y, z, w);
    return target.set(x * inverseLength, y * inverseLength, z * inverseLength, w * inverseLength);
  }
}

const rapierVector = vector => ({ x: vector.x, y: vector.y, z: vector.z });
const rapierQuaternion = quaternion => ({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });

export class RapierBodyAdapter {
  constructor(rigidBody) {
    if (!rigidBody) throw new TypeError('RapierBodyAdapter requires a Rapier rigid body');
    this.rigidBody = rigidBody;
    this._position = new Vec3(0, 0, 0, value => rigidBody.setTranslation(rapierVector(value), true));
    this._velocity = new Vec3(0, 0, 0, value => rigidBody.setLinvel(rapierVector(value), true));
    this._angularVelocity = new Vec3(0, 0, 0, value => rigidBody.setAngvel(rapierVector(value), true));
    this._quaternion = new Quaternion(0, 0, 0, 1, value => rigidBody.setRotation(rapierQuaternion(value), true));
  }

  get position() {
    const value = this.rigidBody.translation();
    return this._position._setSilently(value.x, value.y, value.z);
  }

  get velocity() {
    const value = this.rigidBody.linvel();
    return this._velocity._setSilently(value.x, value.y, value.z);
  }

  get angularVelocity() {
    const value = this.rigidBody.angvel();
    return this._angularVelocity._setSilently(value.x, value.y, value.z);
  }

  get quaternion() {
    const value = this.rigidBody.rotation();
    return this._quaternion._setSilently(value.x, value.y, value.z, value.w);
  }

  applyImpulse(impulse, wakeUp = true) {
    this.rigidBody.applyImpulse(rapierVector(impulse), wakeUp);
  }

  applyForce(force, wakeUp = true) {
    this.rigidBody.addForce(rapierVector(force), wakeUp);
  }

  applyTorque(torque, wakeUp = true) {
    this.rigidBody.addTorque(rapierVector(torque), wakeUp);
  }
}
