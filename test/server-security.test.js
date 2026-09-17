import test from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { createGameServer } from '../server.js';
import { createRocketSimRoom } from '../server/rocketsim-room.js';
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const request = (s,event,payload={}) => s.timeout(2000).emitWithAck(event,payload);
async function fixture(t,options={}) {
  const game = await createGameServer({port:0,statsPath:':memory:',...options});
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const clients = [];
  t.after(async()=>{for(const client of clients) client.disconnect(); await game.close();});
  const connect = async (extra={}) => {
    const socket = io(url,{reconnection:false,forceNew:true,timeout:1000,...extra});
    clients.push(socket);
    await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
    return socket;
  };
  return {...game,url,connect};
}
async function until(check) {
  for(let i=0;i<100;i++){if(check())return;await pause(10);}
  assert.ok(check(),'condition did not become true');
}

test('pending arena creation reserves capacity and serializes each socket',async t=>{
  let release, calls=0;
  const gate=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{limits:{maxRooms:1},roomFactory:async()=>{calls++;await gate;return createRocketSimRoom();}});
  t.after(()=>release());
  const a=await f.connect(),b=await f.connect();
  const first=request(a,'createRoom');
  await until(()=>calls===1);
  const duplicate=request(a,'createRoom');
  const overCapacity=request(b,'createRoom');
  await pause(30);
  const observedCalls=calls;
  release();
  const replies=await Promise.all([first,duplicate,overCapacity]);
  assert.equal(observedCalls,1,'only one arena may be under construction');
  assert.equal(replies[0].ok,true);
  assert.equal(replies[1].ok,false);
  assert.equal(replies[2].ok,false);
  assert.equal(f.rooms.size,1);
});

for (const action of ['leaveRoom','disconnect','watchNovaDuel']) test(`pending creation is canceled by ${action} and frees exactly once`,async t=>{
  let release, calls=0, frees=0;
  const gate=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{limits:{maxRooms:1},roomFactory:async()=>{
    calls++; await gate;
    const sim=await createRocketSimRoom();
    const free=sim.free.bind(sim); sim.free=()=>{frees++;free();};
    return sim;
  }});
  const a=await f.connect();
  let response;
  a.emit('createRoom',{},reply=>response=reply);
  await until(()=>calls===1);
  if(action==='disconnect') {a.disconnect();await until(()=>f.io.sockets.sockets.size===0);}
  else {a.emit(action,{});await until(()=>f.io.sockets.sockets.get(a.id).data.creation.cancelled);}
  release();
  await pause(80);
  assert.equal(f.rooms.size,0);
  assert.equal(frees,1);
  if(action!=='disconnect') assert.equal(response.ok,false);
  const b=await f.connect();
  assert.equal((await request(b,'createRoom')).ok,true,'reservation released');
});

for (const limits of [{maxConnections:1},{maxConnectionsPerIp:1}]) test(`transport admission bounded by ${Object.keys(limits)[0]} without trusting forwarded IP`,async t=>{
  const f=await fixture(t,{limits});
  const a=await f.connect({extraHeaders:{'X-Forwarded-For':'192.0.2.1'}});
  await assert.rejects(f.connect({extraHeaders:{'X-Forwarded-For':'192.0.2.2'}}));
  assert.equal(f.io.engine.clientsCount,1);
  a.disconnect();
  await until(()=>f.io.engine.clientsCount===0);
  assert.ok((await f.connect()).connected);
});

test('event flood is rejected before handlers while another player still receives snapshots',async t=>{
  const f=await fixture(t,{limits:{eventBurst:5,eventRate:1}});
  const good=await f.connect(),bad=await f.connect();
  assert.equal((await request(good,'createRoom')).ok,true);
  let states=0; good.on('state',()=>states++);
  const replies=[];
  for(let i=0;i<10;i++) replies.push(await request(bad,'networkPing'));
  assert.ok(replies.some(reply=>reply.code==='RATE_LIMIT'));
  await pause(120);
  assert.ok(states>0);
  assert.equal(f.rooms.size,1);
});
test('expensive room commands share a per-socket budget separate from gameplay input',async t=>{
  const f=await fixture(t,{limits:{commandBurst:2,commandRate:0.1}});
  const a=await f.connect();
  assert.equal((await request(a,'watchNovaDuel')).ok,true);
  assert.equal((await request(a,'joinRoom',{roomCode:'XXXXXX'})).ok,false);
  assert.equal((await request(a,'createRoom')).code,'RATE_LIMIT');
  assert.ok((await request(a,'networkPing')).serverTime);
});

test('creation budget is shared by address and survives reconnects',async t=>{
  const f=await fixture(t,{limits:{ipCreateBurst:1,ipCreateRate:0.01}});
  const a=await f.connect();
  assert.equal((await request(a,'createRoom')).ok,true);
  a.disconnect(); await until(()=>f.rooms.size===0);
  const b=await f.connect({extraHeaders:{'X-Forwarded-For':'192.0.2.8'}});
  assert.equal((await request(b,'createRoom')).code,'RATE_LIMIT');
});

for(const status of ['waiting','finished','playing']) test(`${status} idle expiry frees room once and clears all bindings`,async t=>{
  const f=await fixture(t,{limits:{waitingRoomMs:100,finishedRoomMs:100,idleRoomMs:100}});
  const a=await f.connect();
  const {roomCode}=await request(a,'createRoom');
  const room=f.rooms.get(roomCode); room.sim.status=status;
  let frees=0; const free=room.sim.free.bind(room.sim);room.sim.free=()=>{frees++;free();};
  let closed; a.once('roomClosed',value=>closed=value);
  await pause(200);
  assert.equal(f.rooms.size,0);
  assert.equal(frees,1);
  assert.equal(closed.reason,'expired');
  assert.equal(f.io.sockets.sockets.get(a.id).data.room,null);
  assert.equal(f.io.sockets.adapter.rooms.has(roomCode),false);
});
test('input is neutralized when its last update becomes stale',async t=>{
  const f=await fixture(t,{limits:{inputStaleMs:60}});
  const a=await f.connect();
  const {roomCode}=await request(a,'createRoom');
  const player=f.rooms.get(roomCode).sim.players.get(a.id);
  a.emit('input',{throttle:1,boost:true});
  await until(()=>player.input.throttle===1);
  await pause(120);
  assert.equal(player.input.throttle,0);
  assert.equal(player.input.boost,false);
});

test('default bind is loopback, not all interfaces',async t=>{
  const f=await fixture(t);
  assert.equal(f.server.address().address,'127.0.0.1');
});
for(const transport of ['polling','websocket']) test(`${transport} checks browser Origin at admission and permits configured public origin`,async t=>{
  const f=await fixture(t,{allowedOrigins:['https://play.example.test']});
  await assert.rejects(f.connect({transports:[transport],extraHeaders:{Origin:'https://evil.example.test'}}));
  assert.ok((await f.connect({transports:[transport],extraHeaders:{Origin:'https://play.example.test'}})).connected);
  assert.ok((await f.connect({transports:[transport]})).connected,'absent Origin explicitly supported for CLI clients');
});
for(const transport of ['polling','websocket']) test(`${transport} disconnects over-size messages`,async t=>{
  const f=await fixture(t,{limits:{maxMessageBytes:1024}});
  const a=await f.connect({transports:[transport]});
  a.emit('networkPing',{padding:'x'.repeat(2048)});
  await pause(150);
  assert.equal(a.connected,false);
  assert.equal((await fetch(f.url+'/healthz')).status,200);
});

test('MAX_ROOMS is configurable and invalid limits fail closed before listen',async t=>{
  const previous=process.env.MAX_ROOMS;
  process.env.MAX_ROOMS='1';
  t.after(()=>{if(previous===undefined)delete process.env.MAX_ROOMS;else process.env.MAX_ROOMS=previous;});
  const f=await fixture(t);
  assert.equal((await request(await f.connect(),'createRoom')).ok,true);
  assert.equal((await request(await f.connect(),'createRoom')).ok,false);
  await assert.rejects(createGameServer({port:0,statsPath:':memory:',limits:{maxRooms:-1}}),/maxRooms/);
});

test('live metrics receive active Rapier arena geometry',async t=>{
  const f=await fixture(t);
  const {FIELD}=await import('../shared/simulation-v3.js');
  assert.equal(f.liveDuel.stats.field.halfX,FIELD.halfX);
});
test('failed stats persistence is observable without stopping live simulation',async t=>{
  let attempts=0;
  const store={saveMatch(){attempts++;throw new Error('simulated disk full');},close(){}};
  const f=await fixture(t,{statsStore:store});
  f.liveDuel.sim.status='finished';
  f.liveDuel.sim.events.push({type:'finished',team:0,score:[5,0]});
  await pause(80);
  assert.equal(attempts,1);
  const diagnostics=await (await fetch(f.url+'/api/network-diagnostics')).json();
  assert.equal(diagnostics.statsWriteErrors,1);
  assert.ok(f.liveDuel.restartAt>0);
  const before=f.liveDuel.simulationTick;
  await pause(50);
  assert.ok(f.liveDuel.simulationTick>before);
});

test('malformed nested control values cannot enable boost or nonfinite axes',async t=>{
  const f=await fixture(t),a=await f.connect();
  const {roomCode}=await request(a,'createRoom');
  const player=f.rooms.get(roomCode).sim.players.get(a.id);
  a.emit('input',{throttle:'1e999',steer:{},pitch:[],boost:{},jump:'yes',handbrake:1});
  await request(a,'networkPing');
  assert.equal(player.input.throttle,0);
  assert.equal(player.input.boost,false);
  assert.equal(player.input.jump,false);
  assert.equal(player.input.handbrake,false);
});
test('invalid name and code objects cannot leave an orphan arena',async t=>{
  const f=await fixture(t),a=await f.connect();
  const result=await request(a,'createRoom',{name:{toString:{}}});
  assert.equal(result.ok,true);
  assert.equal(f.rooms.get(result.roomCode).sim.players.get(a.id).name,'Pilote');
  assert.equal((await request(a,'joinRoom',{roomCode:{toString:{}}})).ok,false);
});

test('room-code collisions are retried and closed channels do not retain peers on code reuse',async t=>{
  let calls=0;
  const f=await fixture(t,{randomIndex:()=>calls++<12?0:1});
  const a=await f.connect(),b=await f.connect(),c=await f.connect();
  const first=await request(a,'createRoom');
  const second=await request(c,'createRoom');
  assert.equal(first.roomCode,'AAAAAA');
  assert.equal(second.roomCode,'BBBBBB');
  await request(b,'joinRoom',{roomCode:first.roomCode});
  a.emit('leaveRoom');await until(()=>!f.rooms.has(first.roomCode));
  assert.equal(f.io.sockets.sockets.get(b.id).data.room,null);
  calls=0;
  const reused=await request(a,'createRoom');
  assert.equal(reused.roomCode,first.roomCode);
  let stale=0;b.on('state',()=>stale++);
  await pause(120);
  assert.equal(stale,0);
});

test('failed player initialization frees the allocated room and releases capacity',async t=>{
  let frees=0,calls=0;
  const f=await fixture(t,{limits:{maxRooms:1},roomFactory:async()=>{
    const sim=await createRocketSimRoom();calls++;
    const free=sim.free.bind(sim);sim.free=()=>{frees++;free();};
    if(calls===1)sim.addPlayer=()=>{throw new Error('injected addPlayer failure');};
    return sim;
  }});
  const a=await f.connect();
  assert.equal((await request(a,'createRoom')).ok,false);
  assert.equal(f.rooms.size,0);
  assert.equal(frees,1);
  assert.equal((await request(a,'createRoom')).ok,true);
});

test('watchNovaDuel puts two observers on the same read-only live stream',async t=>{
  const f=await fixture(t),a=await f.connect(),b=await f.connect();
  const first=await request(a,'watchNovaDuel'),second=await request(b,'watchNovaDuel');
  assert.equal(first.ok,true);assert.equal(second.ok,true);
  assert.equal(second.viewers,2);assert.equal(first.state.live,true);
  assert.deepEqual(first.state.players.map(p=>p.id),['NOVA1','NOVA2']);
  a.emit('input',{throttle:1,boost:true});
  const [sa,sb]=await Promise.all([new Promise(r=>a.once('state',r)),new Promise(r=>b.once('state',r))]);
  assert.equal(sa.sequence,sb.sequence);assert.deepEqual(sa.ball,sb.ball);
  assert.equal(f.rooms.size,0);assert.equal(f.liveDuel.sim.players.size,2);
});
for(const status of ['countdown','playing','goal','finished']) for(const departHost of [true,false]) test(`${status}: ${departHost?'host':'guest'} departure clears peer and native arena`,async t=>{
  const f=await fixture(t),a=await f.connect(),b=await f.connect();
  const {roomCode}=await request(a,'createRoom');await request(b,'joinRoom',{roomCode});
  const room=f.rooms.get(roomCode);room.sim.status=status;if(status==='goal')room.sim.goalTicks=1000;
  let frees=0;const free=room.sim.free.bind(room.sim);room.sim.free=()=>{frees++;free();};
  const departed=departHost?a:b,survivor=departHost?b:a;
  const notification=new Promise(r=>survivor.once('roomClosed',r));
  departed.disconnect();assert.equal((await notification).roomCode,roomCode);
  assert.equal(frees,1);assert.equal(f.rooms.size,0);
  assert.equal(f.io.sockets.adapter.rooms.has(roomCode),false);
  assert.equal(f.io.sockets.sockets.get(survivor.id).data.room,null);
  assert.equal((await request(survivor,'createRoom')).ok,true);
});
test('joining another room cancels a pending creation without disturbing the joined match',async t=>{
  let release,calls=0,frees=0;
  const gate=new Promise(r=>release=r);
  const f=await fixture(t,{roomFactory:async()=>{
    if(++calls===2)await gate;
    const sim=await createRocketSimRoom();const free=sim.free.bind(sim);sim.free=()=>{frees++;free();};return sim;
  }});
  const host=await f.connect(),guest=await f.connect();
  const {roomCode}=await request(host,'createRoom');
  const creating=request(guest,'createRoom');await until(()=>calls===2);
  assert.equal((await request(guest,'joinRoom',{roomCode})).ok,true);
  release();assert.equal((await creating).ok,false);
  assert.equal(frees,1);assert.equal(f.rooms.size,1);
  assert.equal(f.io.sockets.sockets.get(guest.id).data.room,roomCode);
});

test('explicit leave notifies the departing member as well as its peer',async t=>{
  const f=await fixture(t),a=await f.connect(),b=await f.connect();
  const {roomCode}=await request(a,'createRoom');await request(b,'joinRoom',{roomCode});
  let closed;a.on('roomClosed',value=>closed=value);
  a.emit('leaveRoom');await pause(60);
  assert.equal(closed?.roomCode,roomCode);
  assert.equal(f.io.sockets.sockets.get(a.id).data.room,null);
});
