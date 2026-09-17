import fs from 'node:fs';
import path from 'node:path';
import { runNovaWfCampaign } from '../server/nova-optimizer.js';

const argv = process.argv.slice(2);
const values = {};
const allowed = new Set(['parameters', 'champion', 'matches', 'seed', 'target-score', 'max-ticks', 'out']);
for (let index = 0; index < argv.length; index += 2) {
  const key = argv[index]?.replace(/^--/, '');
  if (!allowed.has(key)) throw new TypeError(`unknown option: ${argv[index]}`);
  if (argv[index + 1] == null) throw new TypeError(`missing value for --${key}`);
  values[key] = argv[index + 1];
}
if (!values.parameters) throw new TypeError('--parameters checkpoint-or-parameters.json is required');
const document = JSON.parse(fs.readFileSync(values.parameters, 'utf8'));
const parameters = document.parent?.parameters || document.parameters || document;
const campaign = runNovaWfCampaign({
  parameters,
  championVersion: Number(values.champion ?? 2),
  matches: Number(values.matches ?? 500),
  seed: Number(values.seed ?? 500000),
  targetScore: Number(values['target-score'] ?? 1),
  maxTicks: Number(values['max-ticks'] ?? 36000)
});
const json = `${JSON.stringify(campaign, null, 2)}\n`;
if (values.out) {
  const output = path.resolve(values.out);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, json);
  process.stdout.write(`${JSON.stringify({ output, summary: campaign.summary })}\n`);
} else process.stdout.write(json);
process.exitCode = campaign.summary.timeouts ? 2 : 0;
