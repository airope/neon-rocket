# Verification and limitations

Evidence below distinguishes automated native integration, actual Chrome interaction, and still-unverified deployment/hardware. Counts apply to the tested snapshot, not every future revision.

## Executed locally

- Original pre-publication baseline: `npm ci` and 176 passing tests.
- Actual installed Chrome, isolated profiles, normal main-page clicks: each of the three solo opponents loads the native engine, reaches play, moves, consumes boost and follows with the camera. Two independent browser clients create/join a private room and receive authoritative movement and increasing snapshots. No uncaught exceptions or console errors in the recorded run.
- Static export at the exact `/neon-rocket/` path: 42 Chrome checks passed for all three opponents. No Socket.IO/backend requests, no runtime/console errors, and server-only actions explicitly disabled. Static and self-hosted browser runs must be repeated after runtime changes.
- `npm run verify:native`: manifest input/output hashes match; browser-embedded WASM equals raw WASM; actual native drive/boost smoke passes. WASM SHA-256: `1262dc41552865802221abb536d32f3653bd4191b3497096bb9cfca686c7febc`, 522132 bytes. This command checks recorded artifacts; it does not perform a new source compilation.
- Pinned source compilation succeeded locally with Emscripten 6.0.3. An independent source-inventory check matched all 275 upstream archive files to the recorded manifest. See [native build](../scripts/build-rocketsim-wasm.sh) and [third-party provenance](../THIRD_PARTY_NOTICES.md).
- Real WASM integration fixtures in `test/native-match-lifecycle.test.js`: both goal directions, solo and authoritative-room adapters, goal celebration, next countdown, final-score persistence, explicit restart. Four tests pass. These are deterministic state fixtures, not claims of four manually completed human matches.
- Node.js 24.21.0 additionally passed the selected native-runtime, lifecycle and static-export tests. Main local development runtime was Node.js 26.5.0.
- Socket boundary regressions reproduce and prevent malformed-payload process termination and self-join arena destruction. Further network hardening is tracked by dedicated server tests.
- Metrics geometry/provenance tests exercise smaller-arena projections, persisted migration, and separate aggregation cohorts. Historical summaries are preserved rather than retroactively relabeled.
- Static packaging tests validate the local module graph, repeatable manifest hashes, visibly disabled multiplayer, and full legal-file inclusion with working relative attribution links.

## Reproduce

```sh
npm ci
npm test
npm run verify:native
npm start
```

In a second terminal (macOS installed Chrome default; set `CHROME_PATH` elsewhere):

```sh
BASE_URL=http://localhost:3444 QA_OUTPUT=./qa-output npm run qa:browser
```

For a static export, use an **empty** output directory:

```sh
npm run build:demo
# Serve dist-demo under /neon-rocket/ using a local static HTTP server, then:
STATIC_DEMO=1 BASE_URL=http://127.0.0.1:8000/neon-rocket/ QA_OUTPUT=./qa-static npm run qa:browser
```

`STATIC_DEMO=1` deliberately excludes health, private-room and live-server tests; it does not report those unavailable paths as passing. Keep generated QA files out of commits. Use a temporary `NOVA_STATS_DB` for server checks.

## Important limits

- Browser goal/final preview queries use Rapier; they are not native scoring proof. Native scoring evidence comes from the separate real-WASM fixtures above.
- Physical gamepads, mobile devices and all browser/OS combinations remain unverified. Source mappings are not hardware certification.
- Native bot matches need not finish quickly: one NOVA1-vs-NOVA2 diagnostic reached the 600-second simulation cap at 0–1. No competitive-performance claim follows from that unpaired smoke.
- **Live contact-derived AI statistics are not certified.** The historical collector reads Cannon-style `world.contacts`; the current Rapier live path does not populate that interface. Contact-derived counters can therefore remain zero and must not be interpreted as measured absence of touches/shots/saves. Correct geometry and cohort hashes do not repair that separate extraction limitation. Historical Cannon evaluation and live Rapier/native gameplay remain distinct.
- Rapier emits an initialization deprecation warning in the existing physics tests.
- Passing local tests does not certify public hosting. A public demo must be exercised at its exact URL after deployment, and CI status must be read from the actual run before being claimed.
- Source hashes and preserved licenses provide attribution/provenance evidence, not a legal opinion or clearance of unrelated trademarks/patents.
