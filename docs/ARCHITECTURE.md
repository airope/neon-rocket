# Architecture

## Served application

`server.js` creates an Express HTTP server and attaches Socket.IO. `/` serves `public/index.html`, whose module entry is `/game.js?v=21` (`public/game.js`). `/game-v60.js` is an alias to that same file, not a separate engine version.

Assets are served locally:

- `/shared/*` maps to `shared/`; the special `/shared/rapier-engine.js` route rewrites the bare Rapier import to `/vendor/rapier/rapier.mjs`.
- `/vendor/three.module.js`, `/vendor/three.core.js`, `/vendor/cannon-es.js`, and `/vendor/rapier/rapier.mjs` map to installed npm dependencies.
- `/native/rocketsim/dist/*` and `/native/rocketsim/*` both map to `native/rocketsim/dist/`.
- `/socket.io/socket.io.js` supplies the Socket.IO browser client.
- `/rocketsim-play.html` and `/rocketsim-smoke.html` are native-engine diagnostic surfaces, not the main lobby.

No bundler or external CDN is required by these serving paths. Keep generated native assets in a source distribution intended to run without a C++ toolchain.

## Runtime flows

```text
Browser: index.html -> game.js -> Three.js rendering + controls
  solo -> rocketsim-local-simulation -> RocketSim WASM
       -> rocketsim-nova rule-based controls (versions 1 / 2 / 3)
  1v1 input -> Socket.IO -> server/rocketsim-room -> RocketSim WASM
           <- events + snapshots <- authoritative server
  observe -> Socket.IO -> server live duel -> simulation-v3 -> Rapier
          -> local Rapier duel if live subscription is unavailable

Headless evaluation scripts -> nova-evaluation -> simulation.js -> Cannon-es
                            -> statistics / parameter search / promotion gate
```

### Playable RocketSim path

`shared/rocketsim-local-simulation.js` initializes a native arena through `native/rocketsim/dist/rocketsim.mjs`, adds the shared car-soccer arena mesh, applies sanitized player/bot controls, and produces renderer-compatible snapshots. It runs fixed native steps at 120 Hz. Match glue manages countdowns, goals, first-to-five completion, boost pads, and rematches.

The browser normally instantiates the embedded bytes from `shared/rocketsim-wasm-bundled.js`. The loader also implements a retried `.wasm` fetch route; Node uses the supplied native module. The adapter's coordinate and snapshot contract lets the same renderer display different engines without making their underlying behavior identical.

`server/rocketsim-room.js` is the authoritative two-human counterpart. `createRoom` always creates a RocketSim room; `joinRoom` starts it once the second player joins. The client does not decide goals or authoritative positions. Both players vote for a rematch after completion. Rooms are in-memory; disconnect/leave handling releases active native rooms.

### Networking

The server schedules fixed simulation steps at a target **120 Hz** and sends snapshots at a target **20 Hz**. Each snapshot includes sequence, server time, and simulation tick. Client inputs are sent at **30 Hz**. `public/network-interpolation.js` buffers snapshots, rejects stale sequences, and bounds extrapolation; the main client enables adaptive interpolation with an initial 140 ms delay and an 80 ms maximum extrapolation interval. These are implementation targets, not measured latency or performance guarantees.

Socket.IO allows polling and WebSocket transports. `/healthz` reports process/game state, while `/api/network-diagnostics` reports rates and catch-up/drop counters. Neither is a security or full gameplay readiness test.

### Rapier spectator and fixtures

The continuously running server duel constructs `GameSimulation` from `shared/simulation-v3.js`, with NOVA 1 and NOVA 2. Spectators subscribe to the same simulation, not separate matches. Finished matches are stored, followed by an automatic restart. A disconnected browser can instead construct a local Rapier duel, whose results are not sent to the statistics store.

The normal solo button selects RocketSim for all three opponents. `ball-preview`, `ball-air-preview`, `camera-preview`, and `match-preview` retain a Rapier-only fixture branch. Do not use those URLs as evidence that normal solo uses Rapier.

### Historical Cannon evaluator

`server/nova-evaluation.js` imports `GameSimulation` from `shared/simulation.js`, which uses Cannon-es. `server/nova-optimizer.js` builds on that evaluator and parameterized rules in `shared/nova-wf.js`. Mirrored seeded matchups, parameter mutation, checkpoint validation, and promotion statistics are research tooling for that path—not a training/inference integration into RocketSim.

Controller names alone are insufficient experiment identifiers. Record controller source/parameters, simulation, arena, physics version, seed protocol, termination rules, and timeouts. Never present a Cannon evaluation win rate as a RocketSim multiplayer or solo result.

## Persistence and APIs

`server/nova-stats.js` uses built-in `node:sqlite` (`DatabaseSync`, WAL mode). On server startup it creates/migrates the configured database. Only the server's Rapier AI duel is wired to `saveMatch` in `server.js`; human room matches and solo games are not wired to that persistence path.

The store contains per-match summaries and controller aggregates, hashes/versions, timings, scores, contact/shot/boost/recovery metrics, and state durations/transitions. `/api/nova-stats` exposes dashboard aggregates; `/api/nova-stats/matches/:id` exposes a stored match summary. Both are unauthenticated.

The live server passes active Rapier `FIELD` into the collector; historical evaluators retain their Cannon default. Geometry hash, metrics algorithm version and simulation/controller provenance separate aggregation cohorts, while existing database summaries remain unchanged. **Metric caveat:** live contact extraction still expects Cannon-style `world.contacts`, which the Rapier path does not populate. Contact-derived live counters are not reliable comparative measurements; see [verification](VERIFICATION.md).

See [PRIVACY.md](PRIVACY.md) for local nicknames, network relay, and retention boundaries.

## Native rebuild boundary

A normal `npm ci && npm start` uses the supplied native output. To rebuild, install Git, CMake, Make, Node and Emscripten **6.0.3**, activate the Emscripten environment, then run:

```sh
bash scripts/build-rocketsim-wasm.sh
npm run verify:native
```

The script fetches exact RocketSim revision `c2baacb8f4b441dd8505e63c2aeb5a1679b60b02` into fresh temporary source, compiles the library/bridge, embeds the browser bytes and records a manifest. No personal source checkout or Homebrew path is required. `ROCKETSIM_SOURCE` and `BUILD_DIR` overrides are rejected; `BUILD_JOBS` controls parallel compilation. Optional `BUNDLE_OUTPUT` changes only the embedded bundle destination, **not** native dist or its manifest; use a disposable checkout for audit rebuilds.

The manifest verifies exact file bytes; retain LF line endings for source/generated text. Local rebuilding and source-inventory verification are recorded in [verification](VERIFICATION.md); CI artifact verification alone is not an independent source compilation. Preserve [all upstream notices](../THIRD_PARTY_NOTICES.md).
