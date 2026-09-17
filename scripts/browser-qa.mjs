#!/usr/bin/env node
// Dependency-free real Chrome QA. Node >=22; never attaches to a user's profile.
// BASE_URL=http://localhost:3457 QA_OUTPUT=/absolute/report/path node scripts/browser-qa.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const staticDemo = process.env.STATIC_DEMO === '1';
const base = process.env.BASE_URL || (staticDemo ? 'http://localhost:3457/neon-rocket/' : 'http://localhost:3457');
if (staticDemo && new URL(base).pathname !== '/neon-rocket/') throw new Error('STATIC_DEMO requires the exact /neon-rocket/ URL prefix');
const out = path.resolve(process.env.QA_OUTPUT || '../neon-rocket-open-source-audit/browser');
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { startedAt: new Date().toISOString(), baseURL: base, method: 'Isolated installed Chrome, CDP trusted mouse/keyboard, read-only runtime diagnostics', checks: [], cases: [], limitations: ['No physical gamepad or mobile hardware tested.', 'Goal/final query fixtures deliberately use legacy engine; not production RocketSim scoring proof.', 'Local URL evidence is not public deployment certification.'] };
function check(name, ok, details) { report.checks.push({ name, ok: !!ok, details }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
class CDP {
  constructor(ws) { this.ws = ws; this.next = 0; this.pending = new Map(); this.listeners = []; ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } } else for (const fn of this.listeners) fn(m); }); }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((r,j) => { ws.addEventListener('open',r,{once:true}); ws.addEventListener('error',j,{once:true}); }); return new CDP(ws); }
  send(method, params = {}, sessionId) { const id = ++this.next; return new Promise((resolve,reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000); this.pending.set(id,{resolve,reject,timer}); this.ws.send(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})})); }); }
}
let cdp, chrome, profile;
const contexts = new Set();
report.mode = staticDemo ? 'static-solo' : 'full';
report.skipped = staticDemo ? ['health endpoints: static host has no backend', 'private-room and disconnect cleanup: no backend', 'live-duel: no backend', 'legacy goal/final fixtures: static mode covers native solo only'] : [];
async function newPage(label, query = '') {
  const { browserContextId } = await cdp.send('Target.createBrowserContext'); contexts.add(browserContextId);
  const { targetId } = await cdp.send('Target.createTarget',{url:'about:blank',browserContextId});
  const { sessionId } = await cdp.send('Target.attachToTarget',{targetId,flatten:true});
  const result = { label, url: new URL(staticDemo ? query.replace(/^\//, '') || './' : query || '/', base).href, exceptions: [], console: [], requests: [], responses: [], failedRequests: [], wasmScripts: [], screenshots: [] }; report.cases.push(result);
  const send = (method,params={}) => cdp.send(method,params,sessionId);
  cdp.listeners.push(m => { if(m.sessionId !== sessionId) return; const p=m.params;
    if(m.method==='Runtime.exceptionThrown') result.exceptions.push(p.exceptionDetails);
    if(m.method==='Runtime.consoleAPICalled' && ['error','warning','warn'].includes(p.type)) result.console.push({type:p.type,args:p.args.map(a=>a.value ?? a.description)});
    if(m.method==='Network.webSocketCreated') result.requests.push({url:p.url,type:'WebSocket'});
    if(m.method==='Network.requestWillBeSent') result.requests.push({url:p.request.url,type:p.type});
    if(m.method==='Network.responseReceived') result.responses.push({url:p.response.url,status:p.response.status,mimeType:p.response.mimeType});
    if(m.method==='Network.loadingFailed') result.failedRequests.push(p);
    if(m.method==='Debugger.scriptParsed' && (p.scriptLanguage==='WebAssembly' || p.url.startsWith('wasm:'))) result.wasmScripts.push({url:p.url,scriptLanguage:p.scriptLanguage});
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Debugger.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  const evalJS = async expression => { const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
  const wait = async (expression,timeout=20000) => { const until=Date.now()+timeout; let v; while(Date.now()<until) { v=await evalJS(expression); if(v) return v; await sleep(100); } throw new Error(`Wait timed out: ${expression}`); };
  const click = async selector => { const b = await evalJS(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;const r=e.getBoundingClientRect();return r.width&&r.height&&getComputedStyle(e).visibility!=='hidden'?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`); if(!b) throw new Error(`Not clickable: ${selector}`); await send('Input.dispatchMouseEvent',{type:'mousePressed',...b,button:'left',clickCount:1}); await send('Input.dispatchMouseEvent',{type:'mouseReleased',...b,button:'left',clickCount:1}); };
  const key = (code,down,keyValue=code) => send('Input.dispatchKeyEvent',{type:down?'keyDown':'keyUp',code,key:keyValue,windowsVirtualKeyCode: code==='KeyW'?87:code==='ShiftLeft'?16:code==='ArrowDown'?40:code==='Tab'?9:code==='Enter'?13:0});
  const shot = async name => { const file=`${label}-${name}.png`; const {data}=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}); await writeFile(path.join(out,file),Buffer.from(data,'base64')); result.screenshots.push(file); };
  const snap = () => evalJS(`(()=>{const d=window.__neonRocketDebug?.(); const n=window.__nr3d; return d?{localId:d.localId,networkMode:d.networkMode,state:d.state,camera:d.camera,cars:d.cars,performance:n?.performance,network:n?.network,projectedCars:n?.cars,announcement:document.querySelector('#announcement').textContent,boostHUD:document.querySelector('#boostValue').textContent}:null})()`);
  const close = async () => { if(contexts.delete(browserContextId)) await cdp.send('Target.disposeBrowserContext',{browserContextId}); };
  await send('Page.navigate',{url:result.url});
  await wait(`document.readyState==='complete' && typeof window.__neonRocketDebug==='function'`);
  result.wasmScriptsAtLobby=result.wasmScripts.length;
  return {result,send,evalJS,wait,click,key,shot,snap,close};
}
async function movement(p) {
  const before=await p.snap(); const samples=[];
  try { await p.key('KeyW',true,'w'); await p.key('ShiftLeft',true,'Shift'); for(let i=0;i<10;i++){await sleep(200);samples.push(await p.snap());} }
  finally { await p.key('KeyW',false,'w'); await p.key('ShiftLeft',false,'Shift'); }
  const after=await p.snap(); const own=s=>s.state.players.find(x=>x.id===s.localId);
  const distance=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));
  const initial=own(before), final=own(after);
  const metrics={before,after,samples,displacement:distance(initial.p,final.p),cameraDisplacement:distance(before.camera,after.camera),minimumBoost:Math.min(...samples.map(s=>own(s).boost)),initialBoost:initial.boost};
  p.result.movement=metrics;
  check(`${p.result.label}: forward movement`,metrics.displacement>1,{distance:metrics.displacement});
  check(`${p.result.label}: boost consumed`,metrics.minimumBoost<metrics.initialBoost,{initial:metrics.initialBoost,min:metrics.minimumBoost});
  check(`${p.result.label}: camera follows`,metrics.cameraDisplacement>1,{distance:metrics.cameraDisplacement});
  check(`${p.result.label}: rendered car geometry`,after.performance?.drawCalls>0 && after.cars.length===2,after.performance);
  await p.shot('moving');
}
async function safeCase(name,fn){try{await fn();}catch(e){check(name,false,e.stack);}}
try {
  await mkdir(out,{recursive:true}); profile=await mkdtemp(path.join(tmpdir(),'neon-rocket-qa-'));
  chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-renderer-backgrounding','--disable-background-timer-throttling','--window-size=1280,800','about:blank'],{stdio:['ignore','ignore','pipe']});
  let chromeLog='';chrome.stderr.on('data',d=>chromeLog+=d);
  let port;for(let i=0;i<100;i++){try{port=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await sleep(100);}}
  if(!port)throw new Error(`Chrome did not launch: ${chromeLog}`);
  const version=await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();report.browser=version;
  cdp=await CDP.connect(version.webSocketDebuggerUrl);
  if (!staticDemo) report.healthBefore=await (await fetch(new URL('/healthz',base))).json();
  for(const opponent of [1,2,3]) await safeCase(`solo-${opponent}`,async()=>{
    const p=await newPage(`solo-${opponent}`);
    try {
      if (staticDemo) {
        p.result.staticLobby = await p.evalJS(`({controls:['create','join','code','novaDuel'].map(id=>({id,disabled:document.getElementById(id)?.disabled})),note:document.getElementById('static-demo-note')?.textContent,socketConnected:window.io().connected})`);
        check(`solo-${opponent}: backend disabled and explained`,p.result.staticLobby.controls.every(x=>x.disabled) && p.result.staticLobby.socketConnected===false && p.result.staticLobby.note?.includes('SOLO UNIQUEMENT'),p.result.staticLobby);
        await p.shot('lobby');
      }
      // Equivalent to Playwright selectOption: change the actual HTML select,
      // dispatch its normal form events, then click the visible launch button.
      // macOS headless native popup ignores CDP arrow-key selection.
      await p.evalJS(`(()=>{const select=document.querySelector('#novaVersion');select.value=${JSON.stringify(String(opponent))};select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      p.result.selectionMethod='HTML selectOption equivalent (value + input/change); trusted mouse click launches game';
      p.result.selected=await p.evalJS(`document.querySelector('#novaVersion').value`);
      check(`solo-${opponent}: selected UI opponent`,p.result.selected===String(opponent));
      await p.click('#solo');
      await p.wait(`window.__nr3d?.state?.status==='countdown'`);
      p.result.countdown=await p.snap();await p.shot('countdown');
      await p.wait(`window.__nr3d?.state?.status==='playing'`,30000);
      p.result.kickoff=await p.snap();await p.shot('playing');
      const state=p.result.kickoff.state;
      check(`solo-${opponent}: engine loaded`,state.physics?.engine==='native' && state.players.find(x=>x.id==='NOVA')?.aiVersion===opponent && p.result.wasmScripts.length>p.result.wasmScriptsAtLobby && p.result.requests.some(r=>r.url.includes('/native/rocketsim/dist/rocketsim.mjs')),{physics:state.physics,wasmScripts:p.result.wasmScripts});
      check(`solo-${opponent}: no separate WASM fetch`,!p.result.requests.some(r=>/\.wasm(?:\?|$)/.test(r.url)));
      await movement(p);
      check(`solo-${opponent}: bot moved`,JSON.stringify(p.result.countdown.state.players.find(x=>x.id==='NOVA').p)!==JSON.stringify(p.result.movement.after.state.players.find(x=>x.id==='NOVA').p));
    } finally { await p.shot('final-evidence'); await p.close(); }
  });
  if (!staticDemo) await safeCase('private-room',async()=>{
    const a=await newPage('private-host'),b=await newPage('private-guest');
    try {
      for(const p of [a,b])await p.wait(`document.querySelector('#connection').classList.contains('ok')`);
      await a.click('#create');await a.wait(`/^[A-Z0-9]{6}$/.test(document.querySelector('#room').textContent)`);
      const code=await a.evalJS(`document.querySelector('#room').textContent`);a.result.roomCode=code;
      await a.wait(`window.__nr3d?.state?.status==='waiting'`);a.result.waiting=await a.snap();await a.shot('waiting');
      await b.click('#code');await b.send('Input.insertText',{text:code});await b.click('#join');
      await a.wait(`window.__nr3d?.state?.status==='countdown'`);a.result.countdown=await a.snap();await a.shot('countdown');
      for(const p of [a,b]){await p.wait(`window.__nr3d?.state?.status==='playing'`,30000);p.result.kickoff=await p.snap();await p.shot('playing');check(`${p.result.label}: authoritative engine`,p.result.kickoff.state.physics?.engine==='rocketsim-wasm' && p.result.kickoff.state.players.length===2,p.result.kickoff.state.physics);}
      await movement(a);
      b.result.afterHostMovement=await b.snap();
      const sequences=a.result.movement.samples.map(s=>s.state.sequence).filter(x=>typeof x==='number');
      check('private-room: increasing sampled snapshots',sequences.length>1 && sequences.every((x,i)=>!i||x>sequences[i-1]),sequences);
      await b.close();await a.wait(`!document.querySelector('#lobby').classList.contains('hidden')`,10000);
      check('private-room: survivor returns to lobby',true);
      a.result.afterDisconnect=await a.snap();await a.shot('peer-disconnected');
      report.healthAfterDisconnect=await (await fetch(new URL('/healthz',base))).json();
      check('private-room: room cleanup',report.healthAfterDisconnect.rooms===report.healthBefore.rooms,report.healthAfterDisconnect);
      await a.click('#create');await a.wait(`window.__nr3d?.state?.status==='waiting' && document.querySelector('#lobby').classList.contains('hidden')`);
      check('private-room: survivor can create again',true);
    }finally{await a.close();await b.close();}
  });
  if (!staticDemo) for(const fixture of ['goal','final'])await safeCase(`fixture-${fixture}`,async()=>{
    const p=await newPage(`fixture-${fixture}`,`/?match-preview=${fixture}`);
    try{await p.click('#solo');await p.wait(`(window.__nr3d?.state?.score||[]).some(x=>x>0)`);p.result.scored=await p.snap();await p.shot('scored');check(`fixture-${fixture}: score advanced`,true,{physics:p.result.scored.state.physics,score:p.result.scored.state.score});
      if(fixture==='final'){await p.wait(`!document.querySelector('#matchEnd').classList.contains('hidden')`);await p.shot('final-overlay');await p.click('#rematch');await p.wait(`window.__nr3d?.state?.status==='countdown'`);p.result.rematch=await p.snap();await p.shot('rematch');check('legacy fixture: real rematch UI',p.result.rematch.state.score.every(x=>x===0));}
    }finally{await p.close();}
  });
  if (!staticDemo) await safeCase('live-duel',async()=>{const p=await newPage('live-duel');try{await p.wait(`document.querySelector('#connection').classList.contains('ok')`);await p.click('#novaDuel');await p.wait(`window.__nr3d?.state?.players?.length===2`);await sleep(1000);p.result.observation=await p.snap();await p.shot('observing');check('live duel: server spectator',p.result.observation.networkMode && p.result.observation.localId===null,p.result.observation.state.physics);}finally{await p.close();}});
  for(const r of report.cases){check(`${r.label}: no uncaught exceptions`,r.exceptions.length===0,r.exceptions);check(`${r.label}: no console errors`,!r.console.some(x=>x.type==='error'),r.console);}
  if (staticDemo) for (const r of report.cases) {
    check(`${r.label}: zero socket/backend requests`, !r.requests.some(x=>x.type==='WebSocket'||/\/socket\.io(?:\/|\?)|\/healthz(?:$|\?)/.test(x.url)), r.requests);
    check(`${r.label}: assets stay under exact project prefix`,r.requests.filter(x=>/^https?:/.test(x.url)).every(x=>{const u=new URL(x.url);return u.origin===new URL(base).origin&&u.pathname.startsWith('/neon-rocket/');}));
    check(`${r.label}: no failed HTTP assets`,r.responses.every(x=>x.status<400)&&r.failedRequests.length===0,{errors:r.responses.filter(x=>x.status>=400),failedRequests:r.failedRequests});
  }
  if (!staticDemo) report.healthAfter=await (await fetch(new URL('/healthz',base))).json();
  await writeFile(path.join(out,'chrome-stderr.log'),chromeLog);
}catch(e){report.fatal=e.stack;console.error(e);}
finally{
  if(cdp){for(const browserContextId of contexts)await cdp.send('Target.disposeBrowserContext',{browserContextId}).catch(()=>{});await cdp.send('Browser.close').catch(()=>{});cdp.ws.close();}
  if(chrome && chrome.exitCode===null)chrome.kill();
  if(profile)await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250}).catch(()=>{});
  report.finishedAt=new Date().toISOString();report.passed=!report.fatal&&report.checks.every(x=>x.ok);
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(`Report: ${path.join(out,'report.json')}`);process.exitCode=report.passed?0:1;
}
