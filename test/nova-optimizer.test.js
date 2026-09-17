import test from 'node:test';
import assert from 'node:assert/strict';
import { evolveNovaWf, mutateNovaWfParameters, novaWfParameterHash } from '../server/nova-optimizer.js';
import { NOVA_WF_DEFAULTS, NOVA_WF_PARAMETER_RANGES } from '../shared/nova-wf.js';

const syntheticEvaluator = ({ candidate }) => ({
  candidatePointRate: .5 + (candidate.boostAngle - NOVA_WF_DEFAULTS.boostAngle),
  meanGoalDifference: candidate.shadowDistance - NOVA_WF_DEFAULTS.shadowDistance,
  timeoutRate: 0
});

test('NOVA-WF mutation is deterministic and always remains inside declared ranges', () => {
  const first = mutateNovaWfParameters(NOVA_WF_DEFAULTS, { seed: 44, sigma: .2 });
  const second = mutateNovaWfParameters(NOVA_WF_DEFAULTS, { seed: 44, sigma: .2 });
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, NOVA_WF_DEFAULTS);
  for (const [key, [min, max]] of Object.entries(NOVA_WF_PARAMETER_RANGES)) assert.ok(first[key] >= min && first[key] <= max, key);
  assert.match(novaWfParameterHash(first), /^[a-f0-9]{16}$/);
});

test('(1 + lambda) evolution is reproducible and records every evaluated child', () => {
  const options = { generations: 3, lambda: 4, seed: 700, sigma: .15, evaluate: syntheticEvaluator };
  const first = evolveNovaWf(options);
  const second = evolveNovaWf(options);
  assert.deepEqual(first, second);
  assert.equal(first.history.length, 12);
  assert.equal(first.generation, 3);
  assert.equal(first.parent.hash, novaWfParameterHash(first.parent.parameters));
});

test('all children in a generation use common scenarios and generations use disjoint blocks', () => {
  const seeds = [];
  evolveNovaWf({ generations: 2, lambda: 3, seed: 1200, matches: 4, evaluate: ({ seed }) => {
    seeds.push(seed);
    return { candidatePointRate: .5, meanGoalDifference: 0, timeoutRate: 0 };
  } });
  assert.deepEqual(seeds.slice(0, 3), Array(3).fill(seeds[0]));
  assert.deepEqual(seeds.slice(3), Array(3).fill(seeds[3]));
  assert.notEqual(seeds[0], seeds[3]);
});

test('checkpoint resume rejects every evaluation protocol mismatch', () => {
  const common = { generations: 1, lambda: 2, seed: 900, sigma: .12, matches: 4, targetScore: 1, maxTicks: 1000, evaluate: syntheticEvaluator };
  const checkpoint = evolveNovaWf(common);
  for (const override of [{ matches: 6 }, { targetScore: 2 }, { maxTicks: 2000 }]) {
    assert.throws(() => evolveNovaWf({ ...common, generations: 2, checkpoint, ...override }), /checkpoint configuration mismatch/);
  }
});

test('checkpoint resume fails closed on corrupted provenance', () => {
  const common = { generations: 1, lambda: 2, seed: 950, sigma: .12, matches: 4, targetScore: 1, maxTicks: 1000, evaluate: syntheticEvaluator };
  const checkpoint = evolveNovaWf(common);
  const corruptions = [
    value => { value.schemaVersion = 99; },
    value => { value.algorithm = 'other'; },
    value => { value.parent.hash = '0000000000000000'; },
    value => { value.history.pop(); },
    value => { value.history[0].childIndex = 9; },
    value => { value.history[0].hash = '0000000000000000'; }
  ];
  for (const corrupt of corruptions) {
    const forged = structuredClone(checkpoint);
    corrupt(forged);
    assert.throws(() => evolveNovaWf({ ...common, generations: 2, checkpoint: forged }), /invalid checkpoint/);
  }
});

test('evolution resumes from a deterministic checkpoint without changing the result', () => {
  const common = { lambda: 3, seed: 800, sigma: .12, evaluate: syntheticEvaluator };
  const complete = evolveNovaWf({ ...common, generations: 4 });
  const partial = evolveNovaWf({ ...common, generations: 2 });
  const resumed = evolveNovaWf({ ...common, generations: 4, checkpoint: partial });
  assert.deepEqual(resumed, complete);
});
