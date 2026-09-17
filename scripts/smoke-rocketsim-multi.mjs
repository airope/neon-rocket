import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const origin = process.argv[2] || 'http://127.0.0.1:3444';
const options = { transports: ['websocket', 'polling'], timeout: 8000, reconnection: false, forceNew: true };
const a = io(origin, options), b = io(origin, options);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, timeout = 9000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('multiplayer smoke timeout');
    await wait(25);
  }
};
const connect = socket => new Promise((resolve, reject) => {
  if (socket.connected) return resolve();
  socket.once('connect', resolve); socket.once('connect_error', reject);
});

let statesA = [], statesB = [], joinedA, joinedB;
a.on('joined', data => { joinedA = data; });
b.on('joined', data => { joinedB = data; });
a.on('state', state => statesA.push(state));
b.on('state', state => statesB.push(state));

try {
  await Promise.all([connect(a), connect(b)]);
  const created = await a.timeout(8000).emitWithAck('createRoom', { name: 'Smoke A' });
  assert.equal(created.ok, true);
  assert.equal(created.engine, 'rocketsim-wasm');
  await until(() => joinedA);
  const joined = await b.timeout(8000).emitWithAck('joinRoom', { roomCode: created.roomCode, name: 'Smoke B' });
  assert.equal(joined.ok, true);
  await until(() => joinedB && statesA.some(state => state.status === 'playing') && statesB.some(state => state.status === 'playing'));

  const playing = statesA.findLast(state => state.status === 'playing');
  assert.equal(playing.physics.engine, 'rocketsim-wasm');
  assert.equal(playing.physics.tickRate, 120);
  assert.equal(playing.players.length, 2);
  const startX = playing.players.find(player => player.id === joinedA.id).p[0];
  const timer = setInterval(() => a.emit('input', { throttle: 1, boost: true }), 1000 / 30);
  await wait(1600);
  clearInterval(timer);
  await until(() => statesA.findLast(state => state.status === 'playing')?.players.find(player => player.id === joinedA.id).p[0] > startX + 5, 3000);
  const final = statesA.findLast(state => state.status === 'playing');
  const finalX = final.players.find(player => player.id === joinedA.id).p[0];
  assert.ok(statesA.length >= 40 && statesB.length >= 40);
  assert.ok(statesA.every((state, index) => index === 0 || state.sequence > statesA[index - 1].sequence));
  console.log(JSON.stringify({
    ok: true,
    origin,
    roomCode: created.roomCode,
    engine: final.physics.engine,
    simulationTick: final.simulationTick,
    snapshotsA: statesA.length,
    snapshotsB: statesB.length,
    startX,
    finalX,
    displacement: finalX - startX,
    score: final.score
  }, null, 2));
} finally {
  a.disconnect(); b.disconnect();
}
