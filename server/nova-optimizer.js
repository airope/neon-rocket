import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runCampaign } from './nova-evaluation.js';
import { buildVersionMetadata } from './nova-stats.js';
import { normalizeNovaWfParameters, NOVA_WF_DEFAULTS, NOVA_WF_PARAMETER_RANGES } from '../shared/nova-wf.js';

const simulationSource = readFileSync(new URL('../shared/simulation.js', import.meta.url), 'utf8');
const wildfireSource = readFileSync(new URL('../shared/nova-wf.js', import.meta.url), 'utf8');

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  const u = Math.max(Number.EPSILON, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function canonical(parameters) {
  return JSON.stringify(Object.fromEntries(Object.keys(parameters).sort().map(key => [key, parameters[key]])));
}

export function novaWfParameterHash(parameters) {
  return createHash('sha256').update(canonical(normalizeNovaWfParameters(
    Object.fromEntries(Object.keys(NOVA_WF_PARAMETER_RANGES).filter(key => parameters[key] != null).map(key => [key, parameters[key]]))
  ))).digest('hex').slice(0, 16);
}

export function mutateNovaWfParameters(parent = NOVA_WF_DEFAULTS, { seed, sigma = .12 } = {}) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('mutation seed must be a uint32');
  if (!(sigma > 0 && sigma <= 1)) throw new RangeError('sigma must be in (0, 1]');
  const random = randomSource(seed);
  const overrides = {};
  for (const [key, [min, max]] of Object.entries(NOVA_WF_PARAMETER_RANGES)) {
    const current = parent[key] ?? NOVA_WF_DEFAULTS[key];
    const mutated = current + gaussian(random) * sigma * (max - min);
    overrides[key] = Math.max(min, Math.min(max, +mutated.toFixed(8)));
  }
  return normalizeNovaWfParameters(overrides);
}

export function runNovaWfCampaign({ parameters, championVersion = 2, matches = 20, seed = 1, targetScore = 1, maxTicks = 36000 }) {
  const candidate = normalizeNovaWfParameters(parameters);
  const candidateHash = novaWfParameterHash(candidate);
  const championLabels = { 1: 'nova1-direct-1.0.0', 2: 'nova2-tactical-2.3.0' };
  if (!championLabels[championVersion]) throw new RangeError('championVersion must be 1 or 2');
  const metadata = buildVersionMetadata({
    source: `${simulationSource}\n${wildfireSource}`,
    controllerVersions: { candidate: `nova-wf-${candidateHash}`, [championVersion]: championLabels[championVersion] },
    controllerSources: { candidate: `${simulationSource}\n${wildfireSource}\n${canonical(candidate)}`, [championVersion]: simulationSource },
    simulationVersion: '58', physicsVersion: 'car-collisions-2', arenaVersion: 'neon-arena-12'
  });
  return runCampaign({
    candidateVersion: 'candidate', championVersion, matches, seed, targetScore, maxTicks, metadata,
    controllerDefinitions: { candidate: { aiVersion: 3, parameters: candidate } }
  });
}

function actualEvaluator({ candidate, parent, seed, matches, targetScore, maxTicks }) {
  const candidateHash = novaWfParameterHash(candidate);
  const parentHash = novaWfParameterHash(parent);
  const metadata = buildVersionMetadata({
    source: `${simulationSource}\n${wildfireSource}`,
    controllerVersions: { candidate: `nova-wf-${candidateHash}`, parent: `nova-wf-${parentHash}` },
    controllerSources: {
      candidate: `${simulationSource}\n${wildfireSource}\n${canonical(candidate)}`,
      parent: `${simulationSource}\n${wildfireSource}\n${canonical(parent)}`
    },
    simulationVersion: '58', physicsVersion: 'car-collisions-2', arenaVersion: 'neon-arena-12'
  });
  const campaign = runCampaign({
    candidateVersion: 'candidate', championVersion: 'parent', matches, seed, targetScore, maxTicks, metadata,
    controllerDefinitions: {
      candidate: { aiVersion: 3, parameters: candidate },
      parent: { aiVersion: 3, parameters: parent }
    }
  });
  const aggregate = campaign.summary.byVersion.candidate;
  return {
    candidatePointRate: aggregate.points / aggregate.matches,
    meanGoalDifference: (aggregate.goals - aggregate.goalsAgainst) / aggregate.matches,
    timeoutRate: campaign.summary.timeouts / campaign.summary.matchCount
  };
}

function validateCheckpoint(checkpoint, expectedConfig) {
  const invalid = detail => { throw new RangeError(`invalid checkpoint: ${detail}`); };
  if (!checkpoint || checkpoint.schemaVersion !== 1 || checkpoint.algorithm !== '(1+lambda)') invalid('unsupported schema or algorithm');
  if (!Number.isInteger(checkpoint.generation) || checkpoint.generation < 0) invalid('generation');
  if (!checkpoint.config || Object.entries(expectedConfig).some(([key, value]) => checkpoint.config[key] !== value)) throw new RangeError('checkpoint configuration mismatch');
  if (!checkpoint.parent?.parameters || checkpoint.parent.hash !== novaWfParameterHash(checkpoint.parent.parameters)) invalid('parent hash');
  if (!Array.isArray(checkpoint.history) || checkpoint.history.length !== checkpoint.generation * expectedConfig.lambda) invalid('history length');
  for (let generation = 1; generation <= checkpoint.generation; generation++) {
    const entries = checkpoint.history.filter(entry => entry.generation === generation);
    if (entries.length !== expectedConfig.lambda) invalid(`generation ${generation} size`);
    const indices = entries.map(entry => entry.childIndex).sort((a, b) => a - b);
    if (indices.some((value, index) => value !== index)) invalid(`generation ${generation} child indices`);
    for (const entry of entries) {
      const expectedMutationSeed = expectedConfig.seed + (generation - 1) * expectedConfig.lambda + entry.childIndex;
      const expectedEvaluationSeed = expectedConfig.seed + 1000000 + (generation - 1) * (expectedConfig.matches / 2);
      if (entry.mutationSeed !== expectedMutationSeed || entry.evaluationSeed !== expectedEvaluationSeed) invalid(`generation ${generation} seeds`);
      if (!entry.parameters || entry.hash !== novaWfParameterHash(entry.parameters)) invalid(`generation ${generation} child hash`);
      const metrics = entry.metrics;
      if (!metrics || ![metrics.candidatePointRate, metrics.meanGoalDifference, metrics.timeoutRate, entry.objective].every(Number.isFinite)) invalid(`generation ${generation} metrics`);
      const expectedObjective = metrics.candidatePointRate + metrics.meanGoalDifference * .001 - metrics.timeoutRate * .05;
      if (entry.objective !== expectedObjective) invalid(`generation ${generation} objective`);
    }
  }
}

export function evolveNovaWf({
  generations = 5,
  lambda = 6,
  seed = 1,
  sigma = .12,
  matches = 20,
  targetScore = 1,
  maxTicks = 36000,
  initialParameters = {},
  checkpoint = null,
  evaluate = actualEvaluator
} = {}) {
  if (!Number.isInteger(generations) || generations < 1) throw new RangeError('generations must be positive');
  if (!Number.isInteger(lambda) || lambda < 1) throw new RangeError('lambda must be positive');
  if (!Number.isInteger(matches) || matches < 2 || matches % 2) throw new RangeError('matches must be positive and even');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('seed must be a uint32');
  if (typeof evaluate !== 'function') throw new TypeError('evaluate must be a function');

  const expectedConfig = { seed, lambda, sigma, matches, targetScore, maxTicks };
  if (checkpoint) validateCheckpoint(checkpoint, expectedConfig);
  let generation = checkpoint?.generation || 0;
  let parentParameters = checkpoint?.parent?.parameters
    ? normalizeNovaWfParameters(Object.fromEntries(Object.keys(NOVA_WF_PARAMETER_RANGES).map(key => [key, checkpoint.parent.parameters[key]])))
    : normalizeNovaWfParameters(initialParameters);
  const history = checkpoint ? structuredClone(checkpoint.history) : [];
  if (generation > generations) throw new RangeError('checkpoint is ahead of requested generations');

  for (; generation < generations; generation++) {
    const children = [];
    for (let childIndex = 0; childIndex < lambda; childIndex++) {
      const mutationSeed = seed + generation * lambda + childIndex;
      if (mutationSeed > 0xffffffff) throw new RangeError('mutation seed range exceeds uint32');
      const parameters = mutateNovaWfParameters(parentParameters, { seed: mutationSeed, sigma });
      const evaluationSeed = seed + 1000000 + generation * (matches / 2);
      if (evaluationSeed + matches / 2 - 1 > 0xffffffff) throw new RangeError('evaluation seed range exceeds uint32');
      const metrics = evaluate({ candidate: parameters, parent: parentParameters, seed: evaluationSeed, matches, targetScore, maxTicks });
      const objective = metrics.candidatePointRate + metrics.meanGoalDifference * .001 - metrics.timeoutRate * .05;
      children.push({ generation: generation + 1, childIndex, mutationSeed, evaluationSeed, hash: novaWfParameterHash(parameters), parameters, metrics, objective });
    }
    children.sort((a, b) => b.objective - a.objective || a.hash.localeCompare(b.hash));
    history.push(...children.sort((a, b) => a.childIndex - b.childIndex));
    const best = children.reduce((winner, child) => child.objective > winner.objective || (child.objective === winner.objective && child.hash < winner.hash) ? child : winner, children[0]);
    if (best.metrics.candidatePointRate > .5 || (best.metrics.candidatePointRate === .5 && best.metrics.meanGoalDifference > 0)) parentParameters = best.parameters;
  }

  return {
    schemaVersion: 1,
    algorithm: '(1+lambda)',
    generation: generations,
    config: { seed, lambda, sigma, matches, targetScore, maxTicks },
    parent: { hash: novaWfParameterHash(parentParameters), parameters: parentParameters },
    history
  };
}
