import { readFileSync } from 'node:fs';
import { GameSimulation } from '../shared/simulation.js';
import { buildVersionMetadata, NovaMatchStats } from './nova-stats.js';

const simulationSource = readFileSync(new URL('../shared/simulation.js', import.meta.url), 'utf8');
const wildfireSource = readFileSync(new URL('../shared/nova-wf.js', import.meta.url), 'utf8');
export const DEFAULT_EVALUATION_METADATA = buildVersionMetadata({
  source: `${simulationSource}\n${wildfireSource}`,
  controllerVersions: { 1: 'nova1-direct-1.0.0', 2: 'nova2-tactical-2.3.0', 3: 'nova-wf-wildfire-3.0.0' },
  controllerSources: { 3: wildfireSource },
  simulationVersion: '58',
  physicsVersion: 'car-collisions-2',
  arenaVersion: 'neon-arena-12',
  metricsSchemaVersion: 2,
  evaluatorProtocolVersion: 1
});

export function parseEvaluationArgs(argv) {
  const values = {};
  const allowed = new Set(['candidate', 'champion', 'matches', 'seed', 'target-score', 'max-ticks']);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') { values.json = true; continue; }
    if (!arg.startsWith('--')) throw new TypeError(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!allowed.has(key)) throw new TypeError(`unknown option: ${arg}`);
    const value = argv[++index];
    if (value == null || value.startsWith('--')) throw new TypeError(`missing value for ${arg}`);
    values[key] = value;
  }
  const parsed = {
    candidateVersion: Number(values.candidate),
    championVersion: Number(values.champion),
    matches: Number(values.matches ?? 100),
    seed: Number(values.seed ?? 1),
    targetScore: Number(values['target-score'] ?? 3),
    maxTicks: Number(values['max-ticks'] ?? 36000),
    json: Boolean(values.json)
  };
  for (const [name, value] of Object.entries(parsed)) {
    if (name !== 'json' && !Number.isInteger(value)) throw new TypeError(`${name} must be an integer`);
  }
  if (parsed.matches < 2 || parsed.matches % 2 !== 0) throw new RangeError('matches must be a positive even integer');
  if (parsed.seed < 0 || parsed.seed > 0xffffffff) throw new RangeError('seed must be a uint32');
  if (parsed.candidateVersion <= 0 || parsed.championVersion <= 0 || parsed.targetScore <= 0 || parsed.maxTicks <= 0) throw new RangeError('versions, target-score and max-ticks must be positive');
  return parsed;
}

export function createSeededRandom(seed = 1) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('seed must be a uint32');
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function runHeadlessMatch({
  seed = 1,
  leftVersion = 1,
  rightVersion = 2,
  targetScore = 3,
  maxTicks = 36000,
  metadata = DEFAULT_EVALUATION_METADATA,
  pairId = null,
  leg = null,
  candidateVersion = null,
  controllerDefinitions = {}
} = {}) {
  if (!Number.isInteger(targetScore) || targetScore <= 0) throw new RangeError('targetScore must be a positive integer');
  if (!Number.isInteger(maxTicks) || maxTicks <= 0) throw new RangeError('maxTicks must be a positive integer');
  for (const version of [leftVersion, rightVersion]) {
    if (!metadata.controllers?.[String(version)]) throw new RangeError(`unsupported AI version ${version}`);
  }
  const simulation = new GameSimulation({
    mode: 'duel', targetScore,
    random: createSeededRandom(seed),
    kickoffRandom: createSeededRandom((seed ^ 0x9e3779b9) >>> 0),
    evaluationKickoffVariation: true
  });
  const leftController = controllerDefinitions[String(leftVersion)] || { aiVersion: leftVersion };
  const rightController = controllerDefinitions[String(rightVersion)] || { aiVersion: rightVersion };
  for (const [side, controller] of [['left', leftController], ['right', rightController]]) {
    if (!Number.isInteger(controller.aiVersion) || controller.aiVersion < 1 || controller.aiVersion > 3) throw new RangeError(`${side} controller aiVersion must be 1, 2 or 3`);
  }
  simulation.addPlayer({ id: 'LEFT', name: `NOVA ${leftVersion}`, team: 0, isBot: true, aiVersion: leftController.aiVersion, controllerId: leftVersion, aiParameters: leftController.parameters });
  simulation.addPlayer({ id: 'RIGHT', name: `NOVA ${rightVersion}`, team: 1, isBot: true, aiVersion: rightController.aiVersion, controllerId: rightVersion, aiParameters: rightController.parameters });
  const matchId = `eval-${seed}-v${leftVersion}-v${rightVersion}`;
  const stats = new NovaMatchStats(metadata, { matchId, startedAt: 'simulation:0' });
  simulation.start();

  let ticks = 0;
  const events = [];
  while (ticks < maxTicks && simulation.status !== 'finished') {
    stats.beforeStep(simulation);
    simulation.step(1 / 60);
    ticks++;
    const tickEvents = simulation.drainEvents();
    stats.afterStep(simulation, tickEvents, 1 / 60);
    events.push(...tickEvents.map(event => ({ tick: ticks, ...event })));
  }

  const timeout = simulation.status !== 'finished';
  const record = stats.finalize(simulation, { endedAt: `simulation:${ticks}` });
  return {
    ...record,
    matchId,
    seed,
    pairId,
    leg,
    candidateTeam: candidateVersion == null ? null : leftVersion === candidateVersion ? 0 : 1,
    sides: { left: leftVersion, right: rightVersion },
    score: [...simulation.score],
    winner: timeout ? null : simulation.winner,
    winningVersion: timeout ? null : simulation.winner === 0 ? leftVersion : simulation.winner === 1 ? rightVersion : null,
    status: timeout ? 'timeout' : 'finished',
    timeout,
    ticks,
    simulatedSeconds: ticks / 60,
    kickoffs: simulation.kickoffScenarios.map(scenario => ({ ...scenario })),
    events
  };
}

export function runPairedMatchup({ seed = 1, candidateVersion, championVersion, ...options }) {
  if (candidateVersion == null || championVersion == null) throw new TypeError('candidateVersion and championVersion are required');
  const pairId = `pair-${seed}`;
  return {
    pairId,
    seed,
    candidateVersion,
    championVersion,
    matches: [
      runHeadlessMatch({ ...options, seed, pairId, leg: 0, candidateVersion, leftVersion: candidateVersion, rightVersion: championVersion }),
      runHeadlessMatch({ ...options, seed, pairId, leg: 1, candidateVersion, leftVersion: championVersion, rightVersion: candidateVersion })
    ]
  };
}

function blankAggregate(version) {
  return {
    version,
    matches: 0,
    wins: 0,
    points: 0,
    goals: 0,
    goalsAgainst: 0,
    ownGoals: 0,
    deadlocks: 0,
    contacts: 0,
    usefulContacts: 0,
    shots: 0,
    shotsOnTarget: 0,
    saves: 0,
    clearances: 0,
    openGoalMisses: 0,
    ballProgressAfterContact: 0
  };
}

export function runCampaign({ candidateVersion, championVersion, matches = 100, seed = 1, ...options }) {
  if (!Number.isInteger(matches) || matches < 2 || matches % 2 !== 0) throw new RangeError('matches must be a positive even integer');
  if (seed + matches / 2 - 1 > 0xffffffff) throw new RangeError('campaign seed range exceeds uint32');
  const allMatches = [];
  for (let pairIndex = 0; pairIndex < matches / 2; pairIndex++) {
    const pair = runPairedMatchup({ ...options, seed: seed + pairIndex, candidateVersion, championVersion });
    allMatches.push(...pair.matches);
  }
  const byVersion = Object.fromEntries([candidateVersion, championVersion].map(version => [String(version), blankAggregate(version)]));
  let timeouts = 0;
  for (const match of allMatches) {
    if (match.timeout) timeouts++;
    const left = byVersion[String(match.sides.left)];
    const right = byVersion[String(match.sides.right)];
    left.matches++; right.matches++;
    left.goals += match.score[0]; left.goalsAgainst += match.score[1];
    right.goals += match.score[1]; right.goalsAgainst += match.score[0];
    if (match.timeout) { left.points += .5; right.points += .5; }
    else if (match.winner === 0) { left.wins++; left.points++; }
    else if (match.winner === 1) { right.wins++; right.points++; }
    for (const model of match.models) {
      const controllerId = model.team === 0 ? match.sides.left : match.sides.right;
      const aggregate = byVersion[String(controllerId)];
      if (!aggregate) continue;
      for (const field of ['ownGoals', 'contacts', 'usefulContacts', 'shots', 'shotsOnTarget', 'saves', 'clearances', 'openGoalMisses', 'ballProgressAfterContact']) aggregate[field] += model[field] || 0;
      aggregate.deadlocks += match.deadlocks || 0;
    }
  }
  return {
    config: { candidateVersion, championVersion, matches, seed, ...options },
    summary: { matchCount: allMatches.length, pairCount: allMatches.length / 2, timeouts, timeoutPolicy: 'draw-half-point', byVersion },
    matches: allMatches
  };
}
