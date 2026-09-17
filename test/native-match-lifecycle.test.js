import test from 'node:test';
import assert from 'node:assert/strict';
import { createRocketSimSoloSimulation } from '../shared/rocketsim-local-simulation.js';
import { createRocketSimRoom } from '../server/rocketsim-room.js';
import { CAR_SOCCER_FIELD as field } from '../shared/car-soccer-contract.js';

// Real native integration fixtures, distinct from the browser's legacy previews.
for (const [name, create] of [['solo', createRocketSimSoloSimulation], ['room', createRocketSimRoom]]) {
  for (const scoringTeam of [0, 1]) test(`${name}: native goal, celebration, final score and explicit restart (team ${scoringTeam})`, async () => {
    const sim = await create({targetScore:2});
    try {
      sim.addPlayer({id:'a',team:0});sim.addPlayer({id:'b',team:1});sim.start();
      const ticks=n=>{for(let i=0;i<n;i++)sim.step(1/120);};
      ticks(360);assert.equal(sim.status,'playing');sim.drainEvents();
      const score=()=>{
        const sign=scoringTeam===0?1:-1;
        sim.ball.setState({position:{x:sign*(field.halfLength-2),y:field.ballRadius+.1,z:0},velocity:{x:sign*20,y:0,z:0}});
        for(let i=0;i<120&&sim.status==='playing';i++)sim.step(1/120);
        assert.ok(sim.drainEvents().some(e=>e.type==='goal'&&e.team===scoringTeam));
      };
      score();assert.equal(sim.score[scoringTeam],1);assert.equal(sim.status,'goal');
      ticks(179);assert.equal(sim.status,'goal');ticks(1);assert.equal(sim.status,'countdown');
      ticks(360);score();assert.equal(sim.status,'finished');assert.equal(sim.winner,scoringTeam);
      const final=sim.snapshot();ticks(600);assert.deepEqual(sim.snapshot().score,final.score);assert.equal(sim.status,'finished');
      sim.start();assert.equal(sim.status,'countdown');assert.deepEqual(sim.score,[0,0]);assert.equal(sim.winner,null);
    } finally {sim.free();}
  });
}
