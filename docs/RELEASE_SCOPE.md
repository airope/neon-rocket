# Release scope

Neon Rocket is a car-soccer prototype for the browser. The open-source repository keeps the playable client, authoritative server, native bridge, simulations and tests together.

## Included

- Normal solo gameplay against three rule-based NOVA controllers using RocketSim WebAssembly.
- Self-hosted private 1v1 rooms with authoritative simulation.
- A separate Rapier spectator duel and historical Cannon-based evaluation tools.
- A static solo-only export suitable for GitHub Pages. It deliberately disables server-dependent actions and does not simulate a successful multiplayer connection.
- Pinned native source build and runtime-artifact integrity checks.

## Boundaries

- This is experimental software, not an official Rocket League client or a production-scale multiplayer service.
- GitHub Pages can serve the solo demo, not the Node/Socket.IO server. Multiplayer hosting is a separate deployment; no public multiplayer host is bundled or promised.
- Rule-based bots have not been certified as competitively strong. A bounded native bot-versus-bot smoke against NOVA 2 did not reach the target score within 600 simulated seconds. This is not a paired performance benchmark.
- Physical gamepads and mobile touch devices have not been exercised for this release. Their input paths exist, but keyboard Chrome evidence does not certify them.
- Browser goal/final preview fixtures use Rapier. Native RocketSim scoring and final-score persistence are additionally covered by real WASM integration fixtures; those are not a claim that every full human match was played manually.
- Historical evaluation and optimization results do not measure the current native solo controllers. Engine, controller and arena identity must remain explicit.

For commands, current evidence and attribution, see [README](../README.md), [verification](VERIFICATION.md) and the repository license/notices.
