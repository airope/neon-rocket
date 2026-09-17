import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for (const event of ['roomClosed','disconnect']) test(`${event} returns multiplayer to a clean reusable lobby`, () => {
  const nodes = new Map();
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, {value:'', textContent:'', classList:{ add(){},remove(){},toggle(){} }});
    return nodes.get(key);
  };
  const handlers = {};
  let reset = 0;
  const source = fs.readFileSync(new URL('../public/game.js', import.meta.url),'utf8').replace(/^import .*;\n/gm,'').split('function init3D()')[0];
  const context = vm.createContext({
    THREE:{Vector3:class {},Raycaster:class {}}, document:{querySelector:node},
    blankInput:()=>({throttle:0}),NetworkTimeline:class {reset(){reset++;}},
    URLSearchParams,location:{search:''},performance,window:{io:true},
    io:()=>({on:(key,handler)=>{handlers[key]=handler;}}),localStorage:{getItem(){},setItem(){}},
    clearTimeout,setTimeout,console
  });
  vm.runInContext(source,context);
  vm.runInContext('networkMode=true; currentState={}; localId="old"; held.add("KeyW");',context);
  assert.equal(typeof handlers[event],'function');
  handlers[event]({reason:'peer-left'});
  assert.equal(vm.runInContext('networkMode',context),false);
  assert.equal(vm.runInContext('currentState',context),null);
  assert.equal(vm.runInContext('localId',context),null);
  assert.equal(vm.runInContext('held.size',context),0);
  assert.equal(reset,1);
  assert.match(node('#error').textContent,/salon|adversaire/i);
});
