import express from 'express';
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { Server } from 'socket.io';
import { ARENA_VERSION, FIELD, GameSimulation, PHYSICS_VERSION } from './shared/simulation-v3.js';
import { NovaMatchStats, NovaStatsStore, buildVersionMetadata } from './server/nova-stats.js';
import { FixedStepClock } from './server/fixed-step.js';
import { stampSnapshot } from './server/network-state.js';
import { createRocketSimRoom } from './server/rocketsim-room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export async function createGameServer({ port = Number(process.env.PORT || 3444), host = process.env.HOST || '127.0.0.1', allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean), roomFactory = createRocketSimRoom, randomIndex = randomInt, statsPath = process.env.NOVA_STATS_DB || path.join(__dirname, 'data/nova-stats.sqlite'), statsStore: suppliedStatsStore, limits = {} } = {}) {
const limitSpec = {
  maxRooms: ['MAX_ROOMS', 16], maxConnections: ['MAX_CONNECTIONS', 128],
  maxConnectionsPerIp: ['MAX_CONNECTIONS_PER_IP', 16], maxMessageBytes: ['MAX_MESSAGE_BYTES', 8192],
  waitingRoomMs: ['ROOM_WAITING_TTL_MS', 120000], finishedRoomMs: ['ROOM_FINISHED_TTL_MS', 120000],
  idleRoomMs: ['ROOM_IDLE_TTL_MS', 300000], inputStaleMs: ['INPUT_STALE_MS', 250],
  eventRate: ['EVENT_RATE', 90], eventBurst: ['EVENT_BURST', 180],
  commandRate: ['ROOM_COMMAND_RATE', 1], commandBurst: ['ROOM_COMMAND_BURST', 8],
  ipCreateRate: ['IP_CREATE_RATE', 0.2], ipCreateBurst: ['IP_CREATE_BURST', 4]
};
limits = Object.fromEntries(Object.entries(limitSpec).map(([key, [env, fallback]]) => {
  const value = Number(limits[key] ?? process.env[env] ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || value > 2147483647 || (!key.endsWith('Rate') && !Number.isInteger(value))) throw new Error(`Invalid limit ${key} (${env})`);
  return [key, value];
}));
const configuredOrigins = new Set(allowedOrigins.map(value => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw new Error('ALLOWED_ORIGINS must contain exact http(s) origins without paths.');
  return value;
}));
const originAllowed = origin => {
  if (origin === undefined) return true; // Anonymous non-browser tools; not authentication.
  if (configuredOrigins.size) return configuredOrigins.has(origin);
  const actualPort = server.address()?.port ?? port;
  return origin === `http://localhost:${actualPort}` || origin === `http://127.0.0.1:${actualPort}`;
};
const timers = [];
const every = (fn, ms) => timers.push(setInterval(fn, ms));
const app = express();
const server = createServer(app);
const connections = new Map();
const addressBudgets = new Map();
function addressBudget(ip) {
  const now = performance.now();
  for (const [key, value] of addressBudgets) {
    if (value.expires <= now && ![...connections.values()].some(item => item.ip === key)) addressBudgets.delete(key);
  }
  let value = addressBudgets.get(ip);
  if (!value) {
    if (addressBudgets.size >= 1024) return null;
    value = {
      connect: bucket(2, 10), event: bucket(500, 1000), command: bucket(4, 24),
      create: bucket(limits.ipCreateRate ?? 0.2, limits.ipCreateBurst ?? 4)
    };
    addressBudgets.set(ip, value);
  }
  value.expires = now + 60000;
  return value;
}
const maxConnections = limits.maxConnections ?? 128;
const maxConnectionsPerIp = limits.maxConnectionsPerIp ?? 16;
const io = new Server(server, {
  transports: ['polling', 'websocket'],
  maxHttpBufferSize: limits.maxMessageBytes ?? 8192,
  cors: { origin: (origin, callback) => callback(null, originAllowed(origin)) },
  allowRequest(req, callback) {
    if (!originAllowed(req.headers.origin)) return callback('Origin refusée.', false);
    // Never trust user-supplied forwarding headers. A proxy shares its own budget.
    const ip = req.socket.remoteAddress;
    const count = [...connections.values()].filter(item => item.ip === ip).length;
    if (connections.size >= maxConnections || count >= maxConnectionsPerIp) return callback('Serveur complet.', false);
    const budget = addressBudget(ip);
    if (!budget || !budget.connect()) return callback('Trop de connexions.', false);
    const admission = { ip, connected: false };
    connections.set(req, admission);
    req.once('close', () => { if (!admission.connected) connections.delete(req); });
    callback(null, true);
  }
});
io.engine.on('connection', client => {
  const req = client.request;
  const admission = connections.get(req);
  if (admission) admission.connected = true;
  client.once('close', () => connections.delete(req));
});
const rooms = new Map();
const pendingCodes = new Set();
let closing = false;
const maxRooms = limits.maxRooms ?? 16;
const LIVE_DUEL_CHANNEL = 'nova-duel-live';
const networkDiagnostics = { tickRate: 0, snapshotRate: 0, catchUpSteps: 0, droppedSimulationMs: 0, statsWriteErrors: 0 };
let diagnosticTicks = 0, diagnosticSnapshots = 0, diagnosticStartedAt = performance.now();
const simulationSource = fs.readFileSync(path.join(__dirname, 'shared/simulation-v3.js'), 'utf8');
const statsMetadata = buildVersionMetadata({
  source: simulationSource,
  nova1Version: 'nova1-direct-1.0.0',
  nova2Version: 'nova2-tactical-2.3.0',
  simulationVersion: '60-rapier',
  physicsVersion: PHYSICS_VERSION,
  arenaVersion: ARENA_VERSION,
  field: FIELD
});
const statsStore = suppliedStatsStore ?? new NovaStatsStore(statsPath);

function createLiveDuel() {
  const sim = new GameSimulation({ mode: 'duel' });
  sim.addPlayer({ id: 'NOVA1', name: 'NOVA 1', team: 0, isBot: true, aiVersion: 1 });
  sim.addPlayer({ id: 'NOVA2', name: 'NOVA 2', team: 1, isBot: true, aiVersion: 2 });
  sim.start();
  return { sim, restartAt: 0, stats: new NovaMatchStats(statsMetadata), sequence: 0, simulationTick: 0 };
}
const liveDuel = createLiveDuel();

app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));
app.get('/game-v60.js', (_, res) => res.sendFile(path.join(__dirname, 'public/game.js')));
app.get('/shared/rapier-engine.js', (_, res) => {
  const source = fs.readFileSync(path.join(__dirname, 'shared/rapier-engine.js'), 'utf8')
    .replace("from '@dimforge/rapier3d-deterministic-compat'", "from '/vendor/rapier/rapier.mjs'");
  res.type('application/javascript').send(source);
});
app.get('/arena-geometry.js', (_, res) => res.sendFile(path.join(__dirname, 'shared/arena-geometry.js')));
app.use('/shared', express.static(path.join(__dirname, 'shared'), { maxAge: 0 }));
app.use('/native/rocketsim/dist', express.static(path.join(__dirname, 'native/rocketsim/dist'), { etag: true, maxAge: 0 }));
app.use('/native/rocketsim', express.static(path.join(__dirname, 'native/rocketsim/dist'), { etag: true, maxAge: 0 }));
app.get('/vendor/three.module.js', (_, res) => res.sendFile(path.join(__dirname, 'node_modules/three/build/three.module.js')));
app.get('/vendor/three.core.js', (_, res) => res.sendFile(path.join(__dirname, 'node_modules/three/build/three.core.js')));
app.get('/vendor/cannon-es.js', (_, res) => res.sendFile(path.join(__dirname, 'node_modules/cannon-es/dist/cannon-es.js')));
app.get('/vendor/rapier/rapier.mjs', (_, res) => res.sendFile(path.join(__dirname, 'node_modules/@dimforge/rapier3d-deterministic-compat/rapier.mjs')));
app.get('/healthz', (_, res) => res.json({ ok: true, game: 'Neon Rocket 3D', rooms: rooms.size, liveDuelViewers: io.sockets.adapter.rooms.get(LIVE_DUEL_CHANNEL)?.size || 0 }));
app.get('/api/network-diagnostics', (_, res) => res.json({ ...networkDiagnostics, rooms: rooms.size, snapshotTargetHz: 20, simulationTargetHz: 120 }));
app.get('/api/nova-stats', (_, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(statsStore.getDashboard());
});
app.get('/api/nova-stats/matches/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const match = statsStore.getMatch(req.params.id);
  if (!match) return res.status(404).json({ error: 'Match introuvable.' });
  res.json(match);
});

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 128; attempt++) {
    const value = Array.from({ length: 6 }, () => chars[randomIndex(chars.length)]).join('');
    if (!rooms.has(value) && !pendingCodes.has(value)) return value;
  }
  throw new Error('Room-code allocation exhausted.');
}
function safeName(value) { return (typeof value === 'string' ? value.trim().slice(0, 18) : '') || 'Pilote'; }
function closeRoom(room, reason = 'peer-left') {
  if (rooms.get(room.code) !== room) return;
  rooms.delete(room.code);
  room.closed = true;
  for (const id of io.sockets.adapter.rooms.get(room.code) || []) {
    const member = io.sockets.sockets.get(id);
    if (!member) continue;
    member.data.room = null;
    member.leave(room.code);
    member.emit('roomClosed', { roomCode: room.code, reason });
  }
  room.rematchVotes.clear();
  room.sim.free?.();
}
function leaveCurrent(socket) {
  if (socket.data.creation) socket.data.creation.cancelled = true;
  if (socket.data.liveDuel) {
    socket.leave(LIVE_DUEL_CHANNEL);
    socket.data.liveDuel = false;
  }
  const code = socket.data.room;
  if (!code) return;
  const room = rooms.get(code);
  if (room) closeRoom(room);
  // On disconnect Socket.IO has already removed channel membership.
  socket.leave(code);
  socket.data.room = null;
}
function joinRoom(socket, room, name, team) {
  leaveCurrent(socket);
  room.rematchVotes?.clear();
  room.sim.addPlayer({ id: socket.id, name: safeName(name), team });
  socket.data.room = room.code;
  socket.join(room.code);
  socket.emit('joined', { roomCode: room.code, id: socket.id, team });
}

function bucket(rate, burst) {
  let tokens = burst, last = performance.now();
  return () => {
    const now = performance.now();
    tokens = Math.min(burst, tokens + (now - last) * rate / 1000); last = now;
    if (tokens < 1) return false;
    tokens--; return true;
  };
}
const commandEvents = new Set(['createRoom', 'joinRoom', 'watchNovaDuel', 'rematchRequest']);
io.on('connection', socket => {
  const sharedBudget = addressBudget(socket.handshake.address);
  const eventBudget = bucket(limits.eventRate ?? 90, limits.eventBurst ?? 180);
  const commandBudget = bucket(limits.commandRate ?? 1, limits.commandBurst ?? 8);
  let violations = 0;
  socket.use((packet, next) => {
    sharedBudget.expires = performance.now() + 60000;
    if (!eventBudget() || !sharedBudget.event() || (commandEvents.has(packet[0]) && (!commandBudget() || !sharedBudget.command())) || (packet[0] === 'createRoom' && !sharedBudget.create())) {
      const ack = packet.at(-1);
      if (typeof ack === 'function') ack({ ok: false, code: 'RATE_LIMIT', error: 'Trop de requêtes. Réessayez bientôt.' });
      if (++violations >= 20) socket.disconnect(true);
      return;
    }
    next();
  });
  // Network payloads are untrusted; validate before parameter destructuring.
  const onRequest = (event, handler) => socket.on(event, (payload, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload))) {
      ack({ ok: false, error: 'Message invalide.' });
      return;
    }
    try {
      Promise.resolve(handler(payload || {}, ack)).catch(() => ack({ ok: false, error: 'Requête refusée.' }));
    } catch {
      ack({ ok: false, error: 'Requête refusée.' });
    }
  });
  onRequest('watchNovaDuel', (_payload = {}, ack = () => {}) => {
    leaveCurrent(socket);
    socket.data.liveDuel = true;
    socket.join(LIVE_DUEL_CHANNEL);
    const state = { ...liveDuel.sim.snapshot(), live: true, sequence: liveDuel.sequence, serverTime: Date.now(), simulationTick: liveDuel.simulationTick };
    ack({ ok: true, state, viewers: io.sockets.adapter.rooms.get(LIVE_DUEL_CHANNEL)?.size || 1 });
  });

  onRequest('createRoom', async ({ name } = {}, ack = () => {}) => {
    if (socket.data.creation) return ack({ ok: false, error: 'Création déjà en cours.' });
    if (rooms.size + pendingCodes.size >= maxRooms) return ack({ ok: false, error: 'Serveur complet.' });
    const code = roomCode();
    const creation = {};
    socket.data.creation = creation;
    pendingCodes.add(code);
    let room;
    try {
      const sim = await roomFactory();
      const now = performance.now();
      room = { code, engine: 'rocketsim', sim, rematchVotes: new Set(), sequence: 0, simulationTick: 0, lastActivity: now, statusSince: now, lastStatus: sim.status, inputAt: new Map() };
      if (!socket.connected || creation.cancelled || closing) {
        room.closed = true;
        room.sim.free?.();
        return ack({ ok: false, error: 'Création annulée.' });
      }
      rooms.set(code, room);
      joinRoom(socket, room, name, 0);
      ack({ ok: true, roomCode: code, engine: 'rocketsim-wasm' });
    } catch (error) {
      if (room && !room.closed) closeRoom(room, 'creation-failed');
      console.error('RocketSim room creation failed', error);
      ack({ ok: false, error: 'RocketSim est indisponible sur le serveur.' });
    } finally {
      pendingCodes.delete(code);
      if (socket.data.creation === creation) socket.data.creation = null;
    }
  });

  onRequest('joinRoom', ({ roomCode: raw, name } = {}, ack = () => {}) => {
    const code = (typeof raw === 'string' ? raw : '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: 'Salon introuvable.' });
    if (socket.data.room === code) return ack({ ok: false, error: 'Vous êtes déjà dans ce salon.' });
    if (room.sim.players.size >= 2 || room.sim.status !== 'waiting') return ack({ ok: false, error: 'Ce salon est déjà complet.' });
    joinRoom(socket, room, name, 1);
    room.sim.start();
    io.to(code).emit('matchStarted');
    ack({ ok: true, roomCode: code });
  });

  onRequest('input', input => {
    const room = rooms.get(socket.data.room);
    if (room) {
      const controls = {};
      for (const key of ['throttle', 'steer', 'pitch', 'yaw', 'roll', 'airRoll']) {
        if (input[key] !== undefined) controls[key] = typeof input[key] === 'number' && Number.isFinite(input[key]) ? Math.max(-1, Math.min(1, input[key])) : 0;
      }
      for (const key of ['jump', 'boost', 'handbrake']) controls[key] = input[key] === true;
      room.sim.setInput(socket.id, controls);
      room.lastActivity = performance.now();
      room.inputAt.set(socket.id, room.lastActivity);
    }
  });
  onRequest('networkPing', (_payload = {}, ack = () => {}) => ack({ serverTime: Date.now() }));
  onRequest('rematchRequest', (_payload = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.room);
    if (!room || room.sim.status !== 'finished') return ack({ ok: false, error: 'La partie n’est pas terminée.' });
    room.rematchVotes.add(socket.id);
    const required = [...room.sim.players.values()].filter(player => !player.isBot).length;
    const votes = room.rematchVotes.size;
    io.to(room.code).emit('rematchVote', { votes, required });
    const ready = required >= 2 && votes >= required;
    if (ready) {
      room.rematchVotes.clear();
      room.sim.start();
      io.to(room.code).emit('rematchStarted');
    }
    ack({ ok: true, votes, required, ready });
  });
  socket.on('leaveRoom', () => leaveCurrent(socket));
  socket.on('disconnect', () => leaveCurrent(socket));
});

function stepAuthoritativeSimulations(dt) {
  for (const room of rooms.values()) {
    const now = performance.now();
    if (room.lastStatus !== room.sim.status) {
      room.lastStatus = room.sim.status; room.statusSince = now;
    }
    const expired = room.sim.status === 'waiting'
      ? now - room.statusSince >= (limits.waitingRoomMs ?? 120000)
      : room.sim.status === 'finished'
        ? now - room.statusSince >= (limits.finishedRoomMs ?? 120000)
        : now - room.lastActivity >= (limits.idleRoomMs ?? 300000);
    if (expired) { closeRoom(room, 'expired'); continue; }
    for (const [id, updated] of room.inputAt) {
      if (now - updated >= (limits.inputStaleMs ?? 250)) {
        room.sim.setInput(id, {}); room.inputAt.delete(id);
      }
    }
    room.sim.step(dt);
    room.simulationTick++;
    for (const event of room.sim.drainEvents()) io.to(room.code).emit('gameEvent', event);
  }
  const now = Date.now();
  if (liveDuel.restartAt && now >= liveDuel.restartAt) {
    liveDuel.restartAt = 0;
    liveDuel.sim.start();
    liveDuel.stats = new NovaMatchStats(statsMetadata);
    io.to(LIVE_DUEL_CHANNEL).emit('rematchStarted');
  }
  liveDuel.stats.beforeStep(liveDuel.sim);
  liveDuel.sim.step(dt);
  liveDuel.simulationTick++;
  const events = liveDuel.sim.drainEvents();
  liveDuel.stats.afterStep(liveDuel.sim, events, dt);
  for (const event of events) {
    io.to(LIVE_DUEL_CHANNEL).emit('gameEvent', event);
    if (event.type === 'finished') {
      try { statsStore.saveMatch(liveDuel.stats.finalize(liveDuel.sim)); }
      catch {
        networkDiagnostics.statsWriteErrors++;
        console.error('NOVA statistics write failed; live duel continues (see statsWriteErrors).');
      }
      liveDuel.restartAt = now + 8000;
    }
  }
  diagnosticTicks++;
}

const simulationClock = new FixedStepClock({ stepMs: 1000 / 120 });
every(() => {
  const steps = simulationClock.advance(performance.now(), stepAuthoritativeSimulations);
  networkDiagnostics.catchUpSteps += Math.max(0, steps - 1);
  networkDiagnostics.droppedSimulationMs = +simulationClock.droppedMilliseconds.toFixed(2);
}, 1000 / 120);
every(() => {
  const serverTime = Date.now();
  for (const room of rooms.values()) io.to(room.code).volatile.emit('state', stampSnapshot(room, serverTime));
  const liveState = { ...stampSnapshot(liveDuel, serverTime), live: true };
  io.to(LIVE_DUEL_CHANNEL).volatile.emit('state', liveState);
  diagnosticSnapshots++;
}, 1000 / 20);
every(() => {
  const now = performance.now(), seconds = Math.max(.001, (now - diagnosticStartedAt) / 1000);
  networkDiagnostics.tickRate = +(diagnosticTicks / seconds).toFixed(2);
  networkDiagnostics.snapshotRate = +(diagnosticSnapshots / seconds).toFixed(2);
  diagnosticTicks = 0; diagnosticSnapshots = 0; diagnosticStartedAt = now;
}, 2000);

await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
return { server, io, rooms, liveDuel, async close() {
  closing = true;
  for (const timer of timers) clearInterval(timer);
  for (const room of rooms.values()) closeRoom(room, 'shutdown');
  await new Promise(resolve => io.close(resolve));
  liveDuel.sim.free?.();
  statsStore.close?.();
} };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const game = await createGameServer();
  console.log(`Neon Rocket 3D listening on http://localhost:${game.server.address().port}`);
}
