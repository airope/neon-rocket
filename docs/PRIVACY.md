# Privacy and data lifecycle

This describes the current source implementation, not the logging policies of every future host or reverse proxy.

## Browser nickname

The main game stores the chosen nickname under **`neon3dPilot`** in browser `localStorage`, scoped to the site's origin. It is trimmed and limited to 18 characters. There is no account registration in the game. The nickname persists across page loads until site data is cleared or it is replaced.

Solo uses the nickname in the local simulation. Creating or joining a room sends it to the server; other participants can receive it in room snapshots. Choose a pseudonym rather than a real name or sensitive identifier.

To remove it, clear this site's browser storage, or run this in the site's developer console:

```js
localStorage.removeItem('neon3dPilot');
```

## Network play and ordinary connections

The page attempts to connect to same-origin Socket.IO on load, even if you later select solo. Thus “local solo simulation” does not mean “no network requests.” Assets must first be obtained from the server. Solo does not require a working multiplayer connection once its required assets have loaded; there is no guaranteed offline installation/cache workflow.

Private rooms relay nickname, ephemeral socket/player identifiers, room membership, inputs, game events, and state snapshots through the server. “Private” means a code-based room with no matchmaking; it is not authentication, end-to-end encryption, or a confidentiality guarantee. The server can inspect gameplay. Hosting via HTTP does not protect traffic in transit; use HTTPS/WSS for public exposure.

Room state is maintained in memory, not stored as player history by the current database integration. Leaving/disconnecting removes participation; active native rooms are released, and a process restart loses rooms. The application does not wire human room results or local solo results into the AI statistics store.

The server and any hosting provider, tunnel, reverse proxy, or infrastructure logs may observe IP addresses, connection times, user agents, and requests. This repository does not set their retention policies. Error logging exists; do not assume the whole deployment is log-free.

## Persisted AI statistics are separate

On startup, the server runs a **Rapier NOVA 1 vs NOVA 2 duel**, including when nobody watches. Completed AI matches are written to `data/nova-stats.sqlite`, or the file named by `NOVA_STATS_DB`.

Stored records include generated match IDs, timestamps, scores, simulated duration/ticks, bot/controller IDs, version/source hashes, per-match summary JSON, and aggregate contact, shot, possession, boost, movement, recovery, and state-transition metrics. These are bot match summaries, **not human nicknames, human input replays, account profiles, or neural-network training data** in the current wiring. “Model” database columns refer to controller identities, not proof of a learned model.

`/api/nova-stats` and `/api/nova-stats/matches/:id` expose these statistics without authentication. Treat the contents as public if you expose the server. There is no automatic expiration/deletion job. The operator must manage retention, backups, and access to the database and SQLite `-wal` / `-shm` sidecars.

To reset a disposable instance, stop the server, back up anything needed, then remove only its configured statistics database and associated sidecars. Restarting creates a fresh database. Never delete a database belonging to another running instance. Git ignore rules exclude runtime data but are not an access-control or encryption mechanism.

## External services

The normal asset paths serve Three.js, physics libraries, and Socket.IO from the same server; no analytics SDK or cloud model API is integrated in the inspected application path. npm installation contacts package registries. Adding a tunnel, analytics, external assets, or a hosted demo changes the deployment privacy boundary and must be disclosed separately.
