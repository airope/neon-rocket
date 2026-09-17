import fs from 'node:fs';
import { evaluatePromotionGate } from '../server/nova-promotion.js';

const [input, output] = process.argv.slice(2);
if (!input) throw new TypeError('usage: node scripts/evaluate-promotion.js CAMPAIGN.json [OUTPUT.json]');
const campaign = JSON.parse(fs.readFileSync(input, 'utf8'));
const result = evaluatePromotionGate(campaign);
const json = `${JSON.stringify(result, null, 2)}\n`;
if (output) fs.writeFileSync(output, json);
else process.stdout.write(json);
process.exitCode = result.promote ? 0 : 2;
