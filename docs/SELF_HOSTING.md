# Self-hosting

## Local development

Use Node.js 24 or later, `npm ci`, then `npm start`. Default listener: `127.0.0.1:3444`. This is intentionally loopback-only. The supplied WASM files are ready to run; a C++ toolchain is only needed to rebuild them.

## Multiplayer deployment

Deploy the **whole repository** to a host supporting a continuously running Node process and WebSocket upgrades. GitHub Pages is only suitable for the static solo export.

Example environment (replace the example origin with the actual site):

```sh
NODE_ENV=production
HOST=0.0.0.0
PORT=3444
ALLOWED_ORIGINS=https://game.example.com
NOVA_STATS_DB=/var/lib/neon-rocket/nova-stats.sqlite
```

Set these through the hosting platform's environment configuration, then start `npm start`. Put the process behind HTTPS/WSS, forward Socket.IO polling and WebSocket upgrades, and provide a writable persistent directory for the bot statistics database. No automatic production service migration is performed by this repository.

`ALLOWED_ORIGINS` is a comma-separated list of **exact origins**, without trailing slashes or URL paths. Without it, browser connections are limited to `http://localhost:<port>` and `http://127.0.0.1:<port>`. The server enforces origins at transport admission, not only by CORS headers. Non-browser clients without an Origin remain allowed: this is an anonymous game, not authenticated access control. Room codes are shared access codes, not strong account authentication.

The server does not trust `X-Forwarded-For` or similar client-provided headers. Clients behind one reverse proxy share its source-IP limits. Size those limits for the approved deployment, and enforce real-client rate limits at a trusted edge if needed; do not solve this by trusting arbitrary forwarded headers.

## Default bounds

All values are configurable through environment variables, and invalid limits fail startup.

| Variable | Default | Meaning |
|---|---:|---|
| `MAX_ROOMS` | 16 | Rooms including pending native allocations |
| `MAX_CONNECTIONS` | 128 | Global connection admission bound |
| `MAX_CONNECTIONS_PER_IP` | 16 | Source-address connection bound |
| `MAX_MESSAGE_BYTES` | 8192 | Socket.IO message size limit |
| `ROOM_WAITING_TTL_MS` | 120000 | Waiting-room expiry |
| `ROOM_FINISHED_TTL_MS` | 120000 | Finished-room expiry |
| `ROOM_IDLE_TTL_MS` | 300000 | Inactive playing-room expiry |
| `INPUT_STALE_MS` | 250 | Stale input neutralization delay |
| `EVENT_RATE` / `EVENT_BURST` | 90 / 180 | Per-socket event token bucket |
| `ROOM_COMMAND_RATE` / `ROOM_COMMAND_BURST` | 1 / 8 | Per-socket room-command bucket |
| `IP_CREATE_RATE` / `IP_CREATE_BURST` | 0.2 / 4 | Source-address room-creation bucket |

These are application safeguards, **not measured hosting capacity or DDoS protection**. Test your actual host and proxy before increasing them.

## Operations and data

- `/healthz` reports basic liveness and room/viewer counts. `/api/network-diagnostics` reports tick and snapshot observations.
- AI statistics endpoints are public read-only views of bot matches. They are not human-player analytics.
- The live Rapier bot duel runs without viewers. SQLite has no automatic retention policy; monitor disk growth and archive or rotate intentionally while the service is stopped. Preserve WAL consistency during backups.
- Contact-derived live statistics have a known extraction limitation; see [verification](VERIFICATION.md). Do not use their zero counters as reliable measurements.
- Socket admission limits do not replace reverse-proxy limits on static assets or statistics HTTP requests. Configure edge rate limits and process supervision for public hosting.
- No deployment secrets are required by the game. Never commit host credentials or runtime databases.

## Solo-only static export

`npm run build:demo` creates `dist-demo/` and refuses to overwrite a nonempty destination. The export includes vendor assets and complete attribution texts; no remote fonts or Socket.IO backend are required. Use an empty output directory for each build, or choose one with `node scripts/build-static-demo.mjs --out-dir <empty-directory>`.

The manual GitHub Actions `Solo demo` workflow tests and builds the site, then deploys it through GitHub Pages. Enable Pages with the Actions build type before dispatching. Always verify the exact deployed URL in a fresh browser; a local export test is not deployment verification.
