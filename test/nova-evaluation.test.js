import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSeededRandom, DEFAULT_EVALUATION_METADATA, parseEvaluationArgs, runCampaign, runHeadlessMatch, runPairedMatchup } from '../server/nova-evaluation.js';
import { buildVersionMetadata } from '../server/nova-stats.js';

test('seeded random generator accepts uint32 seeds only, including zero', () => {
  const zeroA = createSeededRandom(0);
  const zeroB = createSeededRandom(0);
  assert.deepEqual([zeroA(), zeroA()], [zeroB(), zeroB()]);
  for (const invalid of [-1, 1.5, 0x100000000, NaN, '1']) {
    assert.throws(() => createSeededRandom(invalid), /uint32/);
  }
});

test('default NOVA-WF identity hashes both simulation and Wildfire controller sources', () => {
  const simulationSource = readFileSync(new URL('../shared/simulation.js', import.meta.url), 'utf8');
  const wildfireSource = readFileSync(new URL('../shared/nova-wf.js', import.meta.url), 'utf8');
  const expected = buildVersionMetadata({
    source: `${simulationSource}\n${wildfireSource}`,
    controllerVersions: { 1: 'nova1-direct-1.0.0', 2: 'nova2-tactical-2.3.0', 3: 'nova-wf-wildfire-3.0.0' },
    controllerSources: { 3: wildfireSource },
    simulationVersion: '58', physicsVersion: 'car-collisions-2', arenaVersion: 'neon-arena-12'
  });
  assert.equal(DEFAULT_EVALUATION_METADATA.controllers[3].hash, expected.controllers[3].hash);
  assert.equal(DEFAULT_EVALUATION_METADATA.simulationHash, expected.simulationHash);
  const changed = buildVersionMetadata({
    source: `${simulationSource}\n${wildfireSource} changed`,
    controllerVersions: { 3: 'nova-wf-wildfire-3.0.0' }, controllerSources: { 3: `${wildfireSource} changed` },
    simulationVersion: '58', physicsVersion: 'car-collisions-2', arenaVersion: 'neon-arena-12'
  });
  assert.notEqual(changed.controllers[3].hash, expected.controllers[3].hash);
});

test('seeded random generator reproduces the same sequence', () => {
  const a = createSeededRandom(12345);
  const b = createSeededRandom(12345);
  assert.deepEqual(Array.from({ length: 8 }, () => a()), Array.from({ length: 8 }, () => b()));
});

test('headless seeds produce distinct but reproducible physical kickoff scenarios', () => {
  const options = { leftVersion: 3, rightVersion: 2, targetScore: 1, maxTicks: 60 };
  const first = runHeadlessMatch({ ...options, seed: 42 });
  const replay = runHeadlessMatch({ ...options, seed: 42 });
  const other = runHeadlessMatch({ ...options, seed: 43 });
  assert.deepEqual(first.kickoffs, replay.kickoffs);
  assert.notDeepEqual(first.kickoffs, other.kickoffs);
});

test('headless match is reproducible and reports explicit completion metadata', () => {
  const options = { seed: 44, leftVersion: 1, rightVersion: 2, targetScore: 1, maxTicks: 10800 };
  const first = runHeadlessMatch(options);
  const second = runHeadlessMatch(options);

  assert.deepEqual(first, second);
  assert.equal(first.status, 'finished');
  assert.equal(first.timeout, false);
  assert.equal(first.score[0] + first.score[1], 1);
  assert.equal(first.seed, 44);
  assert.deepEqual(first.sides, { left: 1, right: 2 });
  assert.equal(first.models.length, 2);
  assert.equal(first.metadata.metricsSchemaVersion, 2);
  assert.ok(first.events.some(event => event.type === 'goal' && Number.isInteger(event.tick)));
  assert.equal(first.matchId, 'eval-44-v1-v2');
});

test('headless evaluator records NOVA-WF as an exact third controller identity', () => {
  const match = runHeadlessMatch({ seed: 77, leftVersion: 3, rightVersion: 2, targetScore: 1, maxTicks: 240 });
  const wildfire = match.models.find(model => model.team === 0);
  assert.equal(wildfire.version, 'nova-wf-wildfire-3.0.0');
  assert.match(wildfire.modelHash, /^[a-f0-9]{16}$/);
  assert.ok(Object.keys(wildfire.stateDurations).some(state => ['kickoff', 'fallback', 'clear', 'shadow'].includes(state)));
});

test('headless evaluator supports distinct parameter identities for the same AI implementation', () => {
  const metadata = buildVersionMetadata({
    source: 'parameterized-wf',
    controllerVersions: { candidate: 'wf-candidate', parent: 'wf-parent' },
    simulationVersion: 'test', physicsVersion: 'test', arenaVersion: 'test'
  });
  const match = runHeadlessMatch({
    seed: 78, leftVersion: 'candidate', rightVersion: 'parent', targetScore: 1, maxTicks: 300, metadata,
    controllerDefinitions: {
      candidate: { aiVersion: 3, parameters: { urgentCommitSeconds: .91 } },
      parent: { aiVersion: 3, parameters: { urgentCommitSeconds: .2 } }
    }
  });
  assert.deepEqual(match.sides, { left: 'candidate', right: 'parent' });
  assert.equal(match.models.find(model => model.team === 0).version, 'wf-candidate');
  assert.ok(match.models.some(model => Object.keys(model.stateDurations).includes('fallback')));
});

test('paired matchup mirrors candidate and champion across both teams', () => {
  const pair = runPairedMatchup({ seed: 91, candidateVersion: 2, championVersion: 1, targetScore: 1, maxTicks: 10800 });
  assert.equal(pair.matches.length, 2);
  assert.deepEqual(pair.matches.map(match => match.sides), [
    { left: 2, right: 1 },
    { left: 1, right: 2 }
  ]);
  assert.ok(pair.matches.every(match => match.seed === 91));
  assert.ok(pair.matches.every(match => match.status === 'finished'));
});

test('paired legs keep identical kickoff scenarios even when controller RNG consumption differs', () => {
  const pair = runPairedMatchup({ seed: 92, candidateVersion: 2, championVersion: 1, targetScore: 2, maxTicks: 36000 });
  assert.ok(pair.matches.every(match => match.status === 'finished'));
  assert.deepEqual(pair.matches[0].kickoffs, pair.matches[1].kickoffs);
});

test('campaign aggregates an even physical match count by model version', () => {
  const campaign = runCampaign({ candidateVersion: 2, championVersion: 1, matches: 4, seed: 300, targetScore: 1, maxTicks: 10800 });
  assert.equal(campaign.summary.matchCount, 4);
  assert.equal(campaign.summary.pairCount, 2);
  assert.equal(campaign.matches.length, 4);
  assert.equal(campaign.summary.byVersion['1'].goals + campaign.summary.byVersion['2'].goals, 4);
  assert.equal(campaign.summary.byVersion['1'].wins + campaign.summary.byVersion['2'].wins, 4);
  assert.equal(campaign.summary.timeouts, 0);
  assert.deepEqual([...new Set(campaign.matches.map(match => match.seed))], [300, 301]);
});

test('evaluation CLI parser validates and normalizes campaign arguments', () => {
  const parsed = parseEvaluationArgs(['--candidate', '2', '--champion', '1', '--matches', '20', '--seed', '900', '--target-score', '3', '--max-ticks', '36000', '--json']);
  assert.deepEqual(parsed, { candidateVersion: 2, championVersion: 1, matches: 20, seed: 900, targetScore: 3, maxTicks: 36000, json: true });
  assert.throws(() => parseEvaluationArgs(['--candidate', '2', '--champion', '1', '--matches', '3']), /even/);
  assert.throws(() => parseEvaluationArgs(['--candidate', '2', '--champion', '1', '--bogus', '4']), /unknown option/);
  assert.throws(() => parseEvaluationArgs(['--candidate', '2', '--champion', '1', '--seed', '-1']), /uint32/);
  assert.throws(() => parseEvaluationArgs(['--candidate', '2', '--champion', '1', '--target-score', '0']), /positive/);
});

test('campaign attributes model metrics by team even when version labels are identical', () => {
  const metadata = buildVersionMetadata({
    source: 'shared', controllerVersions: { 1: 'same', 2: 'same' },
    controllerSources: { 1: 'one', 2: 'two' }, simulationVersion: 'test', physicsVersion: 'test', arenaVersion: 'test'
  });
  const campaign = runCampaign({ candidateVersion: 2, championVersion: 1, matches: 2, seed: 612, targetScore: 1, maxTicks: 36000, metadata });
  const expected = { 1: 0, 2: 0 };
  for (const match of campaign.matches) for (const model of match.models) {
    const controller = model.team === 0 ? match.sides.left : match.sides.right;
    expected[controller] += model.contacts;
  }
  assert.equal(campaign.summary.byVersion['1'].contacts, expected[1]);
  assert.equal(campaign.summary.byVersion['2'].contacts, expected[2]);
});
