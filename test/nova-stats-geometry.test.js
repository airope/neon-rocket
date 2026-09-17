import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELD as LEGACY_FIELD, GameSimulation as LegacySimulation } from '../shared/simulation.js';
import { FIELD as LIVE_FIELD, GameSimulation } from '../shared/simulation-v3.js';
import { NovaMatchStats, buildVersionMetadata, isOpenGoalMiss } from '../server/nova-stats.js';

test('shot classification uses injected goal line, width and height in both directions', () => {
  for (const team of [0, 1]) {
    const attack = team === 0 ? 1 : -1;
    for (const scenario of [
      { z: 0, y: 2, vz: 7, liveTarget: 1, legacyTarget: 0 },
      { z: 10, y: 2, vz: 0, liveTarget: 0, legacyTarget: 1 },
      { z: 0, y: 8, vz: 0, liveTarget: 0, legacyTarget: 1 }
    ]) {
      const simulation = new LegacySimulation({ mode: 'multi' });
      const shooter = simulation.addPlayer({ id: 'shooter', team, aiVersion: 1 });
      const opponent = simulation.addPlayer({ id: 'opponent', team: 1 - team, aiVersion: 2 });
      opponent.body.position.set(-attack * 40, 1, 0);
      simulation.ball.position.set(attack * 30, scenario.y, scenario.z);
      simulation.ball.velocity.set(attack * 30, 0, scenario.vz);
      // Explicit authoritative contact sample: tests classification, not Rapier contact extraction.
      simulation.world.contacts = [{ bi: shooter.body, bj: simulation.ball }];
      for (const [field, expected] of [[LIVE_FIELD, scenario.liveTarget], [LEGACY_FIELD, scenario.legacyTarget]]) {
        const stats = new NovaMatchStats(metadata({ field }));
        stats.beforeStep(simulation);
        stats.afterStep(simulation, [], 1 / 60);
        const measured = stats.finalize(simulation).models[0];
        assert.equal(measured.shotsOnTarget, expected, JSON.stringify({ team, scenario, field }));
        assert.equal(measured.openGoalMisses, 1 - expected);
        assert.equal(isOpenGoalMiss(simulation.ball, team, [], field), !expected);
      }
      const blocked = [{ team: 1 - team, position: { x: attack * LIVE_FIELD.halfX, z: 0 } }];
      assert.equal(isOpenGoalMiss(simulation.ball, team, blocked, LIVE_FIELD), false);
    }
  }
});

test('metadata fingerprints canonical field geometry and collector snapshots actual provenance', () => {
  const field = { ...LIVE_FIELD };
  const live = metadata({ field });
  const reordered = metadata({ field: Object.fromEntries(Object.entries(field).reverse()) });
  assert.equal(live.metricsVersion, 'nova-metrics-3');
  assert.match(live.geometryHash, /^[a-f0-9]{16}$/);
  assert.equal(live.geometryHash, reordered.geometryHash);
  assert.notEqual(live.geometryHash, metadata().geometryHash);
  for (const key of Object.keys(field)) {
    assert.notEqual(live.geometryHash, metadata({ field: { ...field, [key]: field[key] + 1 } }).geometryHash, key);
  }
  const collector = new NovaMatchStats({ ...live, geometryHash: 'stale', metricsVersion: 'stale' });
  field.halfX = 999;
  assert.equal(live.field.halfX, LIVE_FIELD.halfX);
  assert.equal(collector.metadata.geometryHash, live.geometryHash);
  assert.equal(collector.metadata.metricsVersion, live.metricsVersion);
  assert.ok(Object.isFrozen(collector.field));
  const old = { ...metadata() };
  delete old.field;
  delete old.geometryHash;
  delete old.metricsVersion;
  assert.deepEqual(new NovaMatchStats(old).field, LEGACY_FIELD);
  assert.equal(new NovaMatchStats(old).metadata.geometryHash, metadata().geometryHash);
});

test('invalid or incomplete field geometry cannot silently produce misleading metrics', () => {
  for (const field of [null, {}, { halfX: 50 }, { ...LIVE_FIELD, halfX: 0 }, { ...LIVE_FIELD, goalHalf: -1 }, { ...LIVE_FIELD, goalHeight: NaN }, { ...LIVE_FIELD, halfZ: Infinity }, { ...LIVE_FIELD, halfX: '51.2' }]) {
    assert.throws(() => metadata({ field }), /field geometry/);
    assert.throws(() => new NovaMatchStats({ ...metadata(), field }), /field geometry/);
  }
});

const metadata = (options = {}) => buildVersionMetadata({
  source: 'geometry-regression', nova1Version: 'one', nova2Version: 'two',
  simulationVersion: 'sim', physicsVersion: 'physics', arenaVersion: 'arena', ...options
});

test('live Rapier danger exposure uses supplied field while legacy default stays unchanged', () => {
  const simulation = new GameSimulation({ mode: 'multi' });
  try {
    simulation.addPlayer({ id: 'defender', team: 0, aiVersion: 1 });
    simulation.addPlayer({ id: 'opponent', team: 1, aiVersion: 2 });
    simulation.start();
    simulation.status = 'playing';
    simulation.ball.position.set(-40, LIVE_FIELD.ballRadius, 0);
    simulation.ball.velocity.setZero();
    const live = new NovaMatchStats(metadata({ field: LIVE_FIELD }));
    const legacy = new NovaMatchStats(metadata());
    for (let tick = 0; tick < 12; tick++) {
      live.beforeStep(simulation);
      legacy.beforeStep(simulation);
      simulation.step(1 / 120);
      const events = simulation.drainEvents();
      live.afterStep(simulation, events, 1 / 120);
      legacy.afterStep(simulation, events, 1 / 120);
    }
    assert.equal(live.finalize(simulation).models[0].timeInOwnDangerZone, .1);
    assert.equal(legacy.finalize(simulation).models[0].timeInOwnDangerZone, 0);
    assert.deepEqual(legacy.metadata.field, LEGACY_FIELD);
  } finally {
    simulation.free();
  }
});

test('save and clearance projections use supplied goal distance for both teams', () => {
  for (const team of [0, 1]) {
    const simulation = new LegacySimulation({ mode: 'multi' });
    const defender = simulation.addPlayer({ id: 'defender', team, aiVersion: 1 });
    simulation.addPlayer({ id: 'opponent', team: 1 - team, aiVersion: 2 });
    simulation.start();
    simulation.status = 'playing';
    const side = team === 0 ? -1 : 1;
    defender.body.position.set(side * 44, .78, 0);
    defender.body.velocity.setZero();
    simulation.ball.position.set(side * 38, LEGACY_FIELD.ballRadius, 0);
    simulation.ball.velocity.set(side * 12, 0, 0);
    const live = new NovaMatchStats(metadata({ field: LIVE_FIELD }));
    const legacy = new NovaMatchStats(metadata());
    for (let tick = 0; tick < 120; tick++) {
      live.beforeStep(simulation);
      legacy.beforeStep(simulation);
      simulation.step(1 / 60);
      const events = simulation.drainEvents();
      live.afterStep(simulation, events, 1 / 60);
      legacy.afterStep(simulation, events, 1 / 60);
    }
    const measured = live.finalize(simulation).models[0];
    assert.ok(measured.saves >= 1, `team ${team}: expected save, got ${measured.saves}`);
    assert.ok(measured.clearances >= 1, `team ${team}: expected clearance, got ${measured.clearances}`);
    assert.equal(legacy.finalize(simulation).models[0].saves, 0);
    assert.equal(legacy.finalize(simulation).models[0].clearances, 0);
  }
});
