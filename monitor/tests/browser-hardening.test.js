'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const {createMonitor}=require('../server');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,predicate,ms=12000){const end=Date.now()+ms;for(;;){const value=await fn();if(predicate(value))return value;if(Date.now()>end)throw new Error('Timed out waiting for test state');await wait(50);}}
const game=`<!doctype html><body><div class="userBalanceMoney">1000</div>
<div class="betSectionBlock"><input class="betSectionInput" value="10"><button class="betButton cashout">cash out</button>
<button class="autoPlayButton">auto play</button><div class="autoCashOut"><input class="autoPlayTagInput" value="2"></div></div>
<div id="results"><div>1.1x</div><div>2.2x</div><div>3.3x</div><div>4.4x</div><div>5.5x</div></div>
<script>window.starts=0;document.querySelector('.autoPlayButton').onclick=e=>{const on=e.target.classList.toggle('active');e.target.textContent=on?'stop':'auto play';if(on)window.starts++};</script>`;
const form=`<!doctype html><body><form onsubmit="event.preventDefault();window.sent={u:this.username.value,p:this.password.value};this.remove()"><input name="username"><input name="password" type="password"><button>Login</button></form>`;
async function fixture(run){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'monitor-browser-hardening-'));
 const srv=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url.startsWith('/login')?form:game)});
 await new Promise(r=>srv.listen(0,'127.0.0.1',r));
 const gamePort=srv.address().port;
 const m=createMonitor({port:0,headless:true,dataDir:path.join(dir,'data'),profileDir:path.join(dir,'profile'),staleMs:5000});
 try{const base=`http://localhost:${await m.listen()}`;const post=(route,body)=>fetch(base+route,{method:'POST',body:JSON.stringify(body)}).then(r=>r.json());await run({m,post,gamePort});}
 finally{await m.close();await new Promise(r=>srv.close(r));fs.rmSync(dir,{recursive:true,force:true});}
}
test('autopilot waits during an active bet, starts once ready, and stops on stale capture',async()=>{
 await fixture(async({m,post,gamePort})=>{
  await post('/api/start',{url:`http://localhost:${gamePort}/`});
  await until(()=>m.state(),s=>s.capture.status==='live'&&s.session.game?.slots.length);
  await post('/api/autopilot/settings',{betValue:10,target:2,lossStreak:10});
  const on=await post('/api/autopilot',{on:true});assert.equal(on.ok,true,on.error);assert.equal(m.state().autopilot.phase,'waiting');
  const page=m._context().pages()[0];assert.equal(await page.evaluate(()=>window.starts),0);
  await page.evaluate(()=>{const b=document.querySelector('.betButton');b.className='betButton start';b.textContent='bet'});
  await until(()=>page.evaluate(()=>window.starts),n=>n===1);
  assert.equal(m.state().autopilot.phase,'running');
  await until(()=>m.state(),s=>s.capture.stale&&!s.autopilot.on,10000);
  await until(()=>page.evaluate(()=>document.querySelector('.autoPlayButton').classList.contains('active')),on=>!on);
  assert.equal(await page.evaluate(()=>window.starts),1,'no duplicate start');
  const retry=await post('/api/autopilot',{on:true});assert.equal(retry.ok,false);assert.match(retry.error,/stale/);
 });
});
test('saved login cannot be submitted to another origin or a cross-origin frame',async()=>{
 await fixture(async({m,post,gamePort})=>{
  await post('/api/start',{url:`http://localhost:${gamePort}/login`});
  let login=await post('/api/game/login',{username:'test-user',password:'test-pass',remember:true});
  // Navigation is asynchronous; allow the form to load before requesting login.
  if(!login.ok){await wait(500);login=await post('/api/game/login',{username:'test-user',password:'test-pass',remember:true});}
  assert.equal(login.ok,true,login.error);
  await post('/api/start',{url:`http://127.0.0.1:${gamePort}/login`});
  const refused=await post('/api/game/login',{saved:true});assert.equal(refused.ok,false);assert.match(refused.error,/another site/);
  const page=m._context().pages()[0];await until(()=>page.locator('input[type=password]').count(),n=>n===1);
  assert.equal(await page.locator('input[type=password]').inputValue(),'');
  await post('/api/start',{url:`http://localhost:${gamePort}/login`});
  const nextPage=m._context().pages()[0];
  await nextPage.waitForURL(`http://localhost:${gamePort}/login`);
  await nextPage.evaluate(port=>{document.body.innerHTML=`<iframe src="http://127.0.0.1:${port}/login"></iframe>`},gamePort);
  await until(()=>nextPage.frames().find(f=>f.url().includes('127.0.0.1')),f=>!!f);
  const cross=await post('/api/game/login',{username:'test-user',password:'test-pass'});assert.equal(cross.ok,false);
  const frame=nextPage.frames().find(f=>f.url().includes('127.0.0.1'));
  assert.equal(await frame.locator('input[type=password]').inputValue(),'');
 });
});
