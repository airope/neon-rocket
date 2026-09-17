#!/usr/bin/env node
// Exercise a disposable Git index/checkout, without committing or touching the source index.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'neon-autocrlf-'));
const source = path.join(temp, 'source');
const checkout = path.join(temp, 'checkout');
function run(command, args, cwd = source) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}
try {
  await mkdir(source);
  await mkdir(checkout);
  const manifest = JSON.parse(await readFile(path.join(root, 'native/rocketsim/dist/build-manifest.json'), 'utf8'));
  const files = [...new Set([
    ...Object.keys(manifest.inputs), ...Object.keys(manifest.outputs),
    'native/rocketsim/dist/build-manifest.json', 'native/rocketsim/verify-build.mjs',
    'shared/rocketsim-wasm-bundled.js', 'package.json',
  ])];
  for (const file of files) await cp(path.join(root, file), path.join(source, file), { recursive: true });
  try { await cp(path.join(root, '.gitattributes'), path.join(source, '.gitattributes')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  run('git', ['init', '--quiet']);
  run('git', ['config', 'core.autocrlf', 'false']);
  // A deliberately overridden control proves autocrlf actually operates in this checkout.
  await mkdir(path.join(source, '.git/info'), { recursive: true });
  await writeFile(path.join(source, '.git/info/attributes'), 'autocrlf-control.txt text !eol\n');
  await writeFile(path.join(source, 'autocrlf-control.txt'), 'line one\nline two\n');
  run('git', ['add', '--all']);
  run('git', ['-c', 'core.autocrlf=true', `--work-tree=${checkout}`, 'checkout-index', '--all', '--force']);
  assert.equal(await readFile(path.join(checkout, 'autocrlf-control.txt'), 'utf8'), 'line one\r\nline two\r\n');
  console.log('Control file checked out as CRLF with core.autocrlf=true.');
  console.log(run(process.execPath, ['native/rocketsim/verify-build.mjs'], checkout));
  // Preserve exact bytes for all packaged provenance files, not normalized hashes.
  for (const file of files) {
    assert.deepEqual(await readFile(path.join(checkout, file)), await readFile(path.join(root, file)), `checkout bytes changed: ${file}`);
  }
  console.log(`Exact-byte checkout comparison passed for ${files.length} files.`);
  console.log(run('git', [`--work-tree=${checkout}`, 'check-attr', 'text', 'eol', 'diff', 'merge', '--',
    'native/rocketsim/rocketsim_c_api.cpp', 'native/rocketsim/dist/rocketsim-raw.wasm']));
} finally {
  await rm(temp, { recursive: true, force: true });
}
