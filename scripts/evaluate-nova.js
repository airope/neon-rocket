#!/usr/bin/env node
import { parseEvaluationArgs, runCampaign } from '../server/nova-evaluation.js';

try {
  const { json, ...options } = parseEvaluationArgs(process.argv.slice(2));
  const startedAt = performance.now();
  const campaign = runCampaign(options);
  campaign.summary.wallSeconds = Number(((performance.now() - startedAt) / 1000).toFixed(3));
  campaign.summary.simulationSpeed = Number((campaign.matches.reduce((sum, match) => sum + match.simulatedSeconds, 0) / campaign.summary.wallSeconds).toFixed(2));
  if (json) console.log(JSON.stringify(campaign, null, 2));
  else {
    const candidate = campaign.summary.byVersion[String(options.candidateVersion)];
    const champion = campaign.summary.byVersion[String(options.championVersion)];
    console.log(`NOVA ${options.candidateVersion}: ${candidate.wins}/${candidate.matches} wins, ${candidate.goals}-${candidate.goalsAgainst} goals`);
    console.log(`NOVA ${options.championVersion}: ${champion.wins}/${champion.matches} wins, ${champion.goals}-${champion.goalsAgainst} goals`);
    console.log(`${campaign.summary.timeouts} timeouts · ${campaign.summary.simulationSpeed}x realtime`);
  }
  if (campaign.summary.timeouts > 0) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
