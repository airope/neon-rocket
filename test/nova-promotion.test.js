import test from 'node:test';
import assert from 'node:assert/strict';
import { pairedBootstrap, evaluatePromotionGate } from '../server/nova-promotion.js';

function match({ pairId, leg, candidateTeam, winner = candidateTeam, timeout = false, score = candidateTeam === 0 ? [1, 0] : [0, 1], seed = Number(String(pairId).replace(/^p/, '')) || 0, kickoffs = [{ index: 0, ballZ: 0 }] }) {
  return {
    pairId, leg, candidateTeam, winner, timeout, score, seed, kickoffs,
    sides: candidateTeam === 0 ? { left: 3, right: 2 } : { left: 2, right: 3 }
  };
}

function campaignFromPairs(pairCount, outcome) {
  const matches = [];
  for (let index = 0; index < pairCount; index++) {
    matches.push(match({ pairId: `p${index}`, leg: 0, candidateTeam: 0, ...outcome(index, 0) }));
    matches.push(match({ pairId: `p${index}`, leg: 1, candidateTeam: 1, ...outcome(index, 1) }));
  }
  return { config: { candidateVersion: 3, championVersion: 2 }, matches };
}

test('paired bootstrap resamples seed pairs rather than treating mirrored legs as independent', () => {
  const campaign = campaignFromPairs(250, () => ({}));
  const result = pairedBootstrap(campaign, { seed: 91, iterations: 2000 });
  assert.equal(result.pairCount, 250);
  assert.equal(result.matchCount, 500);
  assert.equal(result.candidatePointRate, 1);
  assert.deepEqual(result.pointRate95, [1, 1]);
});

test('paired bootstrap rejects malformed legs, duplicated sides and campaign-inconsistent identities', () => {
  const malformedLegs = campaignFromPairs(1, () => ({}));
  malformedLegs.matches[0].leg = 7;
  malformedLegs.matches[1].leg = 8;
  assert.throws(() => pairedBootstrap(malformedLegs, { iterations: 100 }), /legs 0 and 1/);

  const duplicatedSide = campaignFromPairs(1, () => ({}));
  duplicatedSide.matches[1].candidateTeam = 0;
  assert.throws(() => pairedBootstrap(duplicatedSide, { iterations: 100 }), /both teams/);

  const wrongSides = campaignFromPairs(1, () => ({}));
  wrongSides.matches[0].sides.left = 2;
  assert.throws(() => pairedBootstrap(wrongSides, { iterations: 100 }), /campaign controllers/);

  const differentSeeds = campaignFromPairs(1, () => ({}));
  differentSeeds.matches[1].seed = 999;
  assert.throws(() => pairedBootstrap(differentSeeds, { iterations: 100 }), /same seed/);

  const differentKickoffs = campaignFromPairs(1, () => ({}));
  differentKickoffs.matches[1].kickoffs[0].ballZ = 4;
  assert.throws(() => pairedBootstrap(differentKickoffs, { iterations: 100 }), /same kickoff scenario prefix/);

  const sharedPrefix = campaignFromPairs(1, () => ({}));
  sharedPrefix.matches[1].kickoffs.push({ index: 1, ballZ: 3 });
  assert.doesNotThrow(() => pairedBootstrap(sharedPrefix, { iterations: 100 }));
});

test('promotion gate accepts a clear paired win and rejects neutral evidence', () => {
  const winning = campaignFromPairs(250, () => ({}));
  const accepted = evaluatePromotionGate(winning, { seed: 9, iterations: 2000 });
  assert.equal(accepted.promote, true);

  const neutral = campaignFromPairs(250, (pair, leg) => ({ winner: (pair + leg) % 2 === 0 ? leg : 1 - leg }));
  const rejected = evaluatePromotionGate(neutral, { seed: 9, iterations: 2000 });
  assert.equal(rejected.promote, false);
  assert.ok(rejected.reasons.some(reason => reason.includes('confidence')));
});

test('promotion gate treats timeouts as half-points and enforces the timeout ceiling', () => {
  const campaign = campaignFromPairs(250, (pair, leg) => pair < 10 ? ({ timeout: true, winner: null, score: [0, 0] }) : ({}));
  const result = evaluatePromotionGate(campaign, { seed: 9, iterations: 1000, maxTimeoutRate: .02 });
  assert.equal(result.bootstrap.candidatePointRate, .98);
  assert.equal(result.promote, false);
  assert.ok(result.reasons.some(reason => reason.includes('timeout')));
});
