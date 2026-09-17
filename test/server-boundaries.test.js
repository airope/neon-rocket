import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {io} from 'socket.io-client';
import net from 'node:net';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,env={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'neon-server-'));
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const candidate=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(candidate),HOST:'127.0.0.1',NOVA_STATS_DB:path.join(dir,'stats.sqlite'),...env}});
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 t.after(async()=>{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await rm(dir,{recursive:true,force:true});});
 // Obtain the ephemeral port from the actual startup message.
 let port;for(let n=0;n<100;n++){const m=logs.match(/localhost:(\d+)/);if(m&&Number(m[1])){port=Number(m[1]);break;}if(child.exitCode!==null)break;await pause(50);}
 assert.ok(port,`server did not announce real port: ${logs}`);
 const url=`http://localhost:${port}`;
 const connect=async()=>{const s=io(url,{reconnection:false,forceNew:true});t.after(()=>s.disconnect());await new Promise((ok,no)=>{s.once('connect',ok);s.once('connect_error',no)});return s;};
 return {child,url,connect,logs:()=>logs};
}
const request=(s,event,payload)=>new Promise((resolve,reject)=>s.timeout(3000).emit(event,payload,(error,response)=>error?reject(error):resolve(response)));
test('self join rejects without destroying the host arena',async t=>{
 const f=await fixture(t),host=await f.connect();
 const created=await request(host,'createRoom',{name:'host'});assert.equal(created.ok,true);
 const own=await request(host,'joinRoom',{roomCode:created.roomCode});assert.equal(own.ok,false);
 assert.equal((await (await fetch(f.url+'/healthz')).json()).rooms,1);
 const guest=await f.connect();assert.equal((await request(guest,'joinRoom',{roomCode:created.roomCode,name:'guest'})).ok,true);
});
test('departure closes the room for the surviving peer, who can recreate immediately',async t=>{
 const f=await fixture(t),host=await f.connect(),guest=await f.connect();
 const created=await request(host,'createRoom',{});
 await request(guest,'joinRoom',{roomCode:created.roomCode});
 const closed=new Promise(resolve=>{guest.once('roomClosed',resolve);setTimeout(()=>resolve(null),800);});
 host.disconnect();
 assert.equal((await closed)?.roomCode,created.roomCode);
 assert.equal((await (await fetch(f.url+'/healthz')).json()).rooms,0);
 assert.equal((await request(guest,'createRoom',{})).ok,true);
});
test('malformed socket payload cannot terminate server',async t=>{
 const f=await fixture(t,{ROOM_COMMAND_BURST:'100',IP_CREATE_BURST:'100'}),s=await f.connect(),host=await f.connect();
 const created=await request(host,'createRoom',{});
 const guest=await f.connect();
 assert.equal((await request(guest,'joinRoom',{roomCode:created.roomCode})).ok,true);
 for(const event of ['createRoom','joinRoom','watchNovaDuel','input','networkPing','rematchRequest']) {
  for(const payload of [null,[], '', 7, false]) assert.equal((await request(s,event,payload)).ok,false);
  s.emit(event,{},'not-a-callback');
 }
 const state=await new Promise(resolve=>host.once('state',resolve));
 assert.equal(state.players.length,2);
 await pause(150);
 assert.equal(f.child.exitCode,null,f.logs());
 assert.equal((await fetch(f.url+'/healthz')).status,200);
});
