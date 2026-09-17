import createRocketSimRawModule from './rocketsim-raw.mjs';

const bool = value => Boolean(value);
const UU_PER_METER = 100;
const fromRocketSimVector = (x, y, z, scale = UU_PER_METER) => ({
  x: y / scale,
  y: z / scale,
  z: x / scale
});
const toRocketSimVector = ({ x = 0, y = 0, z = 0 } = {}, scale = UU_PER_METER) => ({
  x: z * scale,
  y: x * scale,
  z: y * scale
});

export async function createRocketSimModule(options = {}) {
  const raw = await createRocketSimRawModule(options);
  if (!raw._rs_init()) throw new Error('RocketSim failed to initialize');

  const stateFloatCount = raw._rs_state_float_count();
  const stateBytes = stateFloatCount * Float32Array.BYTES_PER_ELEMENT;
  const ballStateFloatCount = raw._rs_ball_state_float_count();
  const ballStateBytes = ballStateFloatCount * Float32Array.BYTES_PER_ELEMENT;

  function createCar(handle) {
    let statePointer = raw._malloc(stateBytes);
    return {
      setState({ position, velocity, yaw = 0, boost = 33 } = {}) {
        const p = toRocketSimVector(position);
        const v = toRocketSimVector(velocity);
        raw._rs_set_car_state(
          handle,
          p.x, p.y, p.z,
          v.x, v.y, v.z,
          Math.sin(yaw), Math.cos(yaw),
          boost
        );
      },
      setBoost(boost) {
        raw._rs_set_car_boost(handle, Math.max(0, Math.min(100, boost)));
      },
      setControls(controls = {}) {
        raw._rs_set_controls(
          handle,
          controls.throttle ?? 0,
          controls.steer ?? 0,
          controls.pitch ?? 0,
          controls.yaw ?? 0,
          controls.roll ?? 0,
          bool(controls.jump),
          bool(controls.boost),
          bool(controls.handbrake)
        );
      },
      getState() {
        if (!statePointer) throw new Error('Car handle belongs to a destroyed arena');
        raw._rs_write_car_state(handle, statePointer);
        const s = raw.HEAPF32.subarray(statePointer >> 2, (statePointer >> 2) + stateFloatCount);
        return {
          tickCount: s[0],
          position: fromRocketSimVector(s[1], s[2], s[3]),
          velocity: fromRocketSimVector(s[4], s[5], s[6]),
          angularVelocity: fromRocketSimVector(s[7], s[8], s[9], 1),
          rotation: {
            forward: fromRocketSimVector(s[10], s[11], s[12], 1),
            right: fromRocketSimVector(s[13], s[14], s[15], 1),
            up: fromRocketSimVector(s[16], s[17], s[18], 1)
          },
          boost: s[19],
          isOnGround: bool(s[20]),
          wheelContactCount: s[21],
          hasJumped: bool(s[22]),
          hasDoubleJumped: bool(s[23]),
          hasFlipped: bool(s[24]),
          isJumping: bool(s[25]),
          isFlipping: bool(s[26]),
          isBoosting: bool(s[27]),
          lastControls: {
            throttle: s[28], steer: s[29], pitch: s[30], yaw: s[31], roll: s[32],
            jump: bool(s[33]), boost: bool(s[34]), handbrake: bool(s[35])
          },
          airTimeSinceJump: s[36],
          jumpTime: s[37],
          flipTime: s[38],
          handbrake: s[39]
        };
      },
      _release() {
        if (statePointer) raw._free(statePointer);
        statePointer = 0;
      }
    };
  }

  function createBall(handle) {
    let statePointer = raw._malloc(ballStateBytes);
    return {
      setState({ position, velocity } = {}) {
        const p = toRocketSimVector(position);
        const v = toRocketSimVector(velocity);
        raw._rs_set_ball_state(handle, p.x, p.y, p.z, v.x, v.y, v.z);
      },
      getState() {
        if (!statePointer) throw new Error('Ball handle belongs to a destroyed arena');
        raw._rs_write_ball_state(handle, statePointer);
        const s = raw.HEAPF32.subarray(statePointer >> 2, (statePointer >> 2) + ballStateFloatCount);
        return {
          tickCount: s[0],
          position: fromRocketSimVector(s[1], s[2], s[3]),
          velocity: fromRocketSimVector(s[4], s[5], s[6]),
          angularVelocity: fromRocketSimVector(s[7], s[8], s[9], 1)
        };
      },
      _release() {
        if (statePointer) raw._free(statePointer);
        statePointer = 0;
      }
    };
  }

  return {
    createArena({ tickRate = 120, halfLength = 51.2, halfWidth = 40.96, ceiling = 20.44, simpleBounds = true } = {}) {
      const handle = raw._rs_create_arena(
        tickRate,
        halfLength * UU_PER_METER,
        halfWidth * UU_PER_METER,
        ceiling * UU_PER_METER,
        bool(simpleBounds)
      );
      if (!handle) throw new Error('RocketSim failed to create arena');
      const cars = [];
      const ball = createBall(raw._rs_get_ball(handle));
      let alive = true;
      return {
        ball,
        addStaticMesh({ vertices, indices }) {
          if (!alive) throw new Error('Arena is destroyed');
          if (!(vertices instanceof Float32Array) || !(indices instanceof Uint32Array)) {
            throw new TypeError('Static mesh requires Float32Array vertices and Uint32Array indices');
          }
          const rocketSimVertices = new Float32Array(vertices.length);
          for (let index = 0; index < vertices.length; index += 3) {
            rocketSimVertices[index] = vertices[index + 2] * UU_PER_METER;
            rocketSimVertices[index + 1] = vertices[index] * UU_PER_METER;
            rocketSimVertices[index + 2] = vertices[index + 1] * UU_PER_METER;
          }
          const vertexPointer = raw._malloc(rocketSimVertices.byteLength);
          const indexPointer = raw._malloc(indices.byteLength);
          try {
            raw.HEAPF32.set(rocketSimVertices, vertexPointer >> 2);
            raw.HEAPU32.set(indices, indexPointer >> 2);
            if (!raw._rs_add_static_mesh(handle, vertexPointer, rocketSimVertices.length, indexPointer, indices.length)) {
              throw new Error('RocketSim rejected static arena mesh');
            }
          } finally {
            raw._free(vertexPointer);
            raw._free(indexPointer);
          }
        },
        addOctane({ team = 0 } = {}) {
          if (!alive) throw new Error('Arena is destroyed');
          const car = createCar(raw._rs_add_octane(handle, team));
          cars.push(car);
          return car;
        },
        step(ticks = 1) {
          if (!alive) throw new Error('Arena is destroyed');
          raw._rs_step(handle, ticks);
        },
        destroy() {
          if (!alive) return;
          for (const car of cars) car._release();
          ball._release();
          raw._rs_destroy_arena(handle);
          alive = false;
        }
      };
    },
    raw
  };
}
