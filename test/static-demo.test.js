import test from 'node:test';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('demo visibly disables backend actions and the offline socket cannot connect or fabricate replies', async () => {
  await withDemo(async out => {
    const html = await readFile(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /SOLO-ONLY DEMO/);
    assert.match(html, /https:\/\/github.com\/airope\/neon-rocket/);
    assert.doesNotMatch(html, /socket\.io\/socket\.io\.js|CONNECTING TO SERVER/);
    for (const id of ['create', 'join', 'code', 'novaDuel']) {
      assert.match(html, new RegExp(`<[^>]+id="${id}"[^>]*disabled[^>]*aria-describedby="static-demo-note"`));
    }
    const shim = await readFile(path.join(out, 'offline-socket.js'), 'utf8');
    let requests = 0;
    const denied = () => { requests++; throw new Error('Unexpected transport'); };
    const sandbox = { window: {}, fetch: denied, WebSocket: denied, XMLHttpRequest: denied, setTimeout: denied, setInterval: denied };
    vm.runInNewContext(shim, sandbox);
    const socket = sandbox.window.io({ reconnection: true });
    assert.equal(socket.connected, false);
    let callbacks = 0;
    socket.on('connect', () => callbacks++).on('connect_error', () => callbacks++);
    socket.emit('input', {}, () => callbacks++);
    await assert.rejects(socket.timeout(1).emitWithAck('createRoom', {}), /SOLO/);
    assert.equal(socket.connected, false);
    assert.equal(callbacks, 0);
    assert.equal(requests, 0);
    assert.throws(() => { socket.connected = true; }, TypeError);
  });
});

test('manifest is complete, path-free and reproducible, with a closed local module graph', async () => {
  await withDemo(async out => {
    const manifestText = await readFile(path.join(out, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.mode, 'solo-offline');
    assert.equal(manifest.files['manifest.json'], undefined);
    const html = await readFile(path.join(out, 'index.html'), 'utf8');
    const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
    for (const [file, hash] of Object.entries(manifest.files)) {
      assert.ok(!path.isAbsolute(file) && !file.includes('..'));
      const bytes = await readFile(path.join(out, file));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, file);
      // Privacy rejection is exercised independently via exporter fixtures below.
      if (!/\.(?:m?js)$/.test(file)) continue;
      const source = bytes.toString();
      // Parse static imports rather than matching prose inside vendor comments.
      const parsed = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e',
        "import {SourceTextModule} from 'node:vm';import fs from 'node:fs';console.log(JSON.stringify(new SourceTextModule(fs.readFileSync(0,'utf8')).dependencySpecifiers))"], { input: source, encoding: 'utf8' });
      assert.equal(parsed.status, 0, `${file}: ${parsed.stderr}`);
      const specifiers = [...JSON.parse(parsed.stdout), ...[...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)].map(match => match[1])];
      for (const specifier of specifiers) {
        if (specifier.startsWith('node:')) continue; // Emscripten's Node-only branch.
        const resolved = imports[specifier] ? new URL(imports[specifier], 'https://example.test/neon-rocket/') : new URL(specifier, `https://example.test/neon-rocket/${file}`);
        assert.ok(resolved.pathname.startsWith('/neon-rocket/'), `${file}: ${specifier}`);
        const target = resolved.pathname.slice('/neon-rocket/'.length);
        assert.ok(manifest.files[target], `missing ${file} -> ${specifier}`);
      }
    }
    await withDemo(async second => assert.equal(await readFile(path.join(second, 'manifest.json'), 'utf8'), manifestText));
  });
});

test('redistributed runtime includes full linked legal notices', async () => {
  await withDemo(async out => {
    const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/licenses/Three-MIT.txt', 'docs/licenses/Cannon-es-MIT.txt', 'docs/licenses/Rapier-Apache-2.0.txt', 'native/rocketsim/licenses/SOURCE-NOTICES.txt', 'native/rocketsim/licenses/musl-COPYRIGHT.txt']) assert.ok(manifest.files[file], `missing legal text: ${file}`);
    const notices = await readFile(path.join(out, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    for (const match of notices.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https?:/.test(match[1])) continue;
      assert.ok(manifest.files[match[1]], `broken notice link: ${match[1]}`);
    }
    assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /href="\.\/THIRD_PARTY_NOTICES\.md"/);
  });
});

test('exporter rejects personal path fixtures without leaking their values', async t => {
  const fixtures = [
    ['literal Windows', String.raw`C:\Users\PRIVATE_FIXTURE_ALICE\work`, true],
    ['escaped Windows', String.raw`C:\\Users\\PRIVATE_FIXTURE_ALICE\\work`, true],
    ['lowercase Windows', String.raw`c:\users\PRIVATE_FIXTURE_ALICE\work`, true],
    ['forward-slash Windows', 'C:/Users/PRIVATE_FIXTURE_ALICE/work', true],
    ['macOS', '/Users/PRIVATE_FIXTURE_ALICE/work', true],
    ['Linux', '/home/PRIVATE_FIXTURE_ALICE/work', true],
    ['ordinary relative path', 'assets/fixture.js', false],
    ['non-home Windows', String.raw`C:\Program Files\fixture\work`, false],
    ['build sandbox exception', '/home/web_user/project', false],
    ['exception prefix is not exempt', '/home/web_user_private/work', true],
  ];
  const temp = await mkdtemp(path.join(tmpdir(), 'neon-static-fixtures-'));
  const source = path.join(temp, 'source');
  try {
    // Copy only exporter inputs, never mutate the working tree or native artifacts.
    for (const name of ['scripts/build-static-demo.mjs', 'public', 'shared', 'native/rocketsim/dist',
      'native/rocketsim/licenses', 'docs/licenses', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
      'node_modules/three/build', 'node_modules/cannon-es/dist',
      'node_modules/@dimforge/rapier3d-deterministic-compat']) {
      await cp(path.join(root, name), path.join(source, name), { recursive: true });
    }
    const original = await readFile(path.join(source, 'public/game.js'), 'utf8');
    for (const [index, [label, value, reject]] of fixtures.entries()) {
      await t.test(label, async () => {
        await writeFile(path.join(source, 'public/game.js'), `${original}\n// ${value}\n`);
        const out = path.join(temp, `demo-${index}`);
        const result = spawnSync(process.execPath, ['scripts/build-static-demo.mjs', '--out-dir', out], {
          cwd: source, encoding: 'utf8',
        });
        assert.ifError(result.error);
        if (reject) {
          assert.notEqual(result.status, 0, `${label} must be rejected`);
          assert.match(result.stderr, /Personal filesystem path in asset: game\.js/);
          assert.ok(!`${result.stdout}${result.stderr}`.includes(value), 'diagnostics must not disclose the path');
          assert.ok(!`${result.stdout}${result.stderr}`.includes('PRIVATE_FIXTURE_ALICE'), 'diagnostics must not disclose the username');
          await assert.rejects(stat(path.join(out, 'game.js')), { code: 'ENOENT' });
          await assert.rejects(stat(path.join(out, 'manifest.json')), { code: 'ENOENT' });
        } else {
          assert.equal(result.status, 0, result.stderr);
          assert.ok((await readFile(path.join(out, 'game.js'), 'utf8')).includes(value));
        }
      });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

const root = fileURLToPath(new URL('../', import.meta.url));
async function withDemo(run) {
  const temp = await mkdtemp(path.join(tmpdir(), 'neon-static-'));
  const out = path.join(temp, 'demo');
  try {
    const result = spawnSync(process.execPath, ['scripts/build-static-demo.mjs', '--out-dir', out], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    await run(out);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

test('exports the production solo entrypoint with repository-prefix portable module URLs', async () => {
  await withDemo(async out => {
    const html = await readFile(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /src="\.\/game\.js\?v=22"/);
    assert.doesNotMatch(html, /(?:src|href)="\//);
    const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
    assert.equal(map['@dimforge/rapier3d-deterministic-compat'], './vendor/rapier/rapier.mjs');
    for (const file of ['game.js', 'style.css', 'network-interpolation.js', 'rocketsim-playable-core.js', 'shared/rocketsim-local-simulation.js', 'shared/rocketsim-wasm-bundled.js', 'native/rocketsim/dist/rocketsim.mjs', 'native/rocketsim/dist/rocketsim-raw.mjs', 'native/rocketsim/dist/rocketsim-raw.wasm', 'vendor/three.module.js', 'vendor/three.core.js', 'vendor/rapier/rapier.mjs', 'vendor/cannon-es.js', '.nojekyll']) {
      assert.ok((await stat(path.join(out, file))).isFile(), file);
    }
    const source = await readFile(path.join(root, 'public/game.js'), 'utf8');
    const exported = await readFile(path.join(out, 'game.js'), 'utf8');
    assert.equal(exported, source.replace(/(from\s+['"])\//g, '$1./'), 'gameplay changes must be limited to import URL relocation');
    const css = await readFile(path.join(out, 'style.css'), 'utf8');
    assert.doesNotMatch(css, /@import|url\(['"]?https?:/);
  });
});
