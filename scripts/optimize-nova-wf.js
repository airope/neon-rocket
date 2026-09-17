import fs from 'node:fs';
import path from 'node:path';
import { evolveNovaWf } from '../server/nova-optimizer.js';

function parse(argv) {
  const values = {};
  const allowed = new Set(['generations', 'lambda', 'matches', 'seed', 'sigma', 'target-score', 'max-ticks', 'out', 'resume']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    if (!allowed.has(key)) throw new TypeError(`unknown option: ${argv[index]}`);
    if (argv[index + 1] == null) throw new TypeError(`missing value for --${key}`);
    values[key] = argv[index + 1];
  }
  const options = {
    generations: Number(values.generations ?? 5), lambda: Number(values.lambda ?? 6),
    matches: Number(values.matches ?? 20), seed: Number(values.seed ?? 200000),
    sigma: Number(values.sigma ?? .12), targetScore: Number(values['target-score'] ?? 1),
    maxTicks: Number(values['max-ticks'] ?? 36000)
  };
  for (const key of ['generations', 'lambda', 'matches', 'seed', 'targetScore', 'maxTicks']) if (!Number.isInteger(options[key])) throw new TypeError(`${key} must be an integer`);
  if (!Number.isFinite(options.sigma)) throw new TypeError('sigma must be finite');
  return { options, out: values.out || 'benchmarks/nova-wf-optimization.json', resume: values.resume || null };
}

const { options, out, resume } = parse(process.argv.slice(2));
let checkpoint = resume ? JSON.parse(fs.readFileSync(resume, 'utf8')) : null;
for (let generation = (checkpoint?.generation || 0) + 1; generation <= options.generations; generation++) {
  checkpoint = evolveNovaWf({ ...options, generations: generation, checkpoint });
  const output = path.resolve(out);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`);
  fs.renameSync(temporary, output);
  const promoted = checkpoint.history.filter(item => item.generation === generation).some(item => item.hash === checkpoint.parent.hash);
  process.stderr.write(`generation ${generation}/${options.generations} parent=${checkpoint.parent.hash} promoted=${promoted}\n`);
}
process.stdout.write(`${JSON.stringify({ output: path.resolve(out), generation: checkpoint.generation, parent: checkpoint.parent })}\n`);
