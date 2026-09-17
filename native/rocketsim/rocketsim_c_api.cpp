#include <cstdint>
#include <map>
#include <vector>

#include <emscripten/emscripten.h>
#include "RocketSim.h"
#include "BulletCollision/CollisionShapes/btStaticPlaneShape.h"
#include "BulletCollision/CollisionShapes/btBvhTriangleMeshShape.h"
#include "BulletCollision/CollisionShapes/btTriangleMesh.h"

using namespace RocketSim;

namespace {
Arena* arenaFrom(std::uintptr_t handle) { return reinterpret_cast<Arena*>(handle); }
Car* carFrom(std::uintptr_t handle) { return reinterpret_cast<Car*>(handle); }
Ball* ballFrom(std::uintptr_t handle) { return reinterpret_cast<Ball*>(handle); }
std::map<Arena*, std::vector<btTriangleMesh*>> arenaTriangleMeshes;

void addPlane(Arena* arena, const btVector3& positionUU, const btVector3& normal) {
  arena->_AddStaticCollisionShape(
    new btStaticPlaneShape(normal, 0),
    positionUU * UU_TO_BT
  );
}
}

extern "C" {

EMSCRIPTEN_KEEPALIVE int rs_init() {
  if (RocketSim::GetStage() == RocketSimStage::UNINITIALIZED)
    RocketSim::InitFromMem({}, true);
  return RocketSim::GetStage() == RocketSimStage::INITIALIZED;
}

EMSCRIPTEN_KEEPALIVE std::uintptr_t rs_create_arena(
  float tickRate, float halfLengthUU, float halfWidthUU, float ceilingUU, int simpleBounds
) {
  rs_init();
  ArenaConfig config;
  config.memWeightMode = ArenaMemWeightMode::LIGHT;
  auto* arena = Arena::Create(GameMode::THE_VOID, config, tickRate);
  if (simpleBounds) {
    addPlane(arena, btVector3(0, 0, 0), btVector3(0, 0, 1));
    addPlane(arena, btVector3(0, 0, ceilingUU), btVector3(0, 0, -1));
    addPlane(arena, btVector3(-halfWidthUU, 0, 0), btVector3(1, 0, 0));
    addPlane(arena, btVector3(halfWidthUU, 0, 0), btVector3(-1, 0, 0));
    addPlane(arena, btVector3(0, -halfLengthUU, 0), btVector3(0, 1, 0));
    addPlane(arena, btVector3(0, halfLengthUU, 0), btVector3(0, -1, 0));
  }
  return reinterpret_cast<std::uintptr_t>(arena);
}

EMSCRIPTEN_KEEPALIVE void rs_destroy_arena(std::uintptr_t arenaHandle) {
  auto* arena = arenaFrom(arenaHandle);
  delete arena;
  for (auto* mesh : arenaTriangleMeshes[arena]) delete mesh;
  arenaTriangleMeshes.erase(arena);
}

EMSCRIPTEN_KEEPALIVE int rs_add_static_mesh(
  std::uintptr_t arenaHandle,
  const float* vertices, int vertexFloatCount,
  const std::uint32_t* indices, int indexCount
) {
  if (!vertices || !indices || vertexFloatCount % 3 || indexCount % 3) return 0;
  auto* arena = arenaFrom(arenaHandle);
  auto* mesh = new btTriangleMesh();
  for (int index = 0; index < indexCount; index += 3) {
    btVector3 triangle[3];
    for (int corner = 0; corner < 3; corner++) {
      const int vertex = static_cast<int>(indices[index + corner]) * 3;
      if (vertex < 0 || vertex + 2 >= vertexFloatCount) {
        delete mesh;
        return 0;
      }
      triangle[corner] = btVector3(vertices[vertex], vertices[vertex + 1], vertices[vertex + 2]) * UU_TO_BT;
    }
    mesh->addTriangle(triangle[0], triangle[1], triangle[2], true);
  }
  auto* shape = new btBvhTriangleMeshShape(mesh, true, true);
  arena->_AddStaticCollisionShape(shape);
  arenaTriangleMeshes[arena].push_back(mesh);
  return 1;
}

EMSCRIPTEN_KEEPALIVE std::uintptr_t rs_add_octane(std::uintptr_t arenaHandle, int team) {
  auto* car = arenaFrom(arenaHandle)->AddCar(team == 0 ? Team::BLUE : Team::ORANGE, CAR_CONFIG_OCTANE);
  return reinterpret_cast<std::uintptr_t>(car);
}

EMSCRIPTEN_KEEPALIVE std::uintptr_t rs_get_ball(std::uintptr_t arenaHandle) {
  return reinterpret_cast<std::uintptr_t>(arenaFrom(arenaHandle)->ball);
}

EMSCRIPTEN_KEEPALIVE void rs_set_car_state(
  std::uintptr_t carHandle,
  float px, float py, float pz,
  float vx, float vy, float vz,
  float forwardX, float forwardY,
  float boost
) {
  auto* car = carFrom(carHandle);
  auto state = car->GetState();
  state.pos = { px, py, pz };
  state.vel = { vx, vy, vz };
  state.angVel = { 0, 0, 0 };
  state.rotMat = RotMat::LookAt({ forwardX, forwardY, 0 }, { 0, 0, 1 });
  state.boost = boost;
  car->SetState(state);
}

EMSCRIPTEN_KEEPALIVE void rs_set_car_boost(std::uintptr_t carHandle, float boost) {
  auto* car = carFrom(carHandle);
  auto state = car->GetState();
  state.boost = boost;
  car->SetState(state);
}

EMSCRIPTEN_KEEPALIVE void rs_set_ball_state(
  std::uintptr_t ballHandle,
  float px, float py, float pz,
  float vx, float vy, float vz
) {
  auto* ball = ballFrom(ballHandle);
  auto state = ball->GetState();
  state.pos = { px, py, pz };
  state.vel = { vx, vy, vz };
  state.angVel = { 0, 0, 0 };
  ball->SetState(state);
}

EMSCRIPTEN_KEEPALIVE int rs_ball_state_float_count() { return 10; }

EMSCRIPTEN_KEEPALIVE void rs_write_ball_state(std::uintptr_t ballHandle, float* out) {
  auto state = ballFrom(ballHandle)->GetState();
  out[0] = static_cast<float>(state.tickCountSinceUpdate);
  out[1] = state.pos.x; out[2] = state.pos.y; out[3] = state.pos.z;
  out[4] = state.vel.x; out[5] = state.vel.y; out[6] = state.vel.z;
  out[7] = state.angVel.x; out[8] = state.angVel.y; out[9] = state.angVel.z;
}

EMSCRIPTEN_KEEPALIVE void rs_set_controls(
  std::uintptr_t carHandle,
  float throttle, float steer, float pitch, float yaw, float roll,
  int jump, int boost, int handbrake
) {
  auto* car = carFrom(carHandle);
  car->controls.throttle = throttle;
  car->controls.steer = steer;
  car->controls.pitch = pitch;
  car->controls.yaw = yaw;
  car->controls.roll = roll;
  car->controls.jump = jump != 0;
  car->controls.boost = boost != 0;
  car->controls.handbrake = handbrake != 0;
}

EMSCRIPTEN_KEEPALIVE void rs_step(std::uintptr_t arenaHandle, int ticks) {
  arenaFrom(arenaHandle)->Step(ticks);
}

EMSCRIPTEN_KEEPALIVE int rs_state_float_count() { return 40; }

EMSCRIPTEN_KEEPALIVE void rs_write_car_state(std::uintptr_t carHandle, float* out) {
  auto state = carFrom(carHandle)->GetState();
  out[0] = static_cast<float>(state.tickCountSinceUpdate);
  out[1] = state.pos.x; out[2] = state.pos.y; out[3] = state.pos.z;
  out[4] = state.vel.x; out[5] = state.vel.y; out[6] = state.vel.z;
  out[7] = state.angVel.x; out[8] = state.angVel.y; out[9] = state.angVel.z;
  out[10] = state.rotMat.forward.x; out[11] = state.rotMat.forward.y; out[12] = state.rotMat.forward.z;
  out[13] = state.rotMat.right.x; out[14] = state.rotMat.right.y; out[15] = state.rotMat.right.z;
  out[16] = state.rotMat.up.x; out[17] = state.rotMat.up.y; out[18] = state.rotMat.up.z;
  out[19] = state.boost;
  out[20] = state.isOnGround; 
  out[21] = state.wheelsWithContact[0] + state.wheelsWithContact[1] + state.wheelsWithContact[2] + state.wheelsWithContact[3];
  out[22] = state.hasJumped; out[23] = state.hasDoubleJumped; out[24] = state.hasFlipped;
  out[25] = state.isJumping; out[26] = state.isFlipping; out[27] = state.isBoosting;
  out[28] = state.lastControls.throttle; out[29] = state.lastControls.steer;
  out[30] = state.lastControls.pitch; out[31] = state.lastControls.yaw; out[32] = state.lastControls.roll;
  out[33] = state.lastControls.jump; out[34] = state.lastControls.boost; out[35] = state.lastControls.handbrake;
  out[36] = state.airTimeSinceJump; out[37] = state.jumpTime; out[38] = state.flipTime;
  out[39] = state.handbrakeVal;
}

}
