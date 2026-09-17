import * as THREE from '/vendor/three.module.js';
import { CAR, FIELD, GameSimulation, blankInput } from '/shared/simulation-v3.js?v=2';
import { roundedCornerPoint, transitionPoint } from '/shared/arena-geometry.js?v=1';
import { RAPierArenaMeshes } from '/shared/rapier-arena.js?v=1';
import { NetworkTimeline } from '/network-interpolation.js?v=2';
import { createRocketSimSoloSimulation } from '/shared/rocketsim-local-simulation.js?v=22';
import { controlsFromHeldKeys } from '/rocketsim-playable-core.js?v=18';

const $ = s => document.querySelector(s);
const lobby = $('#lobby'), game = $('#game');
const inputState = blankInput();
const held = new Set();
let socket = null, localSim = null, localId = null, currentState = null, networkMode = false, spectatorMode = false;
const networkTimeline = new NetworkTimeline({ adaptive: true, interpolationDelayMs: 140, maxExtrapolationMs: 80 });
let scene, camera, renderer, ballMesh, ballShadow, animationStarted = false, lastFrame = performance.now(), accumulator = 0;
const cameraPitch = 0.2, cameraDistance = 4.3;
let announcementTimer = 0;
const cameraLookTarget = new THREE.Vector3();
let cameraLookReady = false;
let renderScale = 1, basePixelRatio = 1, fpsFrames = 0, fpsWindowStart = performance.now(), currentFps = 60, nextDebugUpdate = 0, lastQualityChange = 0;
const carMeshes = new Map();
const arenaCameraOccluders = [];
const spectatorOccluderMeshes = [];
const cameraRaycaster = new THREE.Raycaster();
const goalEffects = [];
let goalShake = 0, finishOverlayTimer = null;
let boostPadVisuals = null;
const boostVisualPreview = new URLSearchParams(location.search).has('boost-preview');
const trailDemo = new URLSearchParams(location.search).has('trail-demo');
const matchPreview = new URLSearchParams(location.search).get('match-preview');
const kickoffPreview = new URLSearchParams(location.search).has('kickoff-preview');
const cameraQaEnabled = new URLSearchParams(location.search).has('camera-qa');
const ballPreview = new URLSearchParams(location.search).has('ball-preview');
const ballAirPreview = new URLSearchParams(location.search).has('ball-air-preview');
const cameraPreview = new URLSearchParams(location.search).get('camera-preview');
let cameraOcclusionActive = false, cameraOcclusionDistance = cameraDistance;
const cameraQa = { start: 0, frames: 0, previousPosition: null, previousQuaternion: null, previousStep: 0, previousAngle: 0, maxLinearJerk: 0, sumLinearJerk2: 0, maxAngularStep: 0, maxAngularJerk: 0, sumAngularJerk2: 0, done: false };
window.__neonRocketDebug = () => ({ localId, networkMode, state: currentState, cars: [...carMeshes].map(([id, mesh]) => ({ id, position: mesh.position.toArray(), visible: mesh.visible, trailPoints: mesh.userData.tronTrail?.trailPoints.length || 0 })), camera: camera ? camera.position.toArray() : null, cameraQuaternion: camera ? camera.quaternion.toArray() : null, cameraOcclusion: { active: cameraOcclusionActive, distance: cameraOcclusionDistance, occluders: arenaCameraOccluders.length }, cameraQa });

$('#name').value = localStorage.getItem('neon3dPilot') || 'Player';
try {
  if (window.io) {
    socket = io({ transports: ['polling', 'websocket'], timeout: 7000, reconnection: true });
    socket.on('connect', () => { setConnection('MULTIPLAYER SERVER CONNECTED', 'ok'); sampleNetworkClock(); });
    socket.on('disconnect', () => {
      setConnection('MULTIPLAYER UNAVAILABLE · SOLO AVAILABLE', 'bad');
      returnToLobby('Disconnected from the room. Create or join a room once reconnected.');
    });
    socket.on('connect_error', () => setConnection('MULTIPLAYER UNAVAILABLE · SOLO AVAILABLE', 'bad'));
    socket.on('joined', data => { localId = data.id; $('#room').textContent = data.roomCode; });
    socket.on('state', state => {
      if (!networkMode) return;
      if (networkTimeline.push(state, Date.now())) currentState = state;
    });
    socket.on('gameEvent', event => handleEvent(event));
    socket.on('matchStarted', () => { $('#enemyName').textContent = 'MAGENTA'; announce('3', 900); });
    socket.on('rematchVote', ({ votes, required }) => { $('#rematchStatus').textContent = `REMATCH ${votes} / ${required}`; });
    socket.on('rematchStarted', () => { hideMatchEnd(); announce('REMATCH', 800); });
    socket.on('roomClosed', () => returnToLobby('Room closed: opponent left or the wait timed out.'));
  } else setConnection('SOCKET.IO UNAVAILABLE · SOLO AVAILABLE', 'bad');
} catch { setConnection('MULTIPLAYER UNAVAILABLE · SOLO AVAILABLE', 'bad'); }

function returnToLobby(message = '') {
  if (!networkMode) return;
  networkMode = false; spectatorMode = false; currentState = null; localId = null;
  networkTimeline.reset(); held.clear(); Object.assign(inputState, blankInput());
  clearTimeout(announcementTimer); hideMatchEnd();
  game.classList.add('hidden'); lobby.classList.remove('hidden');
  $('#room').textContent = ''; showError(message);
}

function setConnection(text, className = '') { const el = $('#connection'); el.textContent = text; el.className = `connection ${className}`; }
function pilotName() { const value = $('#name').value.trim().slice(0, 18) || 'Player'; localStorage.setItem('neon3dPilot', value); return value; }
function showError(text = '') { $('#error').textContent = text; }

$('#solo').onclick = async () => {
  const novaVersion = Number($('#novaVersion').value) || 1;
  const button = $('#solo');
  button.disabled = true;
  button.textContent = 'LOADING…';
  showError();
  networkMode = false;
  spectatorMode = false;
  localId = 'LOCAL';
  const novaName = novaVersion === 3 ? 'NOVA-WF' : `NOVA ${novaVersion}`;
  const legacyFixturePreview = Boolean(ballPreview || ballAirPreview || cameraPreview || matchPreview);
  try {
    localSim?.free?.();
    localSim = legacyFixturePreview
      ? new GameSimulation({ mode: 'solo', targetScore: 5 })
      : await createRocketSimSoloSimulation({ targetScore: 5 });
  } catch (error) {
    button.disabled = false;
    button.textContent = 'PLAY SOLO ⚡';
    showError(`Unable to load the physics engine: ${error.message || error}`);
    return;
  }
  localSim.addPlayer({ id: localId, name: pilotName(), team: 0 });
  localSim.addPlayer({ id: 'NOVA', name: novaName, team: 1, isBot: true, aiVersion: novaVersion });
  localSim.start();
  currentState = localSim.snapshot();
  startGame('SOLO · FIRST TO 5', novaName, 'OFFLINE');
  button.disabled = false;
  button.textContent = 'PLAY SOLO ⚡';
  if (legacyFixturePreview && (ballPreview || ballAirPreview)) {
    const previewPlayer = localSim.players.get(localId);
    previewPlayer.body.position.set(-7, .68, 0);
    localSim.ball.position.set(0, ballAirPreview ? 12 : FIELD.ballRadius + .05, 0);
    localSim.countdownClock = 300;
  }
  if (legacyFixturePreview && cameraPreview) {
    const previewPlayer = localSim.players.get(localId);
    const fixtures = {
      wall: { p: [0, 12, FIELD.halfZ - .75], q: [-.7071068, 0, 0, .7071068] },
      curve: { p: [0, 5.4, FIELD.halfZ - 4.7], q: [-.3826834, 0, 0, .9238795] },
      corner: { p: [110, .72, 66], q: [0, -.3826834, 0, .9238795] }
    };
    const fixture = fixtures[cameraPreview] || fixtures.wall;
    previewPlayer.body.position.set(...fixture.p);
    previewPlayer.body.quaternion.set(...fixture.q);
    previewPlayer.body.velocity.setZero();
    previewPlayer.body.angularVelocity.setZero();
    localSim.countdownClock = 300;
  }
  if (kickoffPreview) announce('3', 30000);
  if (legacyFixturePreview && matchPreview) setTimeout(() => {
    if (!localSim) return;
    if (matchPreview === 'final') localSim.targetScore = 1;
    localSim.status = 'playing';
    localSim.ball.position.set(FIELD.halfX + FIELD.ballRadius + .08, FIELD.ballRadius + .1, 0);
  }, 500);
};

function startLocalNovaDuel() {
  networkMode = false;
  spectatorMode = true;
  localId = null;
  localSim = new GameSimulation({ mode: 'duel' });
  localSim.addPlayer({ id: 'NOVA1', name: 'NOVA 1', team: 0, isBot: true, aiVersion: 1 });
  localSim.addPlayer({ id: 'NOVA2', name: 'NOVA 2', team: 1, isBot: true, aiVersion: 2 });
  localSim.start();
  currentState = localSim.snapshot();
  startGame('SPECTATING · AI VS AI', 'NOVA 2', 'LOCAL · FIRST TO 5', 'NOVA 1');
}

$('#novaDuel').onclick = async () => {
  showError();
  if (socket?.connected) {
    try {
      const reply = await socket.timeout(8000).emitWithAck('watchNovaDuel', {});
      if (!reply?.ok || !reply.state) throw new Error('Live match unavailable.');
      networkMode = true;
      networkTimeline.reset();
      networkTimeline.push(reply.state, Date.now());
      spectatorMode = true;
      localId = null;
      localSim = null;
      currentState = reply.state;
      startGame('LIVE · NOVA 1 VS NOVA 2', 'NOVA 2', `${reply.viewers} SPECTATOR${reply.viewers > 1 ? 'S' : ''} · FIRST TO 5`, 'NOVA 1');
      return;
    } catch (error) {
      showError(`${error.message || 'Live match unavailable'} · SWITCHING TO LOCAL`);
    }
  }
  startLocalNovaDuel();
};

$('#create').onclick = async () => {
  showError();
  if (!socket?.connected) return showError('Multiplayer is unavailable. Solo mode is still available.');
  try {
    const reply = await socket.timeout(8000).emitWithAck('createRoom', { name: pilotName() });
    if (!reply?.ok) throw new Error(reply?.error || 'Unable to create a room.');
    networkMode = true; networkTimeline.reset(); localSim = null;
    startGame('1V1 · PRIVATE', 'WAITING', reply.roomCode);
    announce(`CODE ${reply.roomCode}`, 5000);
  } catch (error) { showError(error.message || 'Unable to reach the server.'); }
};

$('#join').onclick = async () => {
  showError();
  if (!socket?.connected) return showError('Multiplayer is unavailable.');
  const roomCode = $('#code').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (roomCode.length !== 6) return showError('Enter a 6-character room code.');
  try {
    const reply = await socket.timeout(8000).emitWithAck('joinRoom', { roomCode, name: pilotName() });
    if (!reply?.ok) throw new Error(reply?.error || 'Unable to join the room.');
    networkMode = true; networkTimeline.reset(); localSim = null;
    startGame('1V1 · PRIVATE', 'MAGENTA', reply.roomCode);
  } catch (error) { showError(error.message || 'Unable to reach the server.'); }
};

$('#exit').onclick = () => location.reload();
$('#endExit').onclick = () => location.reload();
$('#rematch').onclick = requestRematch;

function startGame(mode, enemy, room, home = 'AZURE') {
  lobby.classList.add('hidden'); game.classList.remove('hidden');
  $('#mode').textContent = mode; $('#team0Name').textContent = home; $('#enemyName').textContent = enemy; $('#room').textContent = room;
  $('#boostHud').classList.toggle('hidden', spectatorMode);
  $('#touch').classList.toggle('hidden', spectatorMode);
  hideMatchEnd();
  cameraLookReady = false;
  if (!scene) init3D();
  for (const mesh of spectatorOccluderMeshes) mesh.visible = !spectatorMode;
  if (cameraQaEnabled) {
    const debugPanel = $('#debugState');
    debugPanel.style.cssText = 'display:block;position:fixed;left:8px;bottom:8px;z-index:30;max-width:52vw;max-height:32vh;overflow:auto;background:#020711dd;color:#7ff;font:10px monospace;white-space:pre-wrap;padding:6px;pointer-events:none';
  }
  if (!animationStarted) { animationStarted = true; requestAnimationFrame(animate); }
}

function hideMatchEnd() {
  clearTimeout(finishOverlayTimer);
  $('#matchEnd').classList.add('hidden');
  $('#rematch').disabled = false;
  $('#rematch').classList.remove('hidden');
  $('#rematch').textContent = 'REMATCH';
  $('#rematchStatus').textContent = 'PLAY AGAIN?';
}

function showMatchEnd(event) {
  const localTeam = currentState?.players.find(player => player.id === localId)?.team ?? 0;
  const won = event.team === localTeam;
  $('#finalTitle').textContent = spectatorMode ? `NOVA ${event.team + 1} WINS` : won ? 'VICTORY' : 'DEFEAT';
  $('#finalTitle').classList.toggle('defeat', !spectatorMode && !won);
  $('#finalScore0').textContent = event.score?.[0] ?? currentState?.score?.[0] ?? 0;
  $('#finalScore1').textContent = event.score?.[1] ?? currentState?.score?.[1] ?? 0;
  $('#rematch').classList.toggle('hidden', spectatorMode && networkMode);
  if (spectatorMode && networkMode) $('#rematchStatus').textContent = 'NEXT MATCH STARTING AUTOMATICALLY…';
  $('#matchEnd').classList.remove('hidden');
}

async function requestRematch() {
  const button = $('#rematch');
  button.disabled = true;
  if (localSim) {
    localSim.start();
    currentState = localSim.snapshot();
    hideMatchEnd();
    return;
  }
  try {
    button.textContent = 'WAITING…';
    const reply = await socket.timeout(6000).emitWithAck('rematchRequest', {});
    if (!reply?.ok) throw new Error(reply?.error || 'Unable to request a rematch.');
    $('#rematchStatus').textContent = reply.ready ? 'NEW MATCH' : `REMATCH ${reply.votes} / ${reply.required}`;
  } catch (error) {
    button.disabled = false;
    button.textContent = 'TRY AGAIN';
    $('#rematchStatus').textContent = error.message || 'SERVER UNREACHABLE';
  }
}

function init3D() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x040817);
  scene.fog = new THREE.FogExp2(0x061126, 0.0038);
  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 500);
  camera.position.set(-12, 7, 0);
  const canvas = $('#viewport');
  const lowSpec = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowSpec && devicePixelRatio <= 1.5, powerPreference: 'high-performance' });
  basePixelRatio = Math.min(devicePixelRatio, lowSpec ? 1 : 1.25);
  renderer.setPixelRatio(basePixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.28;
  renderer.shadowMap.enabled = false;
  buildArena();
  scene.updateMatrixWorld(true);
  scene.traverse(object => {
    if (!object.isMesh || !object.geometry) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (!materials.some(material => material && (!material.transparent || material.opacity >= .65))) return;
    if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
    if ((object.geometry.boundingSphere?.radius || 0) >= 2.5) arenaCameraOccluders.push(object);
  });
  ballMesh = buildBall();
  scene.add(ballMesh);
  ballShadow = buildBallGroundHalo();
  scene.add(ballShadow);
  addEventListener('resize', resize);
}

function canvasTexture(width, height, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  paint(ctx, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

function hexPath(ctx, cx, cy, radius) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 3 * i;
    const x = cx + Math.cos(angle) * radius, y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function buildFloorTexture() {
  return canvasTexture(2048, 1280, (ctx, w, h) => {
    ctx.fillStyle = '#04101d'; ctx.fillRect(0, 0, w, h);
    const cyan = ctx.createLinearGradient(0, 0, w / 2, 0);
    cyan.addColorStop(0, '#0a4962'); cyan.addColorStop(1, '#0a1c2d');
    ctx.fillStyle = cyan; ctx.fillRect(0, 0, w / 2, h);
    const pink = ctx.createLinearGradient(w, 0, w / 2, 0);
    pink.addColorStop(0, '#5b173f'); pink.addColorStop(1, '#1c1026');
    ctx.fillStyle = pink; ctx.fillRect(w / 2, 0, w / 2, h);

    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(105,185,230,.10)';
    const radius = 24, dx = radius * 1.5, dy = radius * 1.73;
    for (let col = -1; col < w / dx + 1; col++) for (let row = -1; row < h / dy + 1; row++) {
      hexPath(ctx, col * dx, row * dy + (col % 2 ? dy / 2 : 0), radius - 2); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(150,210,255,.08)'; ctx.lineWidth = 3;
    for (let x = 35; x < w; x += 85) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 36; y < h; y += 72) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

    const shellMargin = FIELD.goalDepth + 2;
    const insetX = w * shellMargin / (FIELD.halfX * 2 + shellMargin * 2), insetY = h * shellMargin / (FIELD.halfZ * 2 + shellMargin * 2);
    ctx.shadowBlur = 18; ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(151,226,255,.72)'; ctx.shadowColor = '#67dfff';
    ctx.strokeRect(insetX, insetY, w - insetX * 2, h - insetY * 2);
    ctx.shadowBlur = 14; ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(225,246,255,.82)';
    ctx.beginPath(); ctx.moveTo(w / 2, insetY); ctx.lineTo(w / 2, h - insetY); ctx.stroke();
    const scaleX = (w - insetX * 2) / (FIELD.halfX * 2);
    const centerRadius = 7.5 * scaleX;
    ctx.beginPath(); ctx.arc(w / 2, h / 2, centerRadius, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#e8fbff'; ctx.beginPath(); ctx.arc(w / 2, h / 2, 12, 0, Math.PI * 2); ctx.fill();

    for (const side of [-1, 1]) {
      const color = side < 0 ? '#31e7ff' : '#ff3eaa';
      ctx.strokeStyle = color; ctx.shadowColor = color; ctx.lineWidth = 10; ctx.shadowBlur = 18;
      const gx = side < 0 ? insetX + 190 : w - insetX - 190;
      ctx.strokeRect(gx - 105, h / 2 - 225, 210, 450);
      ctx.globalAlpha = .55;
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        const x = gx - side * (150 + i * 45);
        ctx.moveTo(x, h / 2 - 160); ctx.lineTo(x + side * 70, h / 2); ctx.lineTo(x, h / 2 + 160); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.shadowBlur = 0;
  });
}

function buildWallTexture() {
  return canvasTexture(2048, 512, (ctx, w, h) => {
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#102b43'); bg.addColorStop(.55, '#071522'); bg.addColorStop(1, '#0a2438');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(112,200,245,.2)';
    for (let x = 0; x <= w; x += 85) { ctx.strokeRect(x + 4, 6, 77, h - 12); }
    ctx.strokeStyle = 'rgba(150,225,255,.12)';
    for (let y = 46; y < h; y += 53) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    for (let x = 70; x < w; x += 280) {
      ctx.fillStyle = x < w / 2 ? 'rgba(45,226,255,.22)' : 'rgba(255,53,166,.22)';
      ctx.beginPath(); ctx.moveTo(x, h - 34); ctx.lineTo(x + 56, h - 92); ctx.lineTo(x + 92, h - 92); ctx.lineTo(x + 36, h - 34); ctx.fill();
    }
    ctx.font = '700 54px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(205,241,255,.28)';
    ctx.fillText('NR // HYPERDOME', w / 2, 78);
  });
}

function buildCurveTexture() {
  const texture = canvasTexture(1024, 512, (ctx, w, h) => {
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#0d2b43'); bg.addColorStop(.5, '#071725'); bg.addColorStop(1, '#102d45');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(114,205,248,.18)'; ctx.lineWidth = 3;
    for (let x = 0; x <= w; x += 128) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y <= h; y += 96) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(85,181,225,.12)';
    for (let x = -h; x < w + h; x += 210) { ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + h, 0); ctx.stroke(); }
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 20);
  return texture;
}

function buildRoofTexture() {
  return canvasTexture(1536, 960, (ctx, w, h) => {
    ctx.fillStyle = '#0a2037'; ctx.fillRect(0, 0, w, h);
    const glow = ctx.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, w * .55);
    glow.addColorStop(0, 'rgba(92,174,242,.42)'); glow.addColorStop(1, 'rgba(7,24,42,.08)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(112,182,235,.22)'; ctx.lineWidth = 3;
    for (let x = 0; x < w; x += 64) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(164,220,255,.46)'; ctx.lineWidth = 8; ctx.strokeRect(28, 28, w - 56, h - 56);
    ctx.beginPath(); ctx.arc(w / 2, h / 2, 125, 0, Math.PI * 2); ctx.stroke();
  });
}

function buildGoalBackdropTexture(color) {
  const css = `#${new THREE.Color(color).getHexString()}`;
  return canvasTexture(768, 512, (ctx, w, h) => {
    ctx.fillStyle = '#02050b'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = css; ctx.shadowColor = css; ctx.shadowBlur = 16; ctx.lineWidth = 5;
    for (let x = -h; x < w + h; x += 118) { ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + h, 0); ctx.stroke(); }
    ctx.globalAlpha = .38; ctx.lineWidth = 2;
    for (let y = 0; y < h; y += 74) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(2,5,11,.78)'; ctx.fillRect(w * .2, h * .32, w * .6, h * .36);
    ctx.font = '900 92px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff1fb'; ctx.strokeStyle = css; ctx.lineWidth = 6;
    ctx.strokeText('SCORE', w / 2, h / 2 + 30); ctx.fillText('SCORE', w / 2, h / 2 + 30);
  });
}

function buildArena() {
  scene.add(new THREE.HemisphereLight(0x8bc8ff, 0x030208, 1.35));
  const key = new THREE.DirectionalLight(0xeaf8ff, 2.4); key.position.set(-18, 28, 14); scene.add(key);
  const cyanLight = new THREE.PointLight(0x27ddff, 55, 72); cyanLight.position.set(-FIELD.halfX + 10, 7, 0); scene.add(cyanLight);
  const pinkLight = new THREE.PointLight(0xff299f, 55, 72); pinkLight.position.set(FIELD.halfX - 10, 7, 0); scene.add(pinkLight);

  const floorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: buildFloorTexture(), metalness: .72, roughness: .4 });
  const bankMat = new THREE.MeshStandardMaterial({ color: 0x1c3e58, emissive: 0x09243a, emissiveIntensity: .76, metalness: .68, roughness: .3, side: THREE.DoubleSide });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x10243a, emissive: 0x081c32, emissiveIntensity: .65, metalness: .8, roughness: .24, transparent: true, opacity: .94 });
  const roofMat = new THREE.MeshBasicMaterial({ color: 0x75c9f0, transparent: true, opacity: .07, side: THREE.DoubleSide, depthWrite: false });

  const octagonShape = new THREE.Shape();
  const outline = [
    [-FIELD.halfX + FIELD.cornerRadius, -FIELD.halfZ], [FIELD.halfX - FIELD.cornerRadius, -FIELD.halfZ],
    [FIELD.halfX, -FIELD.halfZ + FIELD.cornerRadius], [FIELD.halfX, FIELD.halfZ - FIELD.cornerRadius],
    [FIELD.halfX - FIELD.cornerRadius, FIELD.halfZ], [-FIELD.halfX + FIELD.cornerRadius, FIELD.halfZ],
    [-FIELD.halfX, FIELD.halfZ - FIELD.cornerRadius], [-FIELD.halfX, -FIELD.halfZ + FIELD.cornerRadius]
  ];
  outline.forEach(([x, z], index) => index ? octagonShape.lineTo(x, z) : octagonShape.moveTo(x, z));
  octagonShape.closePath();
  const floor = new THREE.Mesh(new THREE.ShapeGeometry(octagonShape), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const roof = new THREE.Mesh(new THREE.ShapeGeometry(octagonShape), roofMat);
  roof.rotation.x = Math.PI / 2; roof.position.y = FIELD.ceilingY; scene.add(roof); spectatorOccluderMeshes.push(roof);

  const bank = FIELD.curveRadius, bankLength = Math.SQRT2 * bank;
  const straightLength = (FIELD.halfX - FIELD.cornerRadius) * 2;
  const verticalHeight = FIELD.ceilingY - bank * 2, verticalY = FIELD.ceilingY / 2;
  for (const sideZ of [-1, 1]) {
    arenaPanel(straightLength, verticalHeight, .5, wallMat, 0, verticalY, sideZ * (FIELD.halfZ + .25));
    arenaPanel(straightLength, .28, bankLength, bankMat, 0, bank / 2, sideZ * (FIELD.halfZ - bank / 2), -sideZ * Math.PI / 4);
    arenaPanel(straightLength, .28, bankLength, bankMat, 0, FIELD.ceilingY - bank / 2, sideZ * (FIELD.halfZ - bank / 2), sideZ * Math.PI / 4);
    for (const y of [bank, FIELD.ceilingY - bank]) {
      const rail = glowBox(straightLength, .11, .13, sideZ < 0 ? 0x39ecff : 0xff3faf, .86);
      rail.position.set(0, y, sideZ * FIELD.halfZ); scene.add(rail);
    }
  }

  const flankWidth = (FIELD.halfZ - FIELD.cornerRadius - FIELD.goalHalf) / 2;
  const flankCenter = FIELD.goalHalf + flankWidth;
  for (const sideX of [-1, 1]) {
    const teamColor = sideX < 0 ? 0x39ecff : 0xff3faf;
    for (const sideZ of [-1, 1]) {
      arenaPanel(.5, verticalHeight, flankWidth * 2, wallMat, sideX * (FIELD.halfX + .25), verticalY, sideZ * flankCenter);
      arenaPanel(bankLength, .28, flankWidth * 2, bankMat, sideX * (FIELD.halfX - bank / 2), bank / 2, sideZ * flankCenter, 0, 0, sideX * Math.PI / 4);
      arenaPanel(bankLength, .28, flankWidth * 2, bankMat, sideX * (FIELD.halfX - bank / 2), FIELD.ceilingY - bank / 2, sideZ * flankCenter, 0, 0, -sideX * Math.PI / 4);
      for (const y of [bank, FIELD.ceilingY - bank]) {
        const rail = glowBox(.13, .11, flankWidth * 2, teamColor, .86);
        rail.position.set(sideX * FIELD.halfX, y, sideZ * flankCenter); scene.add(rail);
      }
    }
    arenaPanel(.5, FIELD.ceilingY - FIELD.goalHeight, FIELD.goalHalf * 2, wallMat, sideX * (FIELD.halfX + .25), (FIELD.ceilingY + FIELD.goalHeight) / 2, 0);
    buildGoal(sideX, teamColor);
  }

  const floorCorners = sharedArenaMesh(RAPierArenaMeshes.floorCornerRamps, bankMat);
  floorCorners.name = 'rapierFloorCornerRamps'; scene.add(floorCorners); spectatorOccluderMeshes.push(floorCorners);
  const roofCorners = sharedArenaMesh(RAPierArenaMeshes.roofCornerRamps, bankMat);
  roofCorners.name = 'rapierRoofCornerRamps'; scene.add(roofCorners); spectatorOccluderMeshes.push(roofCorners);

  const cornerSegments = 8, arcStep = Math.PI / 2 / cornerSegments;
  const arcLength = FIELD.cornerRadius * Math.sin(arcStep / 2) * 2.04;
  for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) {
    const centerX = sideX * (FIELD.halfX - FIELD.cornerRadius);
    const centerZ = sideZ * (FIELD.halfZ - FIELD.cornerRadius);
    for (let index = 0; index < cornerSegments; index++) {
      const angle = (index + .5) * arcStep;
      const x = centerX + sideX * Math.cos(angle) * (FIELD.cornerRadius + .25);
      const z = centerZ + sideZ * Math.sin(angle) * (FIELD.cornerRadius + .25);
      const tangentX = -sideX * Math.sin(angle), tangentZ = sideZ * Math.cos(angle);
      const yaw = Math.atan2(-tangentZ, tangentX);
      arenaPanel(arcLength, verticalHeight, .5, wallMat, x, verticalY, z, 0, yaw, 0);
    }
  }

  buildPrismMarkings();
  buildPrismSuperstructure();
}

function sharedArenaMesh(data, material) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.vertices, 3));
  geometry.setIndex(data.indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

function prismBeam(from, to, radius, color, opacity = .85) {
  const direction = new THREE.Vector3().subVectors(to, from);
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, direction.length(), 6),
    new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, toneMapped: false })
  );
  mesh.position.copy(from).add(to).multiplyScalar(.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  scene.add(mesh);
  return mesh;
}

function buildPrismMarkings() {
  const cyan = 0x39ecff, magenta = 0xff3faf;
  const ring = new THREE.Mesh(new THREE.RingGeometry(5.6, 5.78, 48), new THREE.MeshBasicMaterial({ color: 0xe8fbff, transparent: true, opacity: .72, side: THREE.DoubleSide, toneMapped: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = .025; scene.add(ring);
  for (const side of [-1, 1]) {
    const material = new THREE.MeshBasicMaterial({ color: side < 0 ? cyan : magenta, transparent: true, opacity: .42, side: THREE.DoubleSide, toneMapped: false });
    for (const z of [-22, 22]) {
      const shape = new THREE.Shape();
      shape.moveTo(side * 5, z * .18); shape.lineTo(side * 37, z - Math.sign(z) * 2.4); shape.lineTo(side * 37, z + Math.sign(z) * 2.4); shape.closePath();
      const lane = new THREE.Mesh(new THREE.ShapeGeometry(shape), material);
      lane.rotation.x = -Math.PI / 2; lane.position.y = .022; scene.add(lane);
    }
  }
  const centerLine = glowBox(.08, .025, FIELD.halfZ * 2 - 10, 0xf4fbff, .72);
  centerLine.position.y = .03; scene.add(centerLine);
}

function buildPrismSuperstructure() {
  const cyan = 0x39ecff, magenta = 0xff3faf, roofY = FIELD.ceilingY - .2;
  for (const x of [-36, -18, 0, 18, 36]) {
    const color = x < 0 ? cyan : x > 0 ? magenta : 0xf0fbff;
    const points = [
      new THREE.Vector3(x, FIELD.curveRadius, -FIELD.halfZ),
      new THREE.Vector3(x, roofY - 3, -FIELD.halfZ),
      new THREE.Vector3(x, roofY, 0),
      new THREE.Vector3(x, roofY - 3, FIELD.halfZ),
      new THREE.Vector3(x, FIELD.curveRadius, FIELD.halfZ)
    ];
    for (let index = 0; index < points.length - 1; index++) prismBeam(points[index], points[index + 1], .095, color, .72);
  }
  for (const z of [-FIELD.halfZ * .64, 0, FIELD.halfZ * .64]) {
    prismBeam(
      new THREE.Vector3(-FIELD.halfX + FIELD.cornerRadius, roofY, z),
      new THREE.Vector3(FIELD.halfX - FIELD.cornerRadius, roofY, z),
      .075,
      z < 0 ? cyan : z > 0 ? magenta : 0xdffaff,
      .58
    );
  }
  for (const x of [-FIELD.halfX * .66, -FIELD.halfX * .33, 0, FIELD.halfX * .33, FIELD.halfX * .66]) {
    prismBeam(
      new THREE.Vector3(x, roofY, -FIELD.halfZ + FIELD.cornerRadius),
      new THREE.Vector3(x, roofY, FIELD.halfZ - FIELD.cornerRadius),
      .06,
      x < 0 ? cyan : x > 0 ? magenta : 0xdffaff,
      .48
    );
  }
  const halo = new THREE.Mesh(new THREE.TorusGeometry(7.2, .11, 6, 48), new THREE.MeshBasicMaterial({ color: 0xdffaff, transparent: true, opacity: .86, toneMapped: false }));
  halo.rotation.x = Math.PI / 2; halo.position.y = roofY - 1.3; scene.add(halo);
  for (let index = 0; index < 6; index++) {
    const angle = index * Math.PI / 3;
    const point = new THREE.Vector3(Math.cos(angle) * 7.2, roofY - 1.3, Math.sin(angle) * 7.2);
    prismBeam(point, new THREE.Vector3(point.x * 1.7, roofY, point.z * 1.7), .045, index < 3 ? cyan : magenta, .62);
  }
}

function buildHyperdomeStructure() {
  const cyan = new THREE.MeshBasicMaterial({ color: 0x4cecff, transparent: true, opacity: .72, toneMapped: false });
  const magenta = new THREE.MeshBasicMaterial({ color: 0xff55b5, transparent: true, opacity: .72, toneMapped: false });
  const ribLimit = FIELD.halfX - FIELD.cornerRadius;
  for (let x = -ribLimit; x <= ribLimit; x += ribLimit / 4) for (const sideZ of [-1, 1]) {
    const points = [];
    for (let i = 0; i <= 8; i++) {
      const profile = transitionPoint(i / 8, false);
      points.push(new THREE.Vector3(x, profile.y + .08, sideZ * (FIELD.halfZ - profile.inset - .08)));
    }
    points.push(new THREE.Vector3(x, FIELD.ceilingY - FIELD.curveRadius, sideZ * (FIELD.halfZ - .08)));
    for (let i = 7; i >= 0; i--) {
      const profile = transitionPoint(i / 8, true);
      points.push(new THREE.Vector3(x, profile.y - .08, sideZ * (FIELD.halfZ - profile.inset - .08)));
    }
    const rib = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 30, .055, 5, false), x < 0 ? cyan : magenta);
    rib.name = 'hyperdomeCurveRib';
    scene.add(rib);
  }
  for (const z of [-38, 0, 38]) {
    const spine = glowBox(FIELD.halfX * 2 - 12, .07, .09, z < 0 ? 0x4cecff : z > 0 ? 0xff55b5 : 0xeaf8ff, .72);
    spine.name = 'hyperdomeRoofSpine';
    spine.position.set(0, FIELD.ceilingY - .1, z);
    scene.add(spine);
  }
}

function arenaPanel(width, height, depth, material, x, y, z, rx = 0, ry = 0, rz = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz); mesh.receiveShadow = true; scene.add(mesh); spectatorOccluderMeshes.push(mesh); return mesh;
}

function buildArenaTrim() {
  const straightWidth = (FIELD.halfX - FIELD.cornerRadius) * 2;
  for (const sideZ of [-1, 1]) for (const y of [FIELD.curveRadius, FIELD.ceilingY - FIELD.curveRadius]) {
    const rail = glowBox(straightWidth, .13, .14, sideZ < 0 ? 0x43eaff : 0xb978ff, 1);
    rail.position.set(0, y, sideZ * (FIELD.halfZ - .04)); scene.add(rail);
  }
  const flankLength = FIELD.halfZ - FIELD.cornerRadius - FIELD.goalHalf;
  const flankCenter = FIELD.goalHalf + flankLength / 2;
  for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) for (const y of [FIELD.curveRadius, FIELD.ceilingY - FIELD.curveRadius]) {
    const rail = glowBox(.14, .13, flankLength, sideX < 0 ? 0x39ecff : 0xff3faf, 1);
    rail.position.set(sideX * (FIELD.halfX - .04), y, sideZ * flankCenter); scene.add(rail);
  }
  for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) for (const y of [FIELD.curveRadius, FIELD.ceilingY - FIELD.curveRadius]) {
    const points = [];
    for (let i = 0; i <= 18; i++) {
      const phi = i * Math.PI / 2 / 18;
      points.push(new THREE.Vector3(
        sideX * (FIELD.halfX - FIELD.cornerRadius + FIELD.cornerRadius * Math.cos(phi)), y,
        sideZ * (FIELD.halfZ - FIELD.cornerRadius + FIELD.cornerRadius * Math.sin(phi))
      ));
    }
    const material = new THREE.MeshBasicMaterial({ color: sideX < 0 ? 0x39ecff : 0xff3faf, toneMapped: false });
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 24, .075, 5, false), material));
  }
}

function curvedStrip(pairs, material) {
  const vertices = [], indices = [], uvs = [];
  for (let i = 0; i < pairs.length; i++) {
    const [a, b] = pairs[i]; vertices.push(...a, ...b);
    const u = i / (pairs.length - 1); uvs.push(u, 0, u, 1);
  }
  for (let i = 0; i < pairs.length - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material); mesh.receiveShadow = true; scene.add(mesh); spectatorOccluderMeshes.push(mesh); return mesh;
}

function curvedPatch(uSteps, vSteps, pointAt, material) {
  const vertices = [], indices = [], uvs = [];
  for (let u = 0; u <= uSteps; u++) for (let v = 0; v <= vSteps; v++) {
    vertices.push(...pointAt(u / uSteps, v / vSteps)); uvs.push(u / uSteps, v / vSteps);
  }
  const row = vSteps + 1;
  for (let u = 0; u < uSteps; u++) for (let v = 0; v < vSteps; v++) {
    const a = u * row + v, b = a + 1, c = a + row, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material); mesh.receiveShadow = true; scene.add(mesh); spectatorOccluderMeshes.push(mesh); return mesh;
}

function buildSmoothArenaCurves(material) {
  const steps = 32;
  for (const sideZ of [-1, 1]) {
    const floorPairs = [], roofPairs = [];
    for (let i = 0; i <= steps; i++) {
      const floorProfile = transitionPoint(i / steps, false);
      const roofProfile = transitionPoint(i / steps, true);
      const z = sideZ * (FIELD.halfZ - floorProfile.inset);
      const floorY = floorProfile.y;
      const roofY = roofProfile.y;
      floorPairs.push([[-FIELD.halfX + FIELD.cornerRadius, floorY, z], [FIELD.halfX - FIELD.cornerRadius, floorY, z]]);
      roofPairs.push([[-FIELD.halfX + FIELD.cornerRadius, roofY, z], [FIELD.halfX - FIELD.cornerRadius, roofY, z]]);
    }
    curvedStrip(floorPairs, material); curvedStrip(roofPairs, material);
  }

  for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) {
    const zNear = sideZ * FIELD.goalHalf, zFar = sideZ * (FIELD.halfZ - FIELD.cornerRadius);
    const floorPairs = [], roofPairs = [];
    for (let i = 0; i <= steps; i++) {
      const floorProfile = transitionPoint(i / steps, false);
      const roofProfile = transitionPoint(i / steps, true);
      const x = sideX * (FIELD.halfX - floorProfile.inset);
      const floorY = floorProfile.y;
      const roofY = roofProfile.y;
      floorPairs.push([[x, floorY, zNear], [x, floorY, zFar]]);
      roofPairs.push([[x, roofY, zNear], [x, roofY, zFar]]);
    }
    curvedStrip(floorPairs, material); curvedStrip(roofPairs, material);
  }

  const cornerSteps = 36;
  for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) {
    const pairs = [];
    for (let i = 0; i <= cornerSteps; i++) {
      const phi = i * Math.PI / 2 / cornerSteps;
      const x = sideX * (FIELD.halfX - FIELD.cornerRadius + FIELD.cornerRadius * Math.cos(phi));
      const z = sideZ * (FIELD.halfZ - FIELD.cornerRadius + FIELD.cornerRadius * Math.sin(phi));
      pairs.push([[x, FIELD.curveRadius, z], [x, FIELD.ceilingY - FIELD.curveRadius, z]]);
    }
    curvedStrip(pairs, material);
    const cornerPoint = (u, v, top) => {
      const point = roundedCornerPoint({ sideX, sideZ, phi: u, theta: v, top });
      return [point.x, point.y, point.z];
    };
    curvedPatch(28, 18, (u, v) => cornerPoint(u, v, false), material);
    curvedPatch(28, 18, (u, v) => cornerPoint(u, v, true), material);
  }
}

function glowBox(x, y, z, color, intensity = 1) {
  return new THREE.Mesh(new THREE.BoxGeometry(x, y, z), new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: Math.min(1, intensity) }));
}
function buildGoal(side, color) {
  const mouthX = side * FIELD.halfX, depth = FIELD.goalDepth;
  const frameMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.9, metalness: .8, roughness: .2 });
  const frameCount = 2, frameMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), frameMat, frameCount * 3);
  const dummy = new THREE.Object3D(); let instance = 0;
  for (let i = 0; i < frameCount; i++) {
    const distance = i * (depth / (frameCount - 1));
    const x = mouthX + side * distance;
    const thickness = i === 0 ? .46 : .2;
    const factor = 1;
    const frameHeight = FIELD.goalHeight * factor;
    for (const z of [-FIELD.goalHalf * factor, FIELD.goalHalf * factor]) {
      dummy.position.set(x, frameHeight / 2, z);
      dummy.scale.set(thickness, frameHeight, thickness);
      dummy.updateMatrix(); frameMesh.setMatrixAt(instance++, dummy.matrix);
    }
    dummy.position.set(x, frameHeight, 0);
    dummy.scale.set(thickness, thickness, FIELD.goalHalf * 2 * factor + thickness);
    dummy.updateMatrix(); frameMesh.setMatrixAt(instance++, dummy.matrix);
  }
  frameMesh.instanceMatrix.needsUpdate = true; scene.add(frameMesh);

  const floorGlow = new THREE.Mesh(new THREE.PlaneGeometry(depth, FIELD.goalHalf * 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .08, toneMapped: false, side: THREE.DoubleSide }));
  floorGlow.rotation.x = -Math.PI / 2;
  floorGlow.position.set(mouthX + side * depth / 2, .045, 0); scene.add(floorGlow);

  const tunnelMat = new THREE.MeshStandardMaterial({ color: 0x07101a, emissive: color, emissiveIntensity: .09, metalness: .72, roughness: .34, side: THREE.DoubleSide });
  const tunnelCenter = mouthX + side * depth / 2;
  arenaPanel(depth, .12, FIELD.goalHalf * 2, tunnelMat, tunnelCenter, -.04, 0);
  arenaPanel(depth, FIELD.goalHeight, .18, tunnelMat, tunnelCenter, FIELD.goalHeight / 2, FIELD.goalHalf + .09);
  arenaPanel(depth, FIELD.goalHeight, .18, tunnelMat, tunnelCenter, FIELD.goalHeight / 2, -FIELD.goalHalf - .09);
  arenaPanel(depth, .18, FIELD.goalHalf * 2, tunnelMat, tunnelCenter, FIELD.goalHeight + .09, 0);
  const threshold = glowBox(.3, .14, FIELD.goalHalf * 2 + .35, color, .9);
  threshold.position.set(mouthX, .07, 0); scene.add(threshold);

  // Perspective rails make the physically modelled tunnel depth unmistakable from chase view.
  for (const z of [-FIELD.goalHalf, FIELD.goalHalf]) for (const y of [.18, FIELD.goalHeight * .52, FIELD.goalHeight - .12]) {
    const rail = glowBox(depth, .1, .13, color, .82);
    rail.name = 'goalDepthRail';
    rail.position.set(mouthX + side * depth / 2, y, z - Math.sign(z) * .07);
    scene.add(rail);
  }
  for (const z of [-FIELD.goalHalf * .5, 0, FIELD.goalHalf * .5]) {
    const roofRail = glowBox(depth, .1, .09, color, .58);
    roofRail.name = 'goalRoofRail';
    roofRail.position.set(mouthX + side * depth / 2, FIELD.goalHeight - .07, z);
    scene.add(roofRail);
  }

  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(FIELD.goalHalf * 2, FIELD.goalHeight), new THREE.MeshBasicMaterial({
    color: 0x03070c, side: THREE.DoubleSide
  }));
  backdrop.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
  backdrop.position.set(mouthX + side * (depth + .03), FIELD.goalHeight / 2, 0); scene.add(backdrop);

  const linerMat = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: .16, side: THREE.DoubleSide });
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(depth, FIELD.goalHalf * 2), linerMat);
  roof.rotation.x = Math.PI / 2; roof.position.set(mouthX + side * depth / 2, FIELD.goalHeight, 0); scene.add(roof);
  for (const z of [-FIELD.goalHalf, FIELD.goalHalf]) {
    const liner = new THREE.Mesh(new THREE.PlaneGeometry(depth, FIELD.goalHeight), linerMat);
    liner.position.set(mouthX + side * depth / 2, FIELD.goalHeight / 2, z); scene.add(liner);
  }
}

function buildBall() {
  const group = new THREE.Group();
  group.name = 'neonMatchBall';

  const graphiteCore = new THREE.Mesh(
    new THREE.IcosahedronGeometry(FIELD.ballRadius, 2),
    new THREE.MeshStandardMaterial({ color: 0x39ff14, emissive: 0x18ff00, emissiveIntensity: 1.2, metalness: .42, roughness: .24, flatShading: true })
  );
  graphiteCore.name = 'graphiteCore';
  graphiteCore.castShadow = true;
  group.add(graphiteCore);

  const geodesicSeams = new THREE.Mesh(
    new THREE.IcosahedronGeometry(FIELD.ballRadius * 1.008, 0),
    new THREE.MeshBasicMaterial({ color: 0xd5ff9b, wireframe: true, transparent: true, opacity: .52, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
  );
  geodesicSeams.name = 'geodesicSeams';
  group.add(geodesicSeams);

  const createBallHexPatch = (radius, angularRadius) => {
    const vertices = [0, 0, radius], indices = [];
    for (let i = 0; i < 6; i++) {
      const angle = i * Math.PI / 3;
      vertices.push(
        Math.cos(angle) * Math.sin(angularRadius) * radius,
        Math.sin(angle) * Math.sin(angularRadius) * radius,
        Math.cos(angularRadius) * radius
      );
    }
    for (let i = 0; i < 6; i++) indices.push(0, i + 1, (i + 1) % 6 + 1);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  };
  const panelGeometry = createBallHexPatch(FIELD.ballRadius * 1.01, .3);
  const panelMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x091522, emissiveIntensity: .35, metalness: .5, roughness: .3, polygonOffset: true, polygonOffsetFactor: -2 });
  const neonBallPanels = new THREE.InstancedMesh(panelGeometry, panelMaterial, 12);
  neonBallPanels.name = 'neonBallPanels';
  const panelBackings = new THREE.InstancedMesh(
    createBallHexPatch(FIELD.ballRadius * 1.005, .36),
    new THREE.MeshBasicMaterial({ color: 0x043b12 }),
    12
  );
  panelBackings.name = 'graphitePanelBackings';
  const phi = (1 + Math.sqrt(5)) / 2;
  const panelNormals = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) panelNormals.push(
    new THREE.Vector3(0, a, b * phi).normalize(),
    new THREE.Vector3(a, b * phi, 0).normalize(),
    new THREE.Vector3(b * phi, 0, a).normalize()
  );
  const panelDummy = new THREE.Object3D(), panelAxis = new THREE.Vector3(0, 0, 1);
  const cyanPanel = new THREE.Color(0x39ff14), magentaPanel = new THREE.Color(0xa6ff3d), whitePanel = new THREE.Color(0xf2ffe1);
  panelNormals.forEach((normal, index) => {
    panelDummy.position.set(0, 0, 0);
    panelDummy.quaternion.setFromUnitVectors(panelAxis, normal);
    panelDummy.rotateZ(index * .73);
    panelDummy.scale.set(1, 1, 1);
    panelDummy.updateMatrix();
    panelBackings.setMatrixAt(index, panelDummy.matrix);
    const panelScale = index % 3 === 2 ? .84 : 1;
    panelDummy.scale.set(panelScale, panelScale, 1);
    panelDummy.updateMatrix();
    neonBallPanels.setMatrixAt(index, panelDummy.matrix);
    const panelColor = normal.y > .28 ? cyanPanel : normal.z > .28 ? magentaPanel : whitePanel;
    neonBallPanels.setColorAt(index, panelColor);
  });
  neonBallPanels.instanceMatrix.needsUpdate = true;
  if (neonBallPanels.instanceColor) neonBallPanels.instanceColor.needsUpdate = true;
  panelBackings.instanceMatrix.needsUpdate = true;
  group.add(panelBackings);
  group.add(neonBallPanels);

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(FIELD.ballRadius * 1.12, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x39ff14, transparent: true, opacity: .075, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  halo.name = 'ballHalo';
  group.add(halo);
  return group;
}

function buildBallGroundHalo() {
  const texture = canvasTexture(128, 128, (ctx, width, height) => {
    const gradient = ctx.createRadialGradient(width / 2, height / 2, 4, width / 2, height / 2, width / 2);
    gradient.addColorStop(0, 'rgba(57,255,20,.95)');
    gradient.addColorStop(.34, 'rgba(57,255,20,.62)');
    gradient.addColorStop(.7, 'rgba(57,255,20,.22)');
    gradient.addColorStop(1, 'rgba(57,255,20,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  });
  const ballGroundHalo = new THREE.Mesh(
    new THREE.PlaneGeometry(FIELD.ballRadius * 3, FIELD.ballRadius * 3),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: .72, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
  );
  ballGroundHalo.name = 'ballGroundHalo';
  ballGroundHalo.rotation.x = -Math.PI / 2;
  ballGroundHalo.position.y = .06;
  return ballGroundHalo;
}

function spawnGoalExplosion(event) {
  if (!scene) return;
  const color = event.team === 0 ? 0x39ecff : 0xff3faf;
  const group = new THREE.Group();
  group.position.copy(vec(event.position || [event.team === 0 ? FIELD.halfX : -FIELD.halfX, 3, 0]));
  const flash = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  group.add(flash);
  const rings = [];
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.2, .13, 8, 36), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    ring.rotation.y = Math.PI / 2;
    ring.scale.setScalar(.01);
    group.add(ring); rings.push(ring);
  }
  const count = 72, positions = new Float32Array(count * 3), velocities = [];
  for (let i = 0; i < count; i++) {
    const angle = i * 2.399963, radial = 9 + (i % 7) * .65;
    const vertical = ((i * 37) % 29) / 28 * 2 - 1;
    velocities.push(new THREE.Vector3(Math.cos(angle) * radial, vertical * 8 + 3.5, Math.sin(angle) * radial));
  }
  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const particles = new THREE.Points(particleGeometry, new THREE.PointsMaterial({ color, size: .72, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true, toneMapped: false }));
  group.add(particles);
  scene.add(group);
  goalEffects.push({ group, flash, rings, particles, velocities, age: 0, duration: matchPreview ? 5 : 1.5 });
  goalShake = .72;
}

function updateGoalEffects(dt) {
  goalShake = Math.max(0, goalShake - dt);
  for (let index = goalEffects.length - 1; index >= 0; index--) {
    const effect = goalEffects[index];
    effect.age += dt;
    const progress = Math.min(1, effect.age / effect.duration);
    effect.flash.scale.setScalar(1 + progress * 8);
    effect.flash.material.opacity = Math.max(0, 1 - progress * 1.8);
    for (let i = 0; i < effect.rings.length; i++) {
      const wave = THREE.MathUtils.clamp((progress - i * .1) / .62, 0, 1);
      effect.rings[i].scale.setScalar(.01 + wave * (5.5 + i * 1.2));
      effect.rings[i].material.opacity = (1 - wave) * .86;
    }
    const positions = effect.particles.geometry.attributes.position.array;
    for (let i = 0; i < effect.velocities.length; i++) {
      const velocity = effect.velocities[i];
      velocity.y -= 5 * dt;
      velocity.multiplyScalar(Math.pow(.975, dt * 60));
      positions[i * 3] += velocity.x * dt;
      positions[i * 3 + 1] += velocity.y * dt;
      positions[i * 3 + 2] += velocity.z * dt;
    }
    effect.particles.geometry.attributes.position.needsUpdate = true;
    effect.particles.material.opacity = 1 - progress;
    if (progress >= 1) {
      scene.remove(effect.group);
      effect.group.traverse(object => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material)) object.material.forEach(material => material.dispose());
        else object.material?.dispose?.();
      });
      goalEffects.splice(index, 1);
    }
  }
}

function loftGeometry(sections) {
  const vertices = [], indices = [];
  for (const section of sections) {
    const bottomWidth = section.bottomWidth ?? section.width;
    const topWidth = section.topWidth ?? section.width;
    vertices.push(
      section.x, section.bottom, -bottomWidth,
      section.x, section.bottom, bottomWidth,
      section.x, section.top, topWidth,
      section.x, section.top, -topWidth
    );
  }
  for (let i = 0; i < sections.length - 1; i++) {
    const a = i * 4, b = a + 4;
    indices.push(
      a, b, a + 1, a + 1, b, b + 1,
      a + 1, b + 1, a + 2, a + 2, b + 1, b + 2,
      a + 2, b + 2, a + 3, a + 3, b + 2, b + 3,
      a + 3, b + 3, a, a, b + 3, b
    );
  }
  const last = (sections.length - 1) * 4;
  indices.push(0, 1, 2, 0, 2, 3, last, last + 2, last + 1, last, last + 3, last + 2);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

function addBox(group, size, position, material, rotation = null) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  group.add(mesh); return mesh;
}

const TRON_TRAIL_POINTS = 72;
const TRON_TRAIL_LIFETIME = 1800;

const tronSegmentDummy = new THREE.Object3D();
const tronSegmentDirection = new THREE.Vector3();
const tronSegmentColor = new THREE.Color();
const tronForwardAxis = new THREE.Vector3(1, 0, 0);
const tronWhite = new THREE.Color(0xffffff);

function createTronTrack(color) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const mesh = new THREE.InstancedMesh(geometry, material, TRON_TRAIL_POINTS - 1);
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  scene.add(mesh);
  return mesh;
}

function createTronTrail(color) {
  return { tracks: [createTronTrack(color), createTronTrack(color)], trailPoints: [], lastSample: null };
}

function updateTronTrack(track, trailPoints, side, now, color) {
  const segmentCount = Math.max(0, trailPoints.length - 1);
  track.count = segmentCount;
  for (let i = 0; i < segmentCount; i++) {
    const from = side < 0 ? trailPoints[i].left : trailPoints[i].right;
    const to = side < 0 ? trailPoints[i + 1].left : trailPoints[i + 1].right;
    tronSegmentDirection.subVectors(to, from);
    const length = tronSegmentDirection.length();
    if (length < .001) {
      tronSegmentDummy.scale.setScalar(.001);
    } else {
      tronSegmentDummy.quaternion.setFromUnitVectors(tronForwardAxis, tronSegmentDirection.normalize());
      tronSegmentDummy.scale.set(length + .06, .065, .19);
    }
    tronSegmentDummy.position.copy(from).lerp(to, .5);
    tronSegmentDummy.updateMatrix();
    track.setMatrixAt(i, tronSegmentDummy.matrix);
    const life = THREE.MathUtils.clamp(1 - (now - trailPoints[i + 1].time) / TRON_TRAIL_LIFETIME, 0, 1);
    const head = (i + 1) / Math.max(1, segmentCount);
    tronSegmentColor.copy(color).multiplyScalar(.12 + life * .88).lerp(tronWhite, head * head * .38);
    track.setColorAt(i, tronSegmentColor);
  }
  track.instanceMatrix.needsUpdate = true;
  if (track.instanceColor) track.instanceColor.needsUpdate = true;
}

function updateTronTrail(car, position, quaternion, active, now) {
  const trail = car.userData.tronTrail;
  if (!trail) return;
  trail.trailPoints = trail.trailPoints.filter(point => now - point.time < TRON_TRAIL_LIFETIME);
  const distance = trail.lastSample ? trail.lastSample.position.distanceTo(position) : Infinity;
  if (distance > 6) trail.trailPoints.length = 0;
  if (active && distance > .22) {
    const lateral = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize();
    const base = position.clone().addScaledVector(up, -.5);
    trail.trailPoints.push({
      left: base.clone().addScaledVector(lateral, -.64),
      right: base.clone().addScaledVector(lateral, .64),
      lateral,
      time: now
    });
    if (trail.trailPoints.length > TRON_TRAIL_POINTS) trail.trailPoints.shift();
    trail.lastSample = { position: position.clone(), time: now };
  }
  const color = car.userData.teamColor;
  updateTronTrack(trail.tracks[0], trail.trailPoints, -1, now, color);
  updateTronTrack(trail.tracks[1], trail.trailPoints, 1, now, color);
}

function buildCar(team) {
  const color = team === 0 ? 0x27dfff : 0xff299f;
  const group = new THREE.Group();
  const teamColor = new THREE.Color(color);
  const paintColor = teamColor.clone().multiplyScalar(.52);
  const paint = new THREE.MeshStandardMaterial({ color: paintColor, emissive: color, emissiveIntensity: .34, metalness: .82, roughness: .2, flatShading: true });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x03050a, metalness: .78, roughness: .3 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x010207, roughness: .82, metalness: .08 });
  const glass = new THREE.MeshPhysicalMaterial({ color: team === 0 ? 0x53bde4 : 0xb94791, transparent: true, opacity: .72, roughness: .08, metalness: .45, transmission: .12 });
  const glow = new THREE.MeshBasicMaterial({ color, toneMapped: false });
  const whiteGlow = new THREE.MeshBasicMaterial({ color: 0xdffaff, toneMapped: false });
  const redGlow = new THREE.MeshBasicMaterial({ color: 0xff174f, toneMapped: false });

  const shell = new THREE.Mesh(loftGeometry([
    { x: -1.43, bottom: -.45, top: .08, width: .66, topWidth: .72 },
    { x: -1.18, bottom: -.47, top: .33, width: .84, topWidth: .82 },
    { x: -.38, bottom: -.48, top: .39, width: .87, topWidth: .82 },
    { x: .55, bottom: -.48, top: .36, width: .86, topWidth: .79 },
    { x: 1.28, bottom: -.44, top: .23, width: .76, topWidth: .68 },
    { x: 1.53, bottom: -.38, top: .1, width: .56, topWidth: .52 }
  ]), paint);
  shell.name = 'neonAegisShell';
  shell.castShadow = true; group.add(shell);

  const canopy = new THREE.Mesh(loftGeometry([
    { x: -.86, bottom: .3, top: .38, width: .64, topWidth: .58 },
    { x: -.62, bottom: .34, top: .68, width: .65, topWidth: .52 },
    { x: .28, bottom: .37, top: .68, width: .63, topWidth: .5 },
    { x: .63, bottom: .32, top: .4, width: .62, topWidth: .57 }
  ]), glass);
  group.add(canopy);
  addBox(group, [.92, .055, 1.08], [-.17, .625, 0], carbon);

  // Low forward bumper keeps the enlarged wheels from visually riding over the ball.
  const frontBumper = addBox(group, [.44, .64, 1.56], [1.55, -.16, 0], paint);
  frontBumper.name = 'frontBumper';
  addBox(group, [.4, .1, 1.5], [1.55, -.4, 0], carbon);

  // Integrated rear deck: a low continuous aero bridge avoids thin floating supports.
  addBox(group, [.3, .14, 1.48], [-1.28, .31, 0], carbon, [0, 0, -.06]);
  addBox(group, [.22, .045, 1.5], [-1.3, .41, 0], glow, [0, 0, -.06]);

  // Hood spine, vents and illuminated side signatures.
  addBox(group, [.92, .025, .19], [.74, .255, 0], carbon, [0, 0, -.08]);
  for (const z of [-.34, .34]) addBox(group, [.42, .03, .16], [.57, .27, z], carbon, [0, 0, -.1]);
  for (const z of [-.805, .805]) addBox(group, [1.55, .035, .035], [.02, -.19, z], glow);

  // Razor-thin headlights and full-width rear light bar.
  for (const z of [-.42, .42]) {
    addBox(group, [.035, .1, .42], [1.515, -.04, z], whiteGlow, [0, 0, -.18]);
    addBox(group, [.07, .055, .34], [-1.41, -.03, z], redGlow);
  }
  addBox(group, [.055, .045, .72], [-1.41, -.05, 0], redGlow);

  const wheelRadius = CAR.wheelRadius;
  const tireGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, CAR.wheelWidth, 24, 1);
  tireGeo.rotateX(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(.31, .31, CAR.wheelWidth + .002, 16, 1);
  rimGeo.rotateX(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(.09, .09, CAR.wheelWidth + .006, 12);
  hubGeo.rotateX(Math.PI / 2);
  const rollers = [], frontWheels = [];
  for (const x of [-CAR.wheelX, CAR.wheelX]) for (const z of [-CAR.wheelZ, CAR.wheelZ]) {
    const steering = new THREE.Group(); steering.position.set(x, CAR.wheelCenterY, z);
    const roller = new THREE.Group();
    const tire = new THREE.Mesh(tireGeo, rubber); tire.castShadow = true; roller.add(tire);
    roller.add(new THREE.Mesh(rimGeo, glow));
    roller.add(new THREE.Mesh(hubGeo, whiteGlow));
    const rimRing = new THREE.Mesh(new THREE.TorusGeometry(.355, .032, 7, 24), glow);
    rimRing.position.z = Math.sign(z) * (CAR.wheelWidth / 2 + .005); roller.add(rimRing);
    steering.add(roller); group.add(steering); rollers.push(roller);
    const wheelArch = addBox(group, [.92, .12, .12], [x, .25, z - Math.sign(z) * .1], paint, [0, 0, x > 0 ? -.12 : .12]);
    wheelArch.name = 'wheelArch';
    if (x > 0) frontWheels.push(steering);
  }

  // Cheap underglow instead of a per-car dynamic point light.
  const underglow = new THREE.Mesh(new THREE.PlaneGeometry(2.45, 1.48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .22, blending: THREE.AdditiveBlending, depthWrite: false }));
  underglow.rotation.x = -Math.PI / 2; underglow.position.y = -.62; group.add(underglow);

  // Tron redesign: compact geometric reactors feed world-space light-cycle tracks.
  const tronBoost = new THREE.Group(); tronBoost.name = 'tronBoost'; tronBoost.visible = false;
  const reactors = [];
  const reactorGlow = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .92, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const reactorCore = new THREE.MeshBasicMaterial({ color: 0xf4ffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  for (const z of [-.34, .34]) {
    const reactor = new THREE.Group();
    reactor.position.set(-1.2, -.14, z);
    const aperture = new THREE.Mesh(new THREE.TorusGeometry(.18, .045, 8, 20), reactorGlow);
    aperture.rotation.y = Math.PI / 2; reactor.add(aperture);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(.105, .105, .11, 12), reactorCore);
    core.rotation.z = Math.PI / 2; reactor.add(core);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(.72, .055, .13), reactorGlow.clone());
    blade.position.x = -.4; reactor.add(blade);
    tronBoost.add(reactor); reactors.push(reactor);
  }
  const pulseCore = new THREE.Mesh(new THREE.OctahedronGeometry(.13, 0), reactorCore.clone());
  pulseCore.position.set(-1.67, -.14, 0); tronBoost.add(pulseCore);
  tronBoost.userData = { reactors, pulseCore };
  group.add(tronBoost);
  group.userData.rollers = rollers;
  group.userData.frontWheels = frontWheels;
  group.userData.wheelRadius = wheelRadius;
  group.userData.wheelSpin = 0;
  group.userData.lastSyncPosition = null;
  group.userData.teamColor = new THREE.Color(color);
  group.userData.tronTrail = createTronTrail(color);
  group.scale.setScalar(CAR.visualScale);
  return group;
}

function ensureCar(player) {
  if (!carMeshes.has(player.id)) { const mesh = buildCar(player.team); scene.add(mesh); carMeshes.set(player.id, mesh); }
  return carMeshes.get(player.id);
}
function vec(a) { return new THREE.Vector3(a[0], a[1], a[2]); }
function quat(a) { return new THREE.Quaternion(a[0], a[1], a[2], a[3]); }

function buildBoostPadVisuals(pads) {
  const small = pads.filter(pad => pad.amount < 100), large = pads.filter(pad => pad.amount === 100);
  const baseMaterial = new THREE.MeshStandardMaterial({ color: 0xff8a19, emissive: 0xff5400, emissiveIntensity: 2.1, metalness: .72, roughness: .25 });
  const glowMaterial = new THREE.MeshBasicMaterial({ color: 0xffc44d, transparent: true, opacity: .82, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const smallBase = new THREE.InstancedMesh(new THREE.CylinderGeometry(.62, .72, .09, 16), baseMaterial, small.length);
  const smallGlow = new THREE.InstancedMesh(new THREE.TorusGeometry(.45, .075, 6, 18), glowMaterial, small.length);
  const largeBase = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.02, 1.16, .14, 20), baseMaterial, large.length);
  const largeGlow = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(.44, 1), glowMaterial, large.length);
  const entries = new Map();
  small.forEach((pad, index) => entries.set(pad.id, { kind: 'small', index }));
  large.forEach((pad, index) => entries.set(pad.id, { kind: 'large', index }));
  for (const mesh of [smallBase, smallGlow, largeBase, largeGlow]) {
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
  boostPadVisuals = { smallBase, smallGlow, largeBase, largeGlow, entries, dummy: new THREE.Object3D() };
}

function updateBoostPadVisuals(state) {
  if (!state.boostPads?.length) return;
  if (!boostPadVisuals) buildBoostPadVisuals(state.boostPads);
  const { smallBase, smallGlow, largeBase, largeGlow, entries, dummy } = boostPadVisuals;
  const pulse = 1 + Math.sin(performance.now() * .006) * .09;
  for (const pad of state.boostPads) {
    const entry = entries.get(pad.id); if (!entry) continue;
    const scale = pad.active ? pulse : .001;
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(pad.x, .08, pad.z);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    const base = entry.kind === 'small' ? smallBase : largeBase;
    base.setMatrixAt(entry.index, dummy.matrix);
    if (entry.kind === 'small') {
      dummy.position.y = .16;
      dummy.rotation.x = Math.PI / 2;
      dummy.scale.setScalar(scale);
      dummy.updateMatrix(); smallGlow.setMatrixAt(entry.index, dummy.matrix);
    } else {
      dummy.position.y = .72 + Math.sin(performance.now() * .004 + entry.index) * .11;
      dummy.rotation.set(performance.now() * .0012, performance.now() * .0017, 0);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix(); largeGlow.setMatrixAt(entry.index, dummy.matrix);
    }
  }
  for (const mesh of [smallBase, smallGlow, largeBase, largeGlow]) mesh.instanceMatrix.needsUpdate = true;
}

function syncVisuals(state, snap = false, dt = 1 / 60) {
  if (!state || !scene) return;
  const ballBlend = snap ? 1 : 1 - Math.exp(-dt * 24);
  const carPositionBlend = snap ? 1 : 1 - Math.exp(-dt * 29);
  const carRotationBlend = snap ? 1 : 1 - Math.exp(-dt * 31);
  $('#score0').textContent = state.score[0]; $('#score1').textContent = state.score[1];
  updateBoostPadVisuals(state);
  ballMesh.position.lerp(vec(state.ball.p), ballBlend); ballMesh.quaternion.slerp(quat(state.ball.q), ballBlend);
  if (ballShadow) {
    const ballHeight = Math.max(0, state.ball.p[1] - FIELD.ballRadius);
    const shadowScale = 1 + Math.min(1.5, ballHeight * .055);
    ballShadow.position.set(ballMesh.position.x, .06, ballMesh.position.z);
    ballShadow.scale.setScalar(shadowScale);
    ballShadow.material.opacity = .72;
  }
  const alive = new Set();
  for (const p of state.players) {
    alive.add(p.id); const mesh = ensureCar(p);
    const targetPosition = vec(p.p), targetQuaternion = quat(p.q);
    const lastPosition = mesh.userData.lastSyncPosition;
    if (lastPosition) {
      const dx = targetPosition.x - lastPosition.x, dy = targetPosition.y - lastPosition.y, dz = targetPosition.z - lastPosition.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance < 4) {
        const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(targetQuaternion);
        const signedDistance = distance * (dx * forward.x + dy * forward.y + dz * forward.z >= 0 ? 1 : -1);
        mesh.userData.wheelSpin -= signedDistance / (mesh.userData.wheelRadius || .5);
      }
      lastPosition.copy(targetPosition);
    } else mesh.userData.lastSyncPosition = targetPosition.clone();
    for (const roller of mesh.userData.rollers || []) roller.rotation.z = mesh.userData.wheelSpin;
    const steeringAngle = p.id === localId ? -inputState.steer * .34 : 0;
    for (const wheel of mesh.userData.frontWheels || []) wheel.rotation.y += (steeringAngle - wheel.rotation.y) * .22;
    mesh.position.lerp(targetPosition, carPositionBlend); mesh.quaternion.slerp(targetQuaternion, carRotationBlend);
    const tronBoost = mesh.getObjectByName('tronBoost');
    if (tronBoost) {
      const active = boostVisualPreview || (p.boosting && p.boost > 0);
      const now = performance.now(), phase = now * .022;
      const pulse = 1 + Math.sin(phase) * .16;
      tronBoost.visible = active;
      for (let i = 0; i < (tronBoost.userData.reactors || []).length; i++) {
        const reactor = tronBoost.userData.reactors[i];
        reactor.scale.set(1 + pulse * .08, pulse, pulse);
        reactor.rotation.x = Math.sin(phase * .45 + i * Math.PI) * .16;
      }
      if (tronBoost.userData.pulseCore) {
        tronBoost.userData.pulseCore.rotation.x = phase * .7;
        tronBoost.userData.pulseCore.rotation.y = phase;
        tronBoost.userData.pulseCore.scale.setScalar(.8 + pulse * .24);
      }
      updateTronTrail(mesh, targetPosition, targetQuaternion, active, now);
    }
    if (p.id === localId) { $('#boostFill').style.width = `${p.boost}%`; $('#boostValue').textContent = Math.round(p.boost); }
  }
  for (const [id, mesh] of carMeshes) if (!alive.has(id)) {
    for (const track of mesh.userData.tronTrail?.tracks || []) {
      scene.remove(track); track.geometry.dispose(); track.material.dispose();
    }
    scene.remove(mesh); carMeshes.delete(id);
  }
}

function clampCameraInsideArena(candidate, margin = 6) {
  candidate.x = THREE.MathUtils.clamp(candidate.x, -FIELD.halfX + margin, FIELD.halfX - margin);
  candidate.z = THREE.MathUtils.clamp(candidate.z, -FIELD.halfZ + margin, FIELD.halfZ - margin);
  candidate.y = THREE.MathUtils.clamp(candidate.y, 1.2, FIELD.ceilingY - 1.2);
  const sideX = candidate.x < 0 ? -1 : 1, sideZ = candidate.z < 0 ? -1 : 1;
  const centerX = sideX * (FIELD.halfX - FIELD.cornerRadius);
  const centerZ = sideZ * (FIELD.halfZ - FIELD.cornerRadius);
  const dx = candidate.x - centerX, dz = candidate.z - centerZ;
  if (Math.abs(candidate.x) > Math.abs(centerX) && Math.abs(candidate.z) > Math.abs(centerZ)) {
    const radius = Math.hypot(dx, dz), maxRadius = FIELD.cornerRadius - margin;
    if (radius > maxRadius) {
      candidate.x = centerX + dx * maxRadius / radius;
      candidate.z = centerZ + dz * maxRadius / radius;
    }
  }
  return candidate;
}

function resolveCameraOcclusion(target, candidate) {
  const direction = candidate.clone().sub(target);
  const fullDistance = direction.length();
  if (fullDistance < 2.6 || arenaCameraOccluders.length === 0) return false;
  direction.multiplyScalar(1 / fullDistance);
  cameraRaycaster.set(target, direction);
  cameraRaycaster.near = .15;
  cameraRaycaster.far = fullDistance;
  const hit = cameraRaycaster.intersectObjects(arenaCameraOccluders, false)[0];
  if (!hit) return false;
  const safeDistance = Math.max(2.6, hit.distance - .85);
  candidate.copy(target).addScaledVector(direction, safeDistance);
  return true;
}

function updateSpectatorCamera(state, dt) {
  if (!state?.ball) return;
  const ball = vec(state.ball.p);
  const playerPositions = state.players.map(player => vec(player.p));
  const focus = ball.clone();
  if (playerPositions.length) {
    const playerCenter = playerPositions.reduce((sum, position) => sum.add(position), new THREE.Vector3()).multiplyScalar(1 / playerPositions.length);
    focus.lerp(playerCenter, .32);
  }
  focus.y = Math.max(1.4, ball.y * .42);
  // Never aim through the curved roof, side walls or goal structures. Objects in
  // those zones remain visible at the edge of the wide spectator frame.
  focus.x = THREE.MathUtils.clamp(focus.x, -FIELD.halfX + 18, FIELD.halfX - 18);
  focus.z = THREE.MathUtils.clamp(focus.z, -FIELD.halfZ + 18, FIELD.halfZ - 18);
  if (!cameraLookReady) cameraLookTarget.copy(focus);
  else cameraLookTarget.lerp(focus, 1 - Math.exp(-dt * 5));
  cameraLookReady = true;
  if (Math.abs(camera.fov - 88) > .01) {
    camera.fov = 88;
    camera.updateProjectionMatrix();
  }
  const desired = new THREE.Vector3(
    THREE.MathUtils.clamp(focus.x - 5, -FIELD.halfX + 24, FIELD.halfX - 24),
    26,
    THREE.MathUtils.clamp(focus.z + 5, -FIELD.halfZ + 24, FIELD.halfZ - 24)
  );
  if (goalShake > 0) {
    const strength = goalShake / .72;
    desired.x += Math.sin(performance.now() * .065) * .42 * strength;
    desired.y += Math.cos(performance.now() * .079) * .3 * strength;
  }
  camera.position.lerp(desired, 1 - Math.exp(-dt * 8));
  cameraOcclusionActive = false;
  cameraOcclusionDistance = camera.position.distanceTo(cameraLookTarget);
  camera.lookAt(cameraLookTarget);
}

function updateCamera(state, dt) {
  if (spectatorMode) return updateSpectatorCamera(state, dt);
  const me = state?.players.find(p => p.id === localId); if (!me) return;
  const renderedCar = networkMode ? carMeshes.get(localId) : null;
  const pos = renderedCar ? renderedCar.position.clone() : vec(me.p);
  const q = renderedCar ? renderedCar.quaternion.clone() : quat(me.q);
  const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  forward.y = 0; forward.normalize();
  if (forward.lengthSq() < .01) forward.set(1, 0, 0);
  const horizontalDistance = cameraDistance * Math.cos(cameraPitch);
  const height = cameraDistance * Math.sin(cameraPitch) + .8;
  const desired = pos.clone().add(forward.clone().multiplyScalar(-horizontalDistance)).add(new THREE.Vector3(0, height, 0));
  const lookAhead = 2.8;
  const look = pos.clone().add(forward.clone().multiplyScalar(lookAhead));
  look.y = pos.y + .15;
  if (!cameraLookReady || !networkMode) cameraLookTarget.copy(look);
  else cameraLookTarget.lerp(look, 1 - Math.exp(-dt * 14));
  cameraLookReady = true;

  // Keep the camera itself in a rounded inner shell; the raycast then handles
  // goal structures and obstacles that cross the sightline.
  clampCameraInsideArena(desired, 6);
  const horizontalGap = Math.hypot(desired.x - pos.x, desired.z - pos.z);
  if (horizontalGap < 2.5) desired.y += (2.5 - horizontalGap) * 1.1;
  if (goalShake > 0) {
    const strength = goalShake / .72;
    desired.x += Math.sin(performance.now() * .065) * .42 * strength;
    desired.y += Math.cos(performance.now() * .079) * .3 * strength;
    desired.z += Math.sin(performance.now() * .091) * .42 * strength;
  }
  const occluded = resolveCameraOcclusion(cameraLookTarget, desired);
  camera.position.lerp(desired, 1 - Math.exp(-dt * (occluded ? 24 : 8)));
  // A second pass prevents interpolation itself from spending frames behind a wall.
  const interpolationOccluded = resolveCameraOcclusion(cameraLookTarget, camera.position);
  cameraOcclusionActive = occluded || interpolationOccluded;
  cameraOcclusionDistance = camera.position.distanceTo(cameraLookTarget);
  camera.lookAt(cameraLookTarget);
}

function updatePerformance(now) {
  fpsFrames++;
  const elapsed = now - fpsWindowStart;
  if (elapsed < 2000) return;
  currentFps = fpsFrames * 1000 / elapsed;
  fpsFrames = 0; fpsWindowStart = now;
  let nextScale = renderScale;
  if (currentFps < 45 && renderScale > .65) nextScale = Math.max(.65, renderScale - .15);
  else if (currentFps > 57 && renderScale < 1 && now - lastQualityChange > 8000) nextScale = Math.min(1, renderScale + .1);
  if (nextScale !== renderScale) {
    renderScale = nextScale; lastQualityChange = now;
    renderer.setPixelRatio(basePixelRatio * renderScale);
    renderer.setSize(innerWidth, innerHeight, false);
  }
}

function sampleNetworkCamera(now) {
  if (!cameraQaEnabled || !networkMode || currentState?.status !== 'playing' || cameraQa.done) return;
  if (!cameraQa.start) cameraQa.start = now;
  const position = camera.position.clone(), quaternion = camera.quaternion.clone();
  if (now - cameraQa.start < 1000) {
    cameraQa.previousPosition = position;
    cameraQa.previousQuaternion = quaternion;
    return;
  }
  if (cameraQa.previousPosition) {
    const step = position.distanceTo(cameraQa.previousPosition);
    const angle = quaternion.angleTo(cameraQa.previousQuaternion);
    const linearJerk = Math.abs(step - cameraQa.previousStep);
    const angularJerk = Math.abs(angle - cameraQa.previousAngle);
    cameraQa.frames++;
    cameraQa.maxLinearJerk = Math.max(cameraQa.maxLinearJerk, linearJerk);
    cameraQa.sumLinearJerk2 += linearJerk * linearJerk;
    cameraQa.maxAngularStep = Math.max(cameraQa.maxAngularStep, angle);
    cameraQa.maxAngularJerk = Math.max(cameraQa.maxAngularJerk, angularJerk);
    cameraQa.sumAngularJerk2 += angularJerk * angularJerk;
    cameraQa.previousStep = step;
    cameraQa.previousAngle = angle;
  }
  cameraQa.previousPosition = position;
  cameraQa.previousQuaternion = quaternion;
  if (now - cameraQa.start >= 5000) {
    cameraQa.linearJerkRms = Math.sqrt(cameraQa.sumLinearJerk2 / Math.max(1, cameraQa.frames));
    cameraQa.angularJerkRms = Math.sqrt(cameraQa.sumAngularJerk2 / Math.max(1, cameraQa.frames));
    cameraQa.done = true;
  }
}

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - lastFrame) / 1000, .05); lastFrame = now;
  updateInput();
  if (localSim) {
    if (!spectatorMode) localSim.setInput(localId, inputState);
    accumulator += dt;
    while (accumulator >= 1 / 120) {
      if (!(kickoffPreview && localSim.status === 'countdown')) localSim.step(1 / 120);
      accumulator -= 1 / 120;
    }
    for (const event of localSim.drainEvents()) handleEvent(event);
    currentState = localSim.snapshot();
  }
  let renderState = currentState;
  if (networkMode) {
    const nowEpoch = Date.now();
    renderState = networkTimeline.sample(nowEpoch) || currentState;
    const localPlayer = localId ? networkTimeline.sampleLatestPlayer(localId, nowEpoch) : null;
    if (localPlayer && renderState) renderState = { ...renderState, players: renderState.players.map(player => player.id === localId ? localPlayer : player) };
  }
  syncVisuals(renderState, false, dt);
  updateGoalEffects(dt);
  updateCamera(renderState, dt);
  sampleNetworkCamera(now);
  updatePerformance(now);
  if (now >= nextDebugUpdate) {
    nextDebugUpdate = now + 250;
    const performanceInfo = { fps: +currentFps.toFixed(1), quality: +renderScale.toFixed(2), pixelRatio: +renderer.getPixelRatio().toFixed(2), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    window.__nr3d = { state: currentState, network: { ...networkTimeline.metrics }, performance: performanceInfo, camera: { p: camera.position.toArray(), q: camera.quaternion.toArray(), occlusion: { active: cameraOcclusionActive, distance: cameraOcclusionDistance, occluders: arenaCameraOccluders.length } }, cameraQa, cars: [...carMeshes].map(([id, mesh]) => ({ id, p: mesh.position.toArray(), ndc: mesh.position.clone().project(camera).toArray() })) };
    $('#debugState').textContent = JSON.stringify({ localId, physics: currentState?.physics, performance: performanceInfo, camera: camera.position.toArray(), cameraOcclusion: { active: cameraOcclusionActive, distance: cameraOcclusionDistance, occluders: arenaCameraOccluders.length }, cameraQa, activePads: currentState?.boostPads?.filter(p => p.active).length, players: currentState?.players.map(p => ({ id:p.id, p:p.p, q:p.q, boost:p.boost, boosting:p.boosting, aiVersion:p.aiVersion, aiState:p.aiState })), cars:[...carMeshes].map(([id,m])=>({id,p:m.position.toArray(),ndc:m.position.clone().project(camera).toArray()})) });
  }
  renderer.render(scene, camera);
}

function handleEvent(event) {
  if (event.type === 'countdown') announce(String(event.value), kickoffPreview ? 30000 : 900);
  if (event.type === 'go') announce('GO!', 850);
  if (event.type === 'goal') { spawnGoalExplosion(event); announce('GOAL!', 1400); }
  if (event.type === 'duelReset') announce('KICKOFF RESET', 1800);
  if (event.type === 'finished') {
    const result = spectatorMode ? `NOVA ${event.team + 1} WINS` : event.team === (currentState?.players.find(p => p.id === localId)?.team ?? 0) ? 'VICTORY' : 'DEFEAT';
    announce(result, 1300);
    clearTimeout(finishOverlayTimer);
    finishOverlayTimer = setTimeout(() => showMatchEnd(event), 1250);
  }
}
function announce(text, duration = 1000) { $('#announcement').textContent = text; clearTimeout(announcementTimer); announcementTimer = setTimeout(() => $('#announcement').textContent = '', duration); }

function updateInput() {
  const pad = navigator.getGamepads?.()[0];
  Object.assign(inputState, controlsFromHeldKeys(held));
  inputState.airRoll = inputState.roll;
  if (pad) {
    inputState.steer = Math.abs(pad.axes[0]) > .12 ? -pad.axes[0] : inputState.steer;
    inputState.throttle = (pad.buttons[7]?.value || 0) - (pad.buttons[6]?.value || 0);
    inputState.airRoll = Math.abs(pad.axes[2] || 0) > .15 ? pad.axes[2] : inputState.airRoll;
    inputState.jump ||= pad.buttons[0]?.pressed; inputState.boost ||= pad.buttons[1]?.pressed;
    inputState.handbrake ||= pad.buttons[2]?.pressed;
  }
  if (trailDemo) {
    inputState.throttle = 1;
    inputState.steer = Math.sin(performance.now() * .0011) * .46;
  }
}

addEventListener('keydown', event => {
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.code)) event.preventDefault();
  held.add(event.code);
});
addEventListener('keyup', event => held.delete(event.code));
for (const button of document.querySelectorAll('[data-key]')) {
  const key = button.dataset.key;
  const down = event => { event.preventDefault(); held.add(key); button.classList.add('active'); try { button.setPointerCapture(event.pointerId); } catch {} };
  const up = event => { event.preventDefault(); held.delete(key); button.classList.remove('active'); };
  button.addEventListener('pointerdown', down); button.addEventListener('pointerup', up); button.addEventListener('pointercancel', up); button.addEventListener('lostpointercapture', up);
}
async function sampleNetworkClock() {
  if (!socket?.connected) return;
  const startedAt = Date.now();
  try {
    const reply = await socket.timeout(4000).emitWithAck('networkPing', {});
    const endedAt = Date.now();
    if (Number.isFinite(reply?.serverTime)) networkTimeline.addClockSample(reply.serverTime, startedAt, endedAt);
  } catch {}
}
setInterval(sampleNetworkClock, 5000);
setInterval(() => { if (networkMode && socket?.connected && localId) socket.emit('input', inputState); }, 1000 / 30);
function resize() { if (!renderer) return; camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); }
