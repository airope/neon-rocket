import * as THREE from '/vendor/three.module.js';
import { createRocketSimModule } from '/native/rocketsim/rocketsim.mjs';
import { chaseCameraPose, controlsFromHeldKeys } from '/rocketsim-playable-core.js?v=3';
import { buildCarSoccerArenaMesh } from '/shared/car-soccer-arena-mesh.js?v=1';
import { CAR_SOCCER_FIELD } from '/shared/car-soccer-contract.js';
import { goalTeamForBall } from '/shared/rocketsim-match.js?v=1';
import { novaDirectControls } from '/shared/rocketsim-nova.js?v=1';

const canvas = document.querySelector('#viewport');
const loading = document.querySelector('#loading');
const boostEl = document.querySelector('#boost');
const contactEl = document.querySelector('#contact');
const fpsEl = document.querySelector('#fps');
const qaEl = document.querySelector('#qa');
const score0El = document.querySelector('#score0');
const score1El = document.querySelector('#score1');
const announcementEl = document.querySelector('#announcement');
const held = new Set();
const blocked = new Set(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']);
addEventListener('keydown', event => { held.add(event.code); if (blocked.has(event.code)) event.preventDefault(); });
addEventListener('keyup', event => { held.delete(event.code); if (blocked.has(event.code)) event.preventDefault(); });
addEventListener('blur', () => held.clear());
for (const button of document.querySelectorAll('[data-key]')) {
  const code = button.dataset.key;
  const down = event => { event.preventDefault(); button.setPointerCapture?.(event.pointerId); held.add(code); };
  const up = event => { event.preventDefault(); held.delete(code); };
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointerup', up);
  button.addEventListener('pointercancel', up);
  button.addEventListener('lostpointercapture', up);
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02040d);
scene.fog = new THREE.FogExp2(0x030713, 0.013);
const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.08, 250);
scene.add(new THREE.HemisphereLight(0xa9f5ff, 0x16254b, 3.1));
scene.add(new THREE.AmbientLight(0x75a7d0, 1.15));
const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(-16, 28, 12); scene.add(sun);

const arenaMeshData = buildCarSoccerArenaMesh();
const arenaGeometry = new THREE.BufferGeometry();
arenaGeometry.setAttribute('position', new THREE.BufferAttribute(arenaMeshData.vertices, 3));
arenaGeometry.setIndex(new THREE.BufferAttribute(arenaMeshData.indices, 1));
arenaGeometry.computeVertexNormals();
const arenaSurface = new THREE.Mesh(arenaGeometry, new THREE.MeshStandardMaterial({ color: 0x1a5275, emissive: 0x0a3248, emissiveIntensity: 1.55, roughness: .62, metalness: .18, side: THREE.DoubleSide }));
scene.add(arenaSurface);
const grid = new THREE.GridHelper(102.4, 32, 0x16dfee, 0x12384c); grid.position.y = .012; scene.add(grid);
function addGoalFrame(sign, color) {
  const x = sign * (CAR_SOCCER_FIELD.halfLength + .12), h = CAR_SOCCER_FIELD.goalHeight, z = CAR_SOCCER_FIELD.goalHalfWidth;
  const points = [x,0,-z,x,h,-z, x,h,-z,x,h,z, x,h,z,x,0,z];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  scene.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, toneMapped: false })));
  const light = new THREE.PointLight(color, 5, 18); light.position.set(x - sign * 2, h * .55, 0); scene.add(light);
}
addGoalFrame(-1, 0x18eaff); addGoalFrame(1, 0xff2bd6);

function makeCar({ color = 0x07394b, emissive = 0x00dffc } = {}) {
  const car = new THREE.Group();
  const cyan = new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: 1.5, metalness: .65, roughness: .25 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x030713, metalness: .9, roughness: .2 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x3eeaff, emissive: 0x087d9d, emissiveIntensity: 1.1, metalness: .45, roughness: .12 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.55, .34, .9), cyan); body.position.y = .12; car.add(body);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(.48, .22, .82), cyan); nose.position.set(.82, .08, 0); car.add(nose);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(.65, .32, .68), glass); cabin.position.set(-.12, .42, 0); cabin.rotation.z = -.12; car.add(cabin);
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(.12, .12, 1.02), cyan); spoiler.position.set(-.72, .42, 0); car.add(spoiler);
  const wheelGeo = new THREE.CylinderGeometry(.23, .23, .17, 18); wheelGeo.rotateX(Math.PI / 2);
  for (const x of [-.53,.53]) for (const z of [-.49,.49]) { const wheel = new THREE.Mesh(wheelGeo, dark); wheel.position.set(x,-.1,z); car.add(wheel); }
  const glow = new THREE.PointLight(0x00eaff, 3, 4); glow.position.set(-.9,.15,0); car.add(glow);
  scene.add(car); return car;
}
const carMesh = makeCar();
const novaMesh = makeCar({ color: 0x4a073d, emissive: 0xff25ce });
const ballMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(.9125, 3), new THREE.MeshStandardMaterial({ color: 0xaaff16, emissive: 0x43ff00, emissiveIntensity: 2.1, metalness: .25, roughness: .32 }));
scene.add(ballMesh);
const ballHalo = new THREE.Mesh(new THREE.RingGeometry(.85, 1.25, 40), new THREE.MeshBasicMaterial({ color: 0x7dff24, transparent: true, opacity: .5, side: THREE.DoubleSide })); ballHalo.rotation.x = -Math.PI/2; ballHalo.position.y=.025; scene.add(ballHalo);

const rocketSim = await createRocketSimModule();
const arena = rocketSim.createArena({ tickRate: 120, halfLength: 51.2, halfWidth: 40.96, ceiling: 20.44, simpleBounds: false });
arena.addStaticMesh(arenaMeshData);
const car = arena.addOctane({ team: 0 });
const nova = arena.addOctane({ team: 1 });
const score = [0, 0];
let goalPauseTicks = 0;
function reset() {
  car.setState({ position: { x: -20, y: .37, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, boost: 33 });
  car.setControls({});
  nova.setState({ position: { x: 20, y: .37, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: Math.PI, boost: 33 });
  nova.setControls({});
  arena.ball.setState({ position: { x: 0, y: 2.2, z: 0 }, velocity: { x: 0, y: 0, z: 0 } });
  goalPauseTicks = 0;
  announcementEl.textContent = 'SOLO · NOVA 1';
}
document.querySelector('#reset').onclick = reset;
reset();
loading.remove();

const forward = new THREE.Vector3(), up = new THREE.Vector3(), visualRight = new THREE.Vector3();
const matrix = new THREE.Matrix4();
const desiredCamera = new THREE.Vector3(), lookTarget = new THREE.Vector3();
let accumulator = 0, previous = performance.now(), frames = 0, fpsStarted = previous, fps = 60, simTicks = 0;
const qaDrive = new URLSearchParams(location.search).has('qa-drive');
function gamepadControls(base) {
  const pad = navigator.getGamepads?.()[0]; if (!pad) return base;
  const dead = value => Math.abs(value) > .12 ? value : 0;
  return {
    throttle: Math.max(base.throttle, pad.buttons[7]?.value || 0) - Math.max(-base.throttle, pad.buttons[6]?.value || 0),
    steer: base.steer || -dead(pad.axes[0] || 0),
    pitch: base.pitch || dead(pad.axes[3] || 0),
    yaw: base.yaw || -dead(pad.axes[2] || 0),
    roll: base.roll || (pad.buttons[5]?.pressed ? 1 : pad.buttons[4]?.pressed ? -1 : 0),
    jump: base.jump || Boolean(pad.buttons[0]?.pressed),
    boost: base.boost || Boolean(pad.buttons[1]?.pressed),
    handbrake: base.handbrake || Boolean(pad.buttons[2]?.pressed)
  };
}
function applyCarPose(mesh, state) {
  mesh.position.set(state.position.x, state.position.y, state.position.z);
  forward.set(state.rotation.forward.x, state.rotation.forward.y, state.rotation.forward.z).normalize();
  up.set(state.rotation.up.x, state.rotation.up.y, state.rotation.up.z).normalize();
  visualRight.crossVectors(forward, up).normalize();
  matrix.makeBasis(forward, up, visualRight);
  mesh.quaternion.setFromRotationMatrix(matrix);
}
function updateVisuals(carState, novaState, ballState, dt) {
  applyCarPose(carMesh, carState);
  applyCarPose(novaMesh, novaState);
  ballMesh.position.set(ballState.position.x, ballState.position.y, ballState.position.z);
  ballHalo.position.x = ballState.position.x; ballHalo.position.z = ballState.position.z;
  const chase = chaseCameraPose(carState.position, carState.rotation.forward, ballState.position);
  desiredCamera.set(chase.position.x, chase.position.y, chase.position.z);
  camera.position.lerp(desiredCamera, 1 - Math.exp(-dt * 8));
  lookTarget.set(chase.lookAt.x, chase.lookAt.y, chase.lookAt.z); camera.lookAt(lookTarget);
  boostEl.textContent = Math.max(0, Math.round(carState.boost));
  contactEl.textContent = `${carState.wheelContactCount} WHEELS`;
}
function frame(now) {
  const dt = Math.min((now - previous) / 1000, .1); previous = now; accumulator += dt;
  let controls = gamepadControls(controlsFromHeldKeys(held));
  if (qaDrive && simTicks < 240) controls = { ...controls, throttle: 1, boost: simTicks < 150, jump: simTicks >= 180 && simTicks < 205, pitch: simTicks >= 185 ? -1 : 0 };
  let steps = 0;
  while (accumulator >= 1/120 && steps < 12) {
    if (goalPauseTicks > 0) {
      goalPauseTicks--;
      if (goalPauseTicks === 0) reset();
    } else {
      const novaState = nova.getState();
      const ballState = arena.ball.getState();
      car.setControls(controls);
      nova.setControls(novaDirectControls({ team: 1, car: novaState, ball: ballState, field: CAR_SOCCER_FIELD }));
      arena.step(1);
      simTicks++;
      const goalTeam = goalTeamForBall(arena.ball.getState(), CAR_SOCCER_FIELD);
      if (goalTeam !== null) {
        score[goalTeam]++;
        score0El.textContent = score[0];
        score1El.textContent = score[1];
        announcementEl.textContent = goalTeam === 0 ? 'AZURE GOAL!' : 'NOVA GOAL!';
        goalPauseTicks = 180;
        car.setControls({});
        nova.setControls({});
      }
    }
    accumulator -= 1/120; steps++;
  }
  const carState = car.getState(), novaState = nova.getState(), ballState = arena.ball.getState();
  updateVisuals(carState, novaState, ballState, dt);
  frames++; if (now - fpsStarted >= 1000) { fps = Math.round(frames * 1000 / (now - fpsStarted)); frames = 0; fpsStarted = now; fpsEl.textContent = `${fps} FPS`; }
  const qa = { ok: true, engine: 'RocketSim-WASM', mode: 'solo', simTicks, fps, score: [...score], car: carState, nova: novaState, ball: ballState, controls };
  qaEl.value = JSON.stringify(qa); window.__rocketSimPlayableDebug = () => qa;
  renderer.render(scene, camera); requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
addEventListener('resize', () => { camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth,innerHeight,false); });
addEventListener('beforeunload', () => arena.destroy(), { once: true });
