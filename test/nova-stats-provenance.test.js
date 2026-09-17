import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GameSimulation, FIELD } from '../shared/simulation.js';
import { NovaMatchStats, NovaStatsStore, buildVersionMetadata } from '../server/nova-stats.js';

test('state aggregates distinguish opponents with identical labels but different hashes', () => {
  const store = new NovaStatsStore(':memory:');
  try {
    const baseline = record('base');
    const changed = structuredClone(baseline);
    changed.matchId = 'opponent-hash';
    changed.models[0].opponentHash = 'different-opponent';
    store.saveMatch(baseline);
    store.saveMatch(changed);
    const dashboard = store.getDashboard();
    assert.equal(dashboard.stateTransitions.length, 2);
    assert.equal(dashboard.stateUsage.filter(row => row.modelVersion === 'one').length, 2);
    assert.deepEqual(new Set(dashboard.stateTransitions.map(row => row.opponentHash)), new Set([baseline.models[0].opponentHash, 'different-opponent']));
  } finally {
    store.close();
  }
});

test('migration leaves existing results unscoped and preserves their original summaries', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nova-metrics-migration-'));
  const database = path.join(directory, 'old.sqlite');
  let store;
  try {
    store = new NovaStatsStore(database);
    const old = record('old');
    delete old.metadata.field;
    delete old.metadata.geometryHash;
    delete old.metadata.metricsVersion;
    store.saveMatch(old);
    // Recreate the pre-change matches schema, with actual persisted match/model rows.
    store.db.exec('ALTER TABLE matches DROP COLUMN metrics_version; ALTER TABLE matches DROP COLUMN geometry_hash;');
    store.close();
    store = new NovaStatsStore(database);
    assert.deepEqual(store.getMatch('old'), JSON.parse(JSON.stringify(old)));
    store.saveMatch(record('new'));
    const dashboard = store.getDashboard();
    assert.equal(dashboard.versionMatchups.length, 4);
    assert.equal(dashboard.versionMatchups.filter(row => row.metricsVersion === 'legacy-unscoped' && row.geometryHash === 'unknown').length, 2);
    store.close();
    store = new NovaStatsStore(database);
    assert.equal(store.getDashboard().versionMatchups.length, 4, 'migration is idempotent');
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function record(matchId, options = {}) {
  const metadata = buildVersionMetadata({
    source: 'same-source', nova1Version: 'one', nova2Version: 'two',
    simulationVersion: 'same-sim', physicsVersion: 'same-physics', arenaVersion: 'same-arena', ...options
  });
  const simulation = new GameSimulation({ mode: 'multi' });
  const player = simulation.addPlayer({ id: 'one', team: 0, aiVersion: 1 });
  simulation.addPlayer({ id: 'two', team: 1, aiVersion: 2 });
  player.aiState = 'before';
  const stats = new NovaMatchStats(metadata, { matchId });
  stats.beforeStep(simulation);
  player.aiState = 'after';
  stats.afterStep(simulation, [], 1 / 60);
  return stats.finalize(simulation);
}

test('dashboard comparisons separate geometry, metrics, schema, protocol and simulation source', () => {
  const store = new NovaStatsStore(':memory:');
  try {
    const baseline = record('base');
    const variants = [
      record('geometry', { field: { ...FIELD, halfX: 51.2 } }),
      { ...structuredClone(baseline), matchId: 'algorithm', metadata: { ...baseline.metadata, metricsVersion: 'other-metrics' } },
      record('schema', { metricsSchemaVersion: 99 }),
      record('protocol', { evaluatorProtocolVersion: 99 }),
      { ...structuredClone(baseline), matchId: 'simulation', metadata: { ...baseline.metadata, simulationHash: 'other-source' } },
      { ...structuredClone(baseline), matchId: 'historic' }
    ];
    delete variants.at(-1).metadata.metricsVersion;
    delete variants.at(-1).metadata.geometryHash;
    delete variants.at(-1).metadata.field;
    store.saveMatch(baseline);
    for (const variant of variants) store.saveMatch(variant);
    const dashboard = store.getDashboard();
    assert.equal(dashboard.totals.matches, 7);
    assert.equal(dashboard.versionMatchups.length, 14);
    assert.ok(dashboard.versionMatchups.every(row => row.matches === 1));
    assert.equal(dashboard.stateUsage.filter(row => row.modelVersion === 'one').length, 7);
    assert.equal(dashboard.stateTransitions.length, 7);
    for (const rows of [dashboard.versionMatchups, dashboard.stateUsage, dashboard.stateTransitions, dashboard.recentMatches]) {
      for (const row of rows) {
        assert.ok(row.metricsVersion);
        assert.ok(row.geometryHash);
        assert.ok(row.simulationHash);
        assert.ok(Number.isInteger(row.metricsSchemaVersion));
        assert.ok(Number.isInteger(row.evaluatorProtocolVersion));
      }
    }
    const old = dashboard.versionMatchups.find(row => row.metricsVersion === 'legacy-unscoped');
    assert.equal(old.geometryHash, 'unknown');
    assert.equal(store.getMatch('base').metadata.geometryHash, baseline.metadata.geometryHash);
  } finally {
    store.close();
  }
});
