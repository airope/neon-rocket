import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the real UI handlers without starting WebGL or a network transport.
function clientUI() {
  const nodes = new Map();
  const $ = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} } });
    return nodes.get(selector);
  };
  const handlers = {};
  const socket = { connected: false, on(name, fn) { handlers[name] = fn; }, timeout() { return this; }, async emitWithAck() { return { ok: true, votes: 1, required: 2 }; } };
  const context = vm.createContext({ document: { querySelector: $ }, window: { io: true }, io: () => socket,
    localStorage: { getItem() {}, setItem() {} }, location: { search: '' }, performance: { now: () => 0 },
    URLSearchParams, THREE: { Vector3: class {}, Raycaster: class {} }, NetworkTimeline: class { reset() {} },
    blankInput: () => ({}), setTimeout: () => 0, clearTimeout() {}, spawnGoalExplosion() {}, sampleNetworkClock() {} });
  const source = read('public/game.js');
  vm.runInContext(source.slice(0, source.indexOf('function init3D()')).replace(/^import .*\n/gm, '') +
    source.slice(source.indexOf('function handleEvent('), source.indexOf('function updateInput(')), context);
  return { $, handlers, socket, run: code => vm.runInContext(code, context) };
}

test('client lifecycle, connectivity and validation messages are English', async () => {
  const { $, handlers, run } = clientUI();
  assert.equal($('#name').value, 'Player');
  handlers.connect();
  assert.equal($('#connection').textContent, 'MULTIPLAYER SERVER CONNECTED');
  handlers.connect_error();
  assert.equal($('#connection').textContent, 'MULTIPLAYER UNAVAILABLE · SOLO AVAILABLE');
  await $('#create').onclick();
  assert.equal($('#error').textContent, 'Multiplayer is unavailable. Solo mode is still available.');
  run('networkMode = true'); handlers.roomClosed();
  assert.equal($('#error').textContent, 'Room closed: opponent left or the wait timed out.');
  for (const [event, expected] of [[{type:'countdown',value:3},'3'],[{type:'go'},'GO!'],[{type:'goal'},'GOAL!'],[{type:'duelReset'},'KICKOFF RESET']]) {
    run(`handleEvent(${JSON.stringify(event)})`);
    assert.equal($('#announcement').textContent, expected);
  }
  run('showMatchEnd({team:0,score:[5,2]})');
  assert.equal($('#finalTitle').textContent, 'VICTORY');
  run('showMatchEnd({team:1,score:[2,5]})');
  assert.equal($('#finalTitle').textContent, 'DEFEAT');
  run('spectatorMode = true; networkMode = true; showMatchEnd({team:1})');
  assert.equal($('#finalTitle').textContent, 'NOVA 2 WINS');
  assert.equal($('#rematchStatus').textContent, 'NEXT MATCH STARTING AUTOMATICALLY…');
  handlers.rematchVote({votes:1,required:2});
  assert.equal($('#rematchStatus').textContent, 'REMATCH 1 / 2');
  run('hideMatchEnd()');
  assert.equal($('#rematch').textContent, 'REMATCH');
  assert.equal($('#rematchStatus').textContent, 'PLAY AGAIN?');
});

test('all simulation engines supply an English default player name', () => {
  for (const file of ['shared/simulation.js', 'shared/simulation-v3.js', 'shared/rocketsim-local-simulation.js', 'server/rocketsim-room.js']) {
    assert.ok(read(file).includes("name = 'Player'"), file);
  }
});

test('server rejection messages are English without changing acknowledgement contracts', () => {
  const source = read('server.js');
  for (const text of ['Origin denied.', 'Too many connections.', 'Match not found.', 'Too many requests. Try again soon.', 'Invalid message.', 'Request denied.', 'Room creation is already in progress.', 'Server is full.', 'Room creation cancelled.', 'RocketSim is unavailable on the server.', 'Room not found.', 'You are already in this room.', 'This room is already full.', 'The match has not finished yet.']) assert.ok(source.includes(text), text);
});

test('standalone playable and smoke pages declare English and label actual controls', () => {
  for (const file of ['public/rocketsim-play.html', 'public/rocketsim-smoke.html']) assert.match(read(file), /<html lang="en">/);
  const html = read('public/rocketsim-play.html');
  for (const text of ['LOADING NEON…', 'first to 5', 'WHEELS', 'WASD drive', 'Arrows aerial', 'Space jump', 'C drift', '>JUMP<']) assert.ok(html.includes(text), text);
  const js = read('public/rocketsim-playable.js');
  for (const text of ['AZURE GOAL!', 'NOVA GOAL!', 'WHEELS']) assert.ok(js.includes(text), text);
});

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('main menu, HUD and match results use English while retaining control labels', () => {
  const html = read('public/index.html');
  assert.match(html, /<html lang="en">/);
  for (const text of ['PLAY SOLO', 'CREATE ROOM', 'JOIN', 'OPPONENT', 'First to 5', 'placeholder="Player"', 'WASD / ARROWS', 'SPACE · JUMP', 'Q / E · AIR ROLL', 'SHIFT · BOOST', 'C · POWERSLIDE', 'FINAL RESULT', 'VICTORY', 'REMATCH', 'EXIT']) {
    assert.ok(html.includes(text), `Missing English UI: ${text}`);
  }
});
