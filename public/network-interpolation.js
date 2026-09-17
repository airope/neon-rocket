const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
const cloneBody = body => ({ ...body, p: [...body.p], q: [...body.q], v: [...body.v] });
const lerp = (a, b, t) => a + (b - a) * t;

function interpolateQuaternion(a, b, t) {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  if (a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
  const q = [lerp(a[0], bx, t), lerp(a[1], by, t), lerp(a[2], bz, t), lerp(a[3], bw, t)];
  const length = Math.hypot(...q) || 1;
  return q.map(value => value / length);
}

function interpolateBody(a, b, t) {
  return {
    ...b,
    p: a.p.map((value, index) => lerp(value, b.p[index], t)),
    q: interpolateQuaternion(a.q, b.q, t),
    v: a.v.map((value, index) => lerp(value, b.v[index], t))
  };
}

function extrapolateBody(body, milliseconds) {
  const seconds = milliseconds / 1000;
  const result = cloneBody(body);
  result.p = body.p.map((value, index) => value + body.v[index] * seconds);
  return result;
}

function interpolateSnapshot(before, after, t) {
  const previousPlayers = new Map(before.players.map(player => [player.id, player]));
  return {
    ...after,
    ball: interpolateBody(before.ball, after.ball, t),
    players: after.players.map(player => {
      const previous = previousPlayers.get(player.id);
      return previous ? { ...player, ...interpolateBody(previous, player, t) } : { ...player, ...cloneBody(player) };
    })
  };
}

export class NetworkTimeline {
  constructor({ interpolationDelayMs = 150, maxExtrapolationMs = 80, adaptive = false } = {}) {
    this.snapshots = [];
    this.clockOffsetMs = 0;
    this.clockReady = false;
    this.interpolationDelayMs = interpolationDelayMs;
    this.maxExtrapolationMs = maxExtrapolationMs;
    this.adaptive = adaptive;
    this.lastSequence = -1;
    this.lastArrival = 0;
    this.arrivalIntervals = [];
    this.rtts = [];
    this.metrics = {
      bufferedSnapshots: 0, droppedSnapshots: 0, outOfOrderSnapshots: 0,
      interpolatedFrames: 0, extrapolatedFrames: 0, arrivalP50Ms: 0,
      arrivalP95Ms: 0, arrivalMaxMs: 0, rttMs: 0, interpolationDelayMs
    };
  }

  reset() {
    this.snapshots.length = 0;
    this.lastSequence = -1;
    this.lastArrival = 0;
    this.arrivalIntervals.length = 0;
    this.metrics.bufferedSnapshots = 0;
  }

  setClockOffset(milliseconds) { this.clockOffsetMs = milliseconds; this.clockReady = true; }

  addClockSample(serverTime, clientStart, clientEnd) {
    const rtt = clientEnd - clientStart;
    const offset = serverTime - (clientStart + clientEnd) / 2;
    this.rtts.push({ rtt, offset });
    if (this.rtts.length > 12) this.rtts.shift();
    const best = [...this.rtts].sort((a, b) => a.rtt - b.rtt)[0];
    this.clockOffsetMs = best.offset;
    this.clockReady = true;
    this.metrics.rttMs = +rtt.toFixed(2);
  }

  push(snapshot, receivedAt = Date.now()) {
    if (!Number.isFinite(snapshot?.sequence) || !Number.isFinite(snapshot?.serverTime)) return false;
    if (snapshot.sequence <= this.lastSequence) {
      this.metrics.outOfOrderSnapshots++;
      return false;
    }
    if (this.lastSequence >= 0 && snapshot.sequence > this.lastSequence + 1) this.metrics.droppedSnapshots += snapshot.sequence - this.lastSequence - 1;
    if (this.lastArrival) {
      const interval = receivedAt - this.lastArrival;
      this.arrivalIntervals.push(interval);
      if (this.arrivalIntervals.length > 120) this.arrivalIntervals.shift();
      this.metrics.arrivalP50Ms = +percentile(this.arrivalIntervals, .5).toFixed(2);
      this.metrics.arrivalP95Ms = +percentile(this.arrivalIntervals, .95).toFixed(2);
      this.metrics.arrivalMaxMs = +Math.max(...this.arrivalIntervals).toFixed(2);
      if (this.adaptive && this.arrivalIntervals.length >= 12) {
        this.interpolationDelayMs = clamp(this.metrics.arrivalP95Ms + 30, 100, 200);
        this.metrics.interpolationDelayMs = +this.interpolationDelayMs.toFixed(2);
      }
    }
    if (!this.clockReady) this.setClockOffset(snapshot.serverTime - receivedAt);
    this.lastArrival = receivedAt;
    this.lastSequence = snapshot.sequence;
    this.snapshots.push(snapshot);
    if (this.snapshots.length > 64) this.snapshots.shift();
    this.metrics.bufferedSnapshots = this.snapshots.length;
    return true;
  }

  sample(clientTime = Date.now()) {
    if (!this.snapshots.length) return null;
    const targetTime = clientTime + this.clockOffsetMs - this.interpolationDelayMs;
    let before = null, after = null;
    for (const snapshot of this.snapshots) {
      if (snapshot.serverTime <= targetTime) before = snapshot;
      if (snapshot.serverTime >= targetTime) { after = snapshot; break; }
    }
    if (before && after && before !== after) {
      const span = Math.max(1, after.serverTime - before.serverTime);
      this.metrics.interpolatedFrames++;
      return interpolateSnapshot(before, after, clamp((targetTime - before.serverTime) / span, 0, 1));
    }
    if (!before) return this.snapshots[0];
    const milliseconds = clamp(targetTime - before.serverTime, 0, this.maxExtrapolationMs);
    if (milliseconds > 0) this.metrics.extrapolatedFrames++;
    return {
      ...before,
      ball: extrapolateBody(before.ball, milliseconds),
      players: before.players.map(player => ({ ...player, ...extrapolateBody(player, milliseconds) }))
    };
  }

  sampleLatestPlayer(playerId, clientTime = Date.now(), maxExtrapolationMs = 100) {
    const latest = this.snapshots.at(-1);
    const player = latest?.players.find(candidate => candidate.id === playerId);
    if (!player) return null;
    const targetTime = clientTime + this.clockOffsetMs;
    return { ...player, ...extrapolateBody(player, clamp(targetTime - latest.serverTime, 0, maxExtrapolationMs)) };
  }
}
