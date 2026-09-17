export function stampSnapshot(room, serverTime = Date.now()) {
  return {
    ...room.sim.snapshot(),
    sequence: ++room.sequence,
    serverTime,
    simulationTick: room.simulationTick
  };
}
