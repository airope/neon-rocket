export class FixedStepClock {
  constructor({ stepMs = 1000 / 60, maxCatchUpSteps = 8 } = {}) {
    this.stepMs = stepMs;
    this.maxCatchUpSteps = maxCatchUpSteps;
    this.lastTime = null;
    this.accumulator = 0;
    this.droppedMilliseconds = 0;
  }

  advance(now, step) {
    if (this.lastTime === null) { this.lastTime = now; return 0; }
    const elapsed = Math.max(0, Math.min(now - this.lastTime, 250));
    this.lastTime = now;
    this.accumulator += elapsed;
    let count = 0;
    while (this.accumulator + 1e-9 >= this.stepMs && count < this.maxCatchUpSteps) {
      step(this.stepMs / 1000);
      this.accumulator -= this.stepMs;
      count++;
    }
    if (count === this.maxCatchUpSteps && this.accumulator >= this.stepMs) {
      this.droppedMilliseconds += this.accumulator;
      this.accumulator = 0;
    }
    return count;
  }
}
