'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createAuth} = require('../lib/auth');
const {createStore} = require('../lib/store');
const {engagementState} = require('../lib/execution');
const {createMonitor} = require('../server');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-hardening-'));

test('corrupt or missing configured account database locks access; password change revokes session', () => {
  const dir = temp();
  try {
    const auth = createAuth(dir);
    auth.addUser('admin', 'admin', 'password-123');
    const old = auth.login('admin', 'password-123').token;
    auth.addUser('admin', 'admin', 'replacement-123');
    assert.equal(auth.who(old), null);
    const file = path.join(dir, 'users.json');
    fs.writeFileSync(file, '{bad');
    assert.throws(() => auth.enabled(), /database unavailable/);
    fs.unlinkSync(file);
    assert.throws(() => auth.enabled(), /database unavailable/);
    assert.throws(() => createAuth(dir).enabled(), /database unavailable/);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('interrupted round log keeps the next append and reads a bounded tail', () => {
  const dir = temp();
  try {
    const store = createStore(dir, 2), origin = 'https://example.test';
    fs.mkdirSync(path.join(dir, 'rounds'));
    fs.writeFileSync(store.logFile(origin), '{"v":1.2,"t":1}\n{"v":');
    store.append(origin, [2.5], 2, false);
    assert.deepEqual(store.load(origin).values, [2.5]);
    store.append(origin, [3,4,5], 3, false);
    assert.deepEqual(store.load(origin).values, [4,5]);
    fs.rmSync(store.logFile(origin));
    fs.mkdirSync(store.logFile(origin));
    assert.throws(() => store.append(origin, [2], 4, false));
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('autopilot waits for occupied/disabled controls and rejects active settings mismatch', () => {
  const leg = {slot:0, stake:10, target:2};
  const slot = {button:'bet', buttonDisabled:false, autoPlayDisabled:false, autoPlay:false, bet:10, target:2, autoCashOut:true};
  assert.deepEqual(engagementState([slot], [leg]), {ok:true});
  for (const button of ['cancel','cashout',null]) assert.equal(engagementState([{...slot,button}], [leg]).deferred, true);
  assert.equal(engagementState([{...slot,buttonDisabled:true}], [leg]).deferred, true);
  assert.equal(engagementState([{...slot,autoPlay:true,target:3}], [leg]).ok, false);
  assert.equal(engagementState([{...slot,autoPlay:true,autoCashOut:false}], [leg]).ok, false);
});

test('invalid JSON bodies return 400 without killing the server; corrupt accounts return 503', async () => {
  const dir = temp(), m = createMonitor({port:0,dataDir:dir});
  try {
    const base = `http://localhost:${await m.listen()}`;
    for (const body of ['null','[]','false','{bad']) {
      const response = await fetch(base+'/api/settings',{method:'POST',body});
      assert.equal(response.status,400,body);
      await response.text();
    }
    const large = await fetch(base+'/api/settings',{method:'POST',body:JSON.stringify({text:'x'.repeat(11000)})});
    assert.equal(large.status,413); await large.text();
    assert.equal((await fetch(base+'/api/state')).status,200);
    const auth=createAuth(dir);auth.addUser('admin','admin','password-123');
    fs.writeFileSync(path.join(dir,'users.json'),'{bad');
    assert.equal((await fetch(base+'/api/state')).status,503);
  } finally { await m.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('logout immediately closes an authenticated event stream', async () => {
  const dir=temp(),auth=createAuth(dir);auth.addUser('viewer','viewer','password-123');
  const m=createMonitor({port:0,dataDir:dir});
  try {
    const base=`http://localhost:${await m.listen()}`;
    const login=await fetch(base+'/api/login',{method:'POST',body:JSON.stringify({name:'viewer',password:'password-123'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];await login.text();
    const stream=await fetch(base+'/events',{headers:{Cookie:cookie}});
    const reader=stream.body.getReader();await reader.read();
    const closed=reader.read().then(r=>r.done,()=>true);
    const logout=await fetch(base+'/api/logout',{method:'POST',headers:{Cookie:cookie}});await logout.text();
    assert.equal(await Promise.race([closed,new Promise(r=>setTimeout(()=>r(false),2500))]),true);
  } finally { await m.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});


test('replay applies elapsed capture time and refuses to bridge missing rounds', () => {
  const {replayDay}=require('../lib/pilot');
  const cfg={plan:'single',target:2,lossLimit:100,profitTarget:100,maxRounds:50,maxMinutes:1,lossStreak:50};
  assert.deepEqual(replayDay([2,2,2],cfg,1,0,{times:[1000,62000,63000]}),{net:1,rounds:1,kind:'minutes'});
  assert.equal(replayDay([2,2,2],cfg,1,0,{gaps:[1]}),null);
});


test('failed settings persistence visibly locks betting instead of silently continuing', async () => {
  const dir=temp(),m=createMonitor({port:0,dataDir:dir});
  try {
    const base=`http://localhost:${await m.listen()}`;
    fs.mkdirSync(path.join(dir,'settings.json'));
    const response=await fetch(base+'/api/settings',{method:'POST',body:JSON.stringify({pauseRounds:1})});
    await response.text();
    const state=m.state();
    assert.match(state.persistenceError,/Saving data failed/);
    assert.equal(state.session.stopped,true);
  } finally {await m.close();fs.rmSync(dir,{recursive:true,force:true});}
});
