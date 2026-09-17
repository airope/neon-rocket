# Contributing

Changes should preserve the distinction between the playable RocketSim paths, Rapier spectators, and the historical Cannon evaluator.

## Development loop

From a fresh checkout with a Node runtime supporting `node:sqlite` / `DatabaseSync`:

```sh
npm ci
npm test
npm start
```

Open `http://localhost:3444`. See the [README](README.md) for the SQLite probe and configuration. Keep `package-lock.json` in sync with intentional dependency changes; use `npm ci` to verify the locked installation. No frontend build is required.

Focused examples:

```sh
node --test test/rocketsim-local-simulation.test.js test/rocketsim-room.test.js
node --test test/network-smoothing.test.js test/nova-stats.test.js
```

With a development server running, the scripted two-client transport check is:

```sh
node scripts/smoke-rocketsim-multi.mjs http://127.0.0.1:3444
```

That is a Socket.IO smoke test, not a substitute for two rendered browser clients.

## Change expectations

1. Describe the behavior and affected engine/mode. Add a failing regression test before a behavioral fix where practical.
2. Keep physics, match state, and rendering responsibilities separate. Use shared contracts rather than duplicating arena dimensions.
3. Test deterministic seeded evaluations and checkpoint/protocol validation when modifying the historical evaluator. Do not compare engines as if they were one benchmark.
4. For UI, camera, controls, or networking changes, exercise the actual main lobby in a browser. Check each solo opponent, two-client rooms, spectator fallback, goals, rematches, and disconnects as applicable.
5. Report exact commands, runtime, results, warnings, and untested device/browser combinations. Source-string tests are not visual proof.
6. Update [verification](docs/VERIFICATION.md), architecture, and privacy documentation when the relevant behavior changes.

NOVA is rule-based. Parameter optimization is not evidence of neural or reinforcement-learning training. Benchmark reports must identify the engine, controller/source/parameter identities, seeds, mirrored legs, timeouts, and termination protocol.

## Repository hygiene

Do not commit personal paths, credentials, `.env` files, live room codes, runtime databases, local logs, or private deployment configuration. Ignore rules are only a guardrail: review staged changes explicitly. Prefer relative paths in examples. Never run development commands against someone else's live database.

Keep the native runtime files and embedded WASM available for a runnable source checkout. Native changes require documented source revision, toolchain, artifact hashes, licensing/provenance review, a clean rebuild, and tests of both Node and browser loading. The current native rebuild defaults are not a portable build guarantee; coordinate with the artifact owner rather than silently replacing supplied binaries.

Use focused patches and explain which older engine paths must remain supported. Do not remove legacy code solely because the main playable engine changed: tests and evaluation scripts may still depend on it.

## Reporting issues

For ordinary bugs, include mode, browser/runtime, reproduction steps, expected/actual behavior, and sanitized logs. Do not include nicknames, network details, secrets, or database contents unless genuinely necessary and safe to disclose. For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of publishing an exploit against a live instance.
