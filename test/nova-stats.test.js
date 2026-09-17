import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FIELD, GameSimulation } from '../shared/simulation.js';
import { NovaMatchStats, NovaStatsStore, buildVersionMetadata, isOpenGoalMiss } from '../server/nova-stats.js';

function runDuel(targetScore = 1) {
  const originalRandom = Math.random;
  Math.random = () => .5;
  try {
    const simulation = new GameSimulation({ mode: 'duel', targetScore });
    simulation.addPlayer({ id: 'NOVA1', name: 'NOVA 1', team: 0, isBot: true, aiVersion: 1 });
    simulation.addPlayer({ id: 'NOVA2', name: 'NOVA 2', team: 1, isBot: true, aiVersion: 2 });
    const metadata = buildVersionMetadata({
      source: readFileSync(new URL('../shared/simulation.js', import.meta.url), 'utf8'),
      nova1Version: 'nova1-direct-test',
      nova2Version: 'nova2-tactical-test',
      simulationVersion: 'test-sim',
      physicsVersion: 'test-physics',
      arenaVersion: 'test-arena'
    });
    const stats = new NovaMatchStats(metadata);
    simulation.start();
    for (let tick = 0; tick < 10800 && simulation.status !== 'finished'; tick++) {
      stats.beforeStep(simulation);
      simulation.step(1 / 60);
      const events = simulation.drainEvents();
      stats.afterStep(simulation, events, 1 / 60);
    }
    assert.equal(simulation.status, 'finished');
    return stats.finalize(simulation);
  } finally {
    Math.random = originalRandom;
  }
}

test('open-goal miss classifier requires a missed goal line and absent defender', () => {
  const ball = { position: { x: 60, y: 2, z: 10 }, velocity: { x: 20, y: 0, z: 8 } };
  assert.equal(isOpenGoalMiss(ball, 0, [{ team: 1, position: { x: -40, z: 50 } }]), true);
  assert.equal(isOpenGoalMiss(ball, 0, [{ team: 1, position: { x: 112, z: 0 } }]), false);
  assert.equal(isOpenGoalMiss({ ...ball, velocity: { x: 20, y: 0, z: 0 } }, 0, []), false);
});

test('goal and reset events cancel pending ball-progress attribution', () => {
  const simulation = new GameSimulation({ mode: 'multi' });
  simulation.addPlayer({ id: 'NOVA1', team: 0 });
  simulation.addPlayer({ id: 'NOVA2', team: 1 });
  const metadata = buildVersionMetadata({ source: 'progress-test', nova1Version: 'n1', nova2Version: 'n2', simulationVersion: 'sim', physicsVersion: 'physics', arenaVersion: 'arena' });
  const stats = new NovaMatchStats(metadata);
  stats.beforeStep(simulation);
  stats.pendingProgress.set('NOVA1', { elapsed: .25, start: 0, attack: 1 });
  stats.afterStep(simulation, [{ type: 'goal', team: 1 }], 1 / 60);
  assert.equal(stats.pendingProgress.size, 0);
  assert.equal(stats.models.get('NOVA1').ballProgressAfterContact, 0);
});

test('collector measures danger exposure and recovery time from simulation ticks', () => {
  const simulation = new GameSimulation({ mode: 'duel', targetScore: 1 });
  const nova1 = simulation.addPlayer({ id: 'NOVA1', team: 0, isBot: true, aiVersion: 1 });
  simulation.addPlayer({ id: 'NOVA2', team: 1, isBot: true, aiVersion: 2 });
  const metadata = buildVersionMetadata({ source: 'metrics-test', nova1Version: 'n1', nova2Version: 'n2', simulationVersion: 'sim', physicsVersion: 'physics', arenaVersion: 'arena' });
  const stats = new NovaMatchStats(metadata);
  simulation.start();
  simulation.status = 'playing';

  for (let tick = 0; tick < 60; tick++) {
    simulation.ball.position.set(-90, FIELD.ballRadius, 0);
    simulation.ball.velocity.set(-5, 0, 0);
    nova1.body.position.y = 5;
    nova1.body.quaternion.setFromEuler(Math.PI, 0, 0);
    stats.beforeStep(simulation);
    stats.afterStep(simulation, [], 1 / 60);
  }

  const record = stats.finalize(simulation);
  const measured = record.models.find(model => model.id === 'NOVA1');
  assert.ok(measured.timeInOwnDangerZone >= .99);
  assert.ok(measured.recoverySeconds >= .99);
});

test('collector classifies an authoritative defensive contact as a save and clearance', () => {
  const simulation = new GameSimulation({ mode: 'multi', targetScore: 1 });
  const defender = simulation.addPlayer({ id: 'NOVA1', team: 0 });
  simulation.addPlayer({ id: 'NOVA2', team: 1 });
  const metadata = buildVersionMetadata({ source: 'contact-test', nova1Version: 'n1', nova2Version: 'n2', simulationVersion: 'sim', physicsVersion: 'physics', arenaVersion: 'arena' });
  const stats = new NovaMatchStats(metadata);
  simulation.start();
  simulation.status = 'playing';
  defender.body.position.set(-100, .78, 0);
  defender.body.velocity.setZero();
  simulation.ball.position.set(-94, FIELD.ballRadius, 0);
  simulation.ball.velocity.set(-24, 0, 0);

  for (let tick = 0; tick < 120; tick++) {
    stats.beforeStep(simulation);
    simulation.step(1 / 60);
    stats.afterStep(simulation, simulation.drainEvents(), 1 / 60);
  }

  const measured = stats.finalize(simulation).models.find(model => model.id === 'NOVA1');
  assert.ok(measured.saves >= 1, `expected save, got ${measured.saves}`);
  assert.ok(measured.clearances >= 1, `expected clearance, got ${measured.clearances}`);
  assert.ok(Number.isFinite(measured.ballProgressAfterContact));
});

test('collector records kickoff winner and time to first touch', () => {
  const record = runDuel();
  const totalKickoffWins = record.models.reduce((sum, model) => sum + model.kickoffWins, 0);
  const firstTouchTimes = record.models.flatMap(model => model.firstTouchTimes);
  assert.equal(totalKickoffWins, 1);
  assert.equal(firstTouchTimes.length, 1);
  assert.ok(firstTouchTimes[0] > 0);
});

test('duel collector produces compact per-match aggregates associated with exact model versions', () => {
  const record = runDuel();
  assert.equal(record.models.length, 2);
  assert.equal(record.metadata.nova1.version, 'nova1-direct-test');
  assert.equal(record.metadata.nova2.version, 'nova2-tactical-test');
  assert.match(record.metadata.nova1.hash, /^[a-f0-9]{16}$/);
  assert.match(record.metadata.nova2.hash, /^[a-f0-9]{16}$/);
  assert.equal(record.score[0] + record.score[1], 1);
  assert.ok(record.durationSeconds > 0);
  for (const model of record.models) {
    assert.ok(model.distanceMeters > 0);
    assert.ok(model.maxSpeed > 0);
    assert.ok(model.contacts >= model.usefulContacts);
    assert.ok(model.contacts >= model.harmfulContacts);
    assert.ok(model.stateDurations && Object.keys(model.stateDurations).length > 0);
  }
});

test('live server persists authoritative duel aggregates and exposes the stats API', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /NovaMatchStats/);
  assert.match(source, /stats\.beforeStep\(liveDuel\.sim\)/);
  assert.match(source, /stats\.afterStep\(liveDuel\.sim, events, dt\)/);
  assert.match(source, /statsStore\.saveMatch/);
  assert.match(source, /app\.get\('\/api\/nova-stats'/);
});

test('SQLite store persists the actual controller pair even when NOVA 1 and NOVA 2 aliases exist', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nova-generic-'));
  try {
    const store = new NovaStatsStore(path.join(directory, 'stats.sqlite'));
    const record = runDuel();
    record.matchId = 'generic-2-vs-3';
    record.metadata = buildVersionMetadata({
      source: 'generic', controllerVersions: { 1: 'one', 2: 'two', 3: 'three' },
      simulationVersion: 'test-sim', physicsVersion: 'test-physics', arenaVersion: 'test-arena'
    });
    for (const model of record.models) {
      const controllerId = model.team === 0 ? 2 : 3;
      const opponentId = model.team === 0 ? 3 : 2;
      model.version = record.metadata.controllers[controllerId].version;
      model.modelHash = record.metadata.controllers[controllerId].hash;
      model.opponentVersion = record.metadata.controllers[opponentId].version;
      model.opponentHash = record.metadata.controllers[opponentId].hash;
    }
    assert.doesNotThrow(() => store.saveMatch(record));
    const dashboard = store.getDashboard();
    assert.equal(dashboard.totals.matches, 1);
    assert.equal(dashboard.recentMatches[0].nova1Version, 'two');
    assert.equal(dashboard.recentMatches[0].nova2Version, 'three');
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite store persists matches and returns aggregates grouped by both model versions', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nova-stats-'));
  try {
    const store = new NovaStatsStore(path.join(directory, 'stats.sqlite'));
    const record = runDuel();
    store.saveMatch(record);
    const output = store.getDashboard();
    assert.equal(output.totals.matches, 1);
    assert.equal(output.recentMatches.length, 1);
    assert.equal(output.versionMatchups.length, 2);
    assert.ok(output.versionMatchups.every(row => row.matches === 1));
    assert.ok(output.versionMatchups.every(row => row.modelVersion && row.opponentVersion));
    assert.ok(output.versionMatchups.every(row => row.simulationVersion === 'test-sim'));
    assert.ok(output.versionMatchups.every(row => Number.isFinite(row.savesPerMatch)));
    assert.ok(output.versionMatchups.every(row => Number.isFinite(row.dangerSecondsPerMatch)));
    const metricColumns = new Set(store.db.prepare('PRAGMA table_info(model_match_stats)').all().map(column => column.name));
    for (const column of ['saves', 'clearances', 'ball_progress_after_contact', 'open_goal_misses', 'time_in_own_danger_zone', 'recovery_seconds', 'kickoff_wins', 'first_touch_times_json']) assert.ok(metricColumns.has(column), `missing ${column}`);
    assert.ok(output.stateUsage.length >= 2);
    assert.ok(output.stateUsage.every(row => row.modelVersion && row.state && row.totalSeconds > 0));
    assert.ok(output.stateTransitions.length > 0);
    assert.deepEqual(store.getMatch(record.matchId).score, record.score);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
