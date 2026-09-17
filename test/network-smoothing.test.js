import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkTimeline } from '../public/network-interpolation.js';
import { FixedStepClock } from '../server/fixed-step.js';
import { stampSnapshot } from '../server/network-state.js';

function snapshot(sequence, serverTime, x) {
  return {
    sequence, serverTime, simulationTick: sequence * 3,
    score: [0, 0], status: 'playing',
    ball: { p: [x, 2, 0], q: [0, 0, 0, 1], v: [100, 0, 0] },
    players: [{ id: 'a', p: [x, 1, 0], q: [0, 0, 0, 1], v: [100, 0, 0] }],
    boostPads: []
  };
}

test('network timeline renders by server time instead of latest packet arrival', () => {
  const timeline = new NetworkTimeline({ interpolationDelayMs: 150 });
  timeline.setClockOffset(0);
  timeline.push(snapshot(1, 1000, 0), 1020);
  timeline.push(snapshot(2, 1050, 5), 1170);
  timeline.push(snapshot(3, 1100, 10), 1180);
  const rendered = timeline.sample(1200);
  assert.equal(rendered.ball.p[0], 5);
  assert.equal(rendered.players[0].p[0], 5);
  assert.equal(timeline.metrics.bufferedSnapshots, 3);
});

test('network timeline rejects stale packets and reports missing sequences', () => {
  const timeline = new NetworkTimeline();
  assert.equal(timeline.push(snapshot(10, 1000, 0), 1020), true);
  assert.equal(timeline.push(snapshot(12, 1100, 10), 1120), true);
  assert.equal(timeline.push(snapshot(11, 1050, 5), 1130), false);
  assert.equal(timeline.metrics.droppedSnapshots, 1);
  assert.equal(timeline.metrics.outOfOrderSnapshots, 1);
});

test('network extrapolation is bounded when jitter exhausts the buffer', () => {
  const timeline = new NetworkTimeline({ interpolationDelayMs: 100, maxExtrapolationMs: 80 });
  timeline.setClockOffset(0);
  timeline.push(snapshot(1, 1000, 0), 1010);
  const rendered = timeline.sample(1300);
  assert.equal(rendered.ball.p[0], 8);
  assert.equal(timeline.metrics.extrapolatedFrames, 1);
});

test('room snapshots carry monotonic sequence, server time and simulation tick', () => {
  const room = { sequence: 0, simulationTick: 42, sim: { snapshot: () => ({ score: [1, 2] }) } };
  const first = stampSnapshot(room, 1234);
  const second = stampSnapshot(room, 1284);
  assert.deepEqual(first, { score: [1, 2], sequence: 1, serverTime: 1234, simulationTick: 42 });
  assert.equal(second.sequence, 2);
  assert.equal(second.serverTime, 1284);
});

test('fixed-step clock catches up delayed server timers without variable physics dt', () => {
  const clock = new FixedStepClock({ stepMs: 1000 / 60, maxCatchUpSteps: 8 });
  const dts = [];
  clock.advance(0, dt => dts.push(dt));
  clock.advance(100, dt => dts.push(dt));
  assert.equal(dts.length, 6);
  assert.ok(dts.every(dt => Math.abs(dt - 1 / 60) < 1e-12));
});
