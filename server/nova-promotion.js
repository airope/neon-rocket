function seededRandom(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('seed must be a uint32');
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function percentile(sorted, probability) {
  return sorted[Math.floor((sorted.length - 1) * probability)];
}

function pairedRows(campaign) {
  if (!campaign || !Array.isArray(campaign.matches)) throw new TypeError('campaign.matches must be an array');
  const groups = new Map();
  for (const match of campaign.matches) {
    if (match.candidateTeam !== 0 && match.candidateTeam !== 1) throw new TypeError('every match needs candidateTeam 0 or 1');
    const group = groups.get(match.pairId) || [];
    group.push(match);
    groups.set(match.pairId, group);
  }
  return [...groups.entries()].map(([pairId, matches]) => {
    const legs = matches.map(match => match.leg).sort((a, b) => a - b);
    if (matches.length !== 2 || legs[0] !== 0 || legs[1] !== 1) throw new RangeError(`pair ${pairId} must contain legs 0 and 1`);
    const candidateTeams = matches.map(match => match.candidateTeam).sort((a, b) => a - b);
    if (candidateTeams[0] !== 0 || candidateTeams[1] !== 1) throw new RangeError(`pair ${pairId} must place the candidate on both teams`);
    const candidateVersion = campaign.config?.candidateVersion;
    const championVersion = campaign.config?.championVersion;
    for (const match of matches) {
      const candidateSide = match.candidateTeam === 0 ? match.sides?.left : match.sides?.right;
      const championSide = match.candidateTeam === 0 ? match.sides?.right : match.sides?.left;
      if (candidateSide !== candidateVersion || championSide !== championVersion) throw new RangeError(`pair ${pairId} sides do not match campaign controllers`);
      if (match.leg !== match.candidateTeam) throw new RangeError(`pair ${pairId} leg and candidate team are inconsistent`);
    }
    const [leg0, leg1] = matches.slice().sort((a, b) => a.leg - b.leg);
    if (!Number.isInteger(leg0.seed) || leg0.seed !== leg1.seed) throw new RangeError(`pair ${pairId} legs must use the same seed`);
    if (!Array.isArray(leg0.kickoffs) || !Array.isArray(leg1.kickoffs) || !leg0.kickoffs.length || !leg1.kickoffs.length) {
      throw new RangeError(`pair ${pairId} legs must include kickoff scenarios`);
    }
    const commonKickoffCount = Math.min(leg0.kickoffs.length, leg1.kickoffs.length);
    for (let index = 0; index < commonKickoffCount; index++) {
      if (JSON.stringify(leg0.kickoffs[index]) !== JSON.stringify(leg1.kickoffs[index])) throw new RangeError(`pair ${pairId} legs must use the same kickoff scenario prefix`);
    }
    let points = 0, goalDifference = 0, timeouts = 0;
    for (const match of matches) {
      if (match.timeout) { points += .5; timeouts++; }
      else if (match.winner === match.candidateTeam) points++;
      goalDifference += (match.score?.[match.candidateTeam] || 0) - (match.score?.[1 - match.candidateTeam] || 0);
    }
    return { pairId, pointRate: points / 2, goalDifference: goalDifference / 2, timeouts };
  });
}

export function pairedBootstrap(campaign, { seed = 1, iterations = 10000 } = {}) {
  if (!Number.isInteger(iterations) || iterations < 100) throw new RangeError('iterations must be an integer of at least 100');
  const pairs = pairedRows(campaign);
  if (!pairs.length) throw new RangeError('campaign must contain at least one pair');
  const random = seededRandom(seed);
  const pointSamples = new Array(iterations);
  const goalSamples = new Array(iterations);
  for (let iteration = 0; iteration < iterations; iteration++) {
    let points = 0, goals = 0;
    for (let draw = 0; draw < pairs.length; draw++) {
      const pair = pairs[Math.floor(random() * pairs.length)];
      points += pair.pointRate;
      goals += pair.goalDifference;
    }
    pointSamples[iteration] = points / pairs.length;
    goalSamples[iteration] = goals / pairs.length;
  }
  pointSamples.sort((a, b) => a - b);
  goalSamples.sort((a, b) => a - b);
  const timeoutCount = pairs.reduce((sum, pair) => sum + pair.timeouts, 0);
  return {
    pairCount: pairs.length,
    matchCount: pairs.length * 2,
    candidatePointRate: pairs.reduce((sum, pair) => sum + pair.pointRate, 0) / pairs.length,
    pointRate95: [percentile(pointSamples, .025), percentile(pointSamples, .975)],
    meanGoalDifference: pairs.reduce((sum, pair) => sum + pair.goalDifference, 0) / pairs.length,
    goalDifference95: [percentile(goalSamples, .025), percentile(goalSamples, .975)],
    timeoutCount,
    timeoutRate: timeoutCount / (pairs.length * 2),
    bootstrapSeed: seed,
    bootstrapIterations: iterations,
    samplingUnit: 'paired-seed'
  };
}

export function evaluatePromotionGate(campaign, {
  seed = 1,
  iterations = 10000,
  minimumMatches = 500,
  minimumPointRateLowerBound = .5,
  maxTimeoutRate = .02
} = {}) {
  const bootstrap = pairedBootstrap(campaign, { seed, iterations });
  const reasons = [];
  if (bootstrap.matchCount < minimumMatches) reasons.push(`sample requires at least ${minimumMatches} physical matches`);
  if (bootstrap.pointRate95[0] <= minimumPointRateLowerBound) reasons.push(`paired confidence lower bound must exceed ${minimumPointRateLowerBound}`);
  if (bootstrap.timeoutRate > maxTimeoutRate) reasons.push(`timeout rate ${bootstrap.timeoutRate} exceeds ${maxTimeoutRate}`);
  return {
    promote: reasons.length === 0,
    reasons,
    bootstrap,
    policy: { minimumMatches, minimumPointRateLowerBound, maxTimeoutRate }
  };
}
