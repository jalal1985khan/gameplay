// End to end: a fake game site whose results list sits in an iframe from another origin, the
// monitor capturing it in headless Chrome, and the monitor page's event stream.
const {test, after, before} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createMonitor} = require('../server.js');

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ok, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (ok(v) || Date.now() > end) return v; await wait(150); }
}

// The game frame: a results list (newest first) that gains a round every 400 ms, like the game.
// The bet panel copies the class names of Broplay's Aviator (pokgaming).
const PANEL = `<div class="userBalance"><span class="userBalanceText">balance :</span> <span class="userBalanceMoney">₹1,000.00</span></div>
  <div class="betSectionBlock"><input class="betSectionInput" value="2"><button class="betButton start"><span class="betTitle">bet</span></button>
  <div class="autoPlayContainer"><button class="autoPlayButton auto"><span class="autoPlayButtonLabel">auto play</span></button>
  <div class="autoCashOut"><div class="forAvi switcher" style="width:30px;height:16px"></div><input class="autoPlayTagInput" value="2" disabled></div></div></div>`;
const GAME = `<!doctype html><body>${PANEL}<div id="flying">1.37x</div><div id="list"></div><script>
  const list = document.getElementById('list');
  const add = v => { const d = document.createElement('div'); d.textContent = v.toFixed(2) + 'x'; list.prepend(d); while (list.children.length > 20) list.lastChild.remove(); };
  [1.20, 3.45, 1.00, 12.30, 2.05, 1.71].forEach(add);
  let i = 0; const next = [4.44, 1.08, 2.50, 1.99, 7.77];
  setInterval(() => { if (i < next.length) add(next[i++]); }, 400);
  // Like the game: the Auto Cash Out switch frees its target box, and bets are limited to 20,000.
  document.querySelector('.switcher').addEventListener('click', () => { const t = document.querySelector('.autoPlayTagInput'); t.disabled = !t.disabled; });
  document.querySelector('.betSectionInput').addEventListener('blur', e => { if (Number(e.target.value) > 20000) e.target.value = '20000'; });
</script></body>`;

const ODDS_PAGE = port => `<!doctype html><body><div id="odds"></div><script>
  const odds = document.getElementById('odds');
  const fill = d => { odds.innerHTML = [3.30, 3.45, 2.88, 2.90, 2.76, 2.84, 2.10, 1.95, 4.20].map(v => '<div>' + (v + d).toFixed(2) + '</div>').join(''); };
  fill(0); setTimeout(() => fill(0.02), 600);
  setTimeout(() => { const f = document.createElement('iframe'); f.src = 'http://127.0.0.1:${port}/game'; f.width = 600; f.height = 300; document.body.append(f); }, 2500);
</script></body>`;

let game, gamePort, monitor, base, dir;
before(async () => {
  game = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html'});
    // The outer page (on localhost) embeds the game from 127.0.0.1: a different origin.
    // /late: a betting page with a plain-number odds list (more entries than the game shows)
    // that changes, and the Aviator frame added only after a few seconds.
    if (req.url.startsWith('/late')) return res.end(ODDS_PAGE(gamePort));
    if (req.url.startsWith('/site')) return res.end(`<!doctype html><input type="email" placeholder="newsletter"><button id="open" onclick="document.getElementById('f').hidden=false">Login</button>
      <form id="f" hidden onsubmit="event.preventDefault();window.sent={u:this.username.value,p:this.password.value};if(this.password.value==='right-pass')this.remove()">
      <input name="username" type="text"><input name="password" type="password"><button>Login</button></form>`);
    res.end(req.url.startsWith('/game') ? GAME : `<!doctype html><h1>Casino</h1><iframe src="http://127.0.0.1:${gamePort}/game" width="600" height="300"></iframe>`);
  });
  gamePort = await listen(game);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-test-'));
  monitor = createMonitor({port: 0, headless: true, dataDir: path.join(dir, 'data'), profileDir: path.join(dir, 'profile')});
  base = `http://localhost:${await monitor.listen()}`;
});
after(async () => {
  await monitor.close();
  game.close();
  fs.rmSync(dir, {recursive: true, force: true});
});

const setTimeoutP = ms => new Promise(r => setTimeout(r, ms));
const post = (p, body, headers = {}) => fetch(base + p, {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body || {})});
const state = () => fetch(base + '/api/state').then(r => r.json());

test('rejects addresses that are not http(s)', async () => {
  const r = await post('/api/start', {url: 'file:///etc/passwd'});
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /https:\/\//);
});

test('other websites cannot drive the monitor', async () => {
  assert.equal((await post('/api/start', {url: 'https://x.example'}, {Origin: 'https://evil.example'})).status, 403);
  // A page on another domain pointed at 127.0.0.1 (DNS rebinding) sends its own Host name.
  const status = await new Promise(r => http.get({host: '127.0.0.1', port: new URL(base).port, path: '/api/state', headers: {Host: 'evil.example'}}, res => { res.resume(); r(res.statusCode); }));
  assert.equal(status, 403);
});

test('captures rounds from a cross-origin game iframe, in order, live', async () => {
  const events = [];
  const ac = new AbortController();
  fetch(base + '/events', {signal: ac.signal}).then(async r => {
    const reader = r.body.getReader(), dec = new TextDecoder();
    for (;;) { const {value, done} = await reader.read(); if (done) break; events.push(dec.decode(value)); }
  }).catch(() => {});

  const r = await post('/api/start', {url: `http://localhost:${gamePort}/`});
  assert.deepEqual(await r.json(), {ok: true});
  const s = await until(state, s => s.count >= 11);
  ac.abort();
  assert.equal(s.capture.status, 'live');
  // Oldest first: the six already shown (added 1.20 first), then the five that arrived while watching.
  const values = s.recent.map(x => x.v).reverse();
  assert.deepEqual(values, [1.2, 3.45, 1, 12.3, 2.05, 1.71, 4.44, 1.08, 2.5, 1.99, 7.77]);
  assert.equal(s.breaks, 0);
  assert.equal(s.latest, 7.77);
  // The page's event stream carried the live updates.
  assert.ok(events.join('').includes('"latest":7.77'));
  // CSV export has every round.
  const csv = await (await fetch(base + '/export.csv')).text();
  assert.equal(csv.trim().split('\n').length, 12);
});

test('the game keeps seeing itself as visible and focused', async () => {
  const page = monitor._context().pages()[0];
  const gameFrame = page.frames().find(f => f.url().includes('/game'));
  const seen = await gameFrame.evaluate(() => {
    let heard = 0;
    document.addEventListener('visibilitychange', () => heard++);
    window.addEventListener('blur', () => heard++);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
    return {hidden: document.hidden, state: document.visibilityState, focus: document.hasFocus(), heard};
  });
  assert.deepEqual(seen, {hidden: false, state: 'visible', focus: true, heard: 0});
  // Another tab in front of the game: rounds still arrive.
  const other = await monitor._context().newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  const before = (await state()).count;
  await gameFrame.evaluate(() => { const d = document.createElement('div'); d.textContent = '9.99x'; document.getElementById('list').prepend(d); });
  const after = await until(state, s => s.count > before);
  assert.equal(after.latest, 9.99);
  await other.close();
  await page.bringToFront();
});

test('live view streams JPEG frames of the game window', async () => {
  const ac = new AbortController();
  const res = await fetch(base + '/preview', {signal: ac.signal});
  assert.match(res.headers.get('content-type'), /multipart\/x-mixed-replace/);
  const reader = res.body.getReader();
  let bytes = Buffer.alloc(0);
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    while (!bytes.includes(Buffer.from([0xff, 0xd8, 0xff]))) {
      const {value, done} = await reader.read();
      if (done) break;
      bytes = Buffer.concat([bytes, Buffer.from(value)]);
    }
  } catch {} finally { clearTimeout(timer); ac.abort(); }
  assert.ok(bytes.includes(Buffer.from('Content-Type: image/jpeg')), 'frame header');
  assert.ok(bytes.includes(Buffer.from([0xff, 0xd8, 0xff])), 'JPEG data');
});

test('tracks bets: win, loss, cooldown after a loss, stop-loss, new day', async () => {
  const gameFrame = monitor._context().pages()[0].frames().find(f => f.url().includes('/game'));
  const round = async v => {
    const before = (await state()).count;
    await gameFrame.evaluate(x => { const d = document.createElement('div'); d.textContent = x.toFixed(2) + 'x'; document.getElementById('list').prepend(d); }, v);
    return until(state, s => s.count > before);
  };
  const bet = (stake, target) => post('/api/bet', {stake, target}).then(r => r.json());
  assert.deepEqual(await (await post('/api/session', {budget: 1000})).json(), {ok: true});
  let ses = (await state()).session;
  assert.equal(ses.canBet, true);
  assert.equal(ses.stopLoss, 250);

  assert.deepEqual(await bet(10, 2), {ok: true});
  assert.match((await bet(10, 2)).error, /still waiting/);
  ses = (await round(2.5)).session;
  assert.equal(ses.recent[0].result, 'won');
  assert.equal(ses.net, 10);

  assert.deepEqual(await bet(10, 2), {ok: true});
  ses = (await round(1.2)).session;
  assert.equal(ses.recent[0].result, 'lost');
  assert.equal(ses.net, 0);
  // After a loss the button is hidden for 3 rounds.
  assert.equal(ses.canBet, false);
  assert.equal(ses.cooldownLeft, 3);
  assert.match((await bet(10, 2)).error, /wait 3 more rounds/);
  await round(1.5); await round(4.1);
  ses = (await round(1.0)).session;
  assert.equal(ses.cooldownLeft, 0);
  assert.equal(ses.canBet, true);

  // Undo a waiting bet.
  await bet(10, 2);
  await post('/api/bet/undo');
  assert.equal((await state()).session.pending, null);

  // A loss that reaches the stop-loss ends the day.
  assert.match((await bet(5000, 2)).error, /more than/);
  await bet(250, 2);
  ses = (await round(1.1)).session;
  assert.equal(ses.net, -250);
  assert.equal(ses.stopped, true);
  assert.equal(ses.canBet, false);
  assert.match((await bet(10, 2)).error, /Stop-loss/);

  await post('/api/session', {budget: 2000});
  ses = (await state()).session;
  assert.deepEqual([ses.budget, ses.net, ses.bets, ses.stopped, ses.canBet], [2000, 0, 0, false, true]);

  // Manual cash-out: after the round, the person says where they cashed out.
  const cash = at => post('/api/bet/cashout', {at}).then(r => r.json());
  assert.deepEqual(await post('/api/bet', {stake: 20, target: 2, mode: 'manual'}).then(r => r.json()), {ok: true});
  ses = (await round(2.5)).session;
  assert.equal(ses.awaiting.round, 2.5);
  assert.equal(ses.canBet, false);
  assert.match((await bet(10, 2)).error, /cashed out/);
  assert.match((await cash(3)).error, /crashed at 2.5×/);
  assert.deepEqual(await cash(1.8), {ok: true});
  ses = (await state()).session;
  assert.equal(ses.recent[0].result, 'won');
  assert.equal(ses.recent[0].cashedAt, 1.8);
  assert.equal(ses.net, 16);
  assert.equal(ses.canBet, true);
  // Didn't cash out: a loss, and the button waits 3 rounds from the losing round.
  await post('/api/bet', {stake: 20, target: 2, mode: 'manual'});
  await round(1.4);
  assert.deepEqual(await cash(null), {ok: true});
  ses = (await state()).session;
  assert.equal(ses.recent[0].result, 'lost');
  assert.equal(ses.net, -4);
  // Totals for the results panel: both manual bets of this new day, newest first.
  assert.deepEqual([ses.bets, ses.wins, ses.losses, ses.wagered], [2, 1, 1, 40]);
  assert.deepEqual(ses.all.map(b => b.result), ['lost', 'won']);
  assert.equal(ses.cooldownLeft, 3);
  assert.equal(ses.canBet, false);
});

test('settings change the pause after a loss and the stop-loss, straight away', async () => {
  const set = body => post('/api/settings', body).then(r => r.json());
  let s = await state();
  assert.deepEqual(s.settings, {pauseRounds: 3, stopLossShare: 0.25, alarmSound: true, remindMinutes: 60});
  assert.match((await set({remindMinutes: 45})).error, /reminder/);
  assert.equal(s.session.cooldownLeft, 3); // From the manual loss in the previous test.
  assert.deepEqual(await set({pauseRounds: 1}), {ok: true});
  s = await state();
  assert.equal(s.session.cooldownLeft, 1);
  await set({pauseRounds: 0});
  s = await state();
  assert.equal(s.session.cooldownLeft, 0);
  assert.equal(s.session.canBet, true);
  await set({stopLossShare: 0.5});
  assert.equal((await state()).session.stopLoss, 1000); // Half of the ₹2,000 budget.
  assert.match((await set({pauseRounds: 11})).error, /0 to 10/);
  assert.match((await set({pauseRounds: 1.5})).error, /0 to 10/);
  assert.match((await set({stopLossShare: 0.3})).error, /stop-loss/);
  // Saved for next time.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'settings.json'), 'utf8')), {pauseRounds: 0, stopLossShare: 0.5, alarmSound: true, remindMinutes: 60});
  await set({pauseRounds: 3, stopLossShare: 0.25});
});

test("game Auto Bet: every round is recorded, and the alarm goes off at the stop-loss until it's turned off", async () => {
  const gameFrame = monitor._context().pages()[0].frames().find(f => f.url().includes('/game'));
  const round = async v => {
    const before = (await state()).count;
    await gameFrame.evaluate(x => { const d = document.createElement('div'); d.textContent = x.toFixed(2) + 'x'; document.getElementById('list').prepend(d); }, v);
    return until(state, s => s.count > before);
  };
  const auto = body => post('/api/autobet', body).then(r => r.json());
  let ses = (await state()).session; // ₹2,000 day, net −₹4, stop-loss ₹500.
  assert.equal(ses.stopLoss, 500);
  assert.equal(ses.canAutoBet, true, 'the pause after a loss does not block tracking Auto Bet');
  assert.match((await auto({on: true, stake: 5000, target: 2})).error, /more than/);
  assert.deepEqual(await auto({on: true, stake: 200, target: 2}), {ok: true});
  ses = (await state()).session;
  assert.deepEqual(ses.autoBet && [ses.autoBet.stake, ses.autoBet.target], [200, 2]);
  assert.equal(ses.canBet, false);
  const bets = ses.all.length;
  for (const v of [2.5, 1.2, 1.0, 1.3]) ses = (await round(v)).session;
  assert.equal(ses.all.length, bets + 4);
  assert.deepEqual(ses.all.slice(0, 4).map(b => [b.mode, b.result, b.round]), [['autobet', 'lost', 1.3], ['autobet', 'lost', 1], ['autobet', 'lost', 1.2], ['autobet', 'won', 2.5]]);
  assert.equal(ses.net, -404);
  assert.equal(ses.alarm, false);
  ses = (await round(1.1)).session;
  assert.equal(ses.net, -604);
  assert.equal(ses.stopped, true);
  assert.equal(ses.alarm, true, 'stop-loss reached while Auto Bet is on');
  // The game is still betting: rounds keep being recorded while the alarm sounds.
  ses = (await round(1.05)).session;
  assert.equal(ses.net, -804);
  assert.equal(ses.alarm, true);
  assert.deepEqual(await auto({on: false}), {ok: true});
  ses = (await state()).session;
  assert.equal(ses.alarm, false);
  assert.equal(ses.autoBet, null);
  const n = ses.all.length;
  ses = (await round(3)).session;
  assert.equal(ses.all.length, n, 'nothing recorded after Auto Bet is turned off');
  assert.match((await auto({on: true, stake: 10, target: 2})).error, /Stop-loss/);
});

test("reads the game's real balance and bet panel: warnings, practice bets, real-balance stop-loss", async () => {
  const gameFrame = monitor._context().pages()[0].frames().find(f => f.url().includes('/game'));
  const inGame = fn => gameFrame.evaluate(fn);
  let ses = (await until(state, s => s.session.balance === 1000)).session;
  assert.deepEqual(ses.game.slots, [{bet: 2, target: 2, autoCashOut: false, autoPlay: false, button: 'start'}]);
  // The person switches Auto Cash Out on at 1.5× and Auto Play on, in the game.
  await inGame(() => { const t = document.querySelector('.autoPlayTagInput'); t.disabled = false; t.value = '1.5'; document.querySelector('.autoPlayButton').classList.add('active'); });
  ses = (await until(state, s => s.session.game.slots[0].autoPlay === true)).session;
  assert.deepEqual([ses.game.slots[0].autoCashOut, ses.game.slots[0].target, ses.game.gameAutoPlay], [true, 1.5, true]);
  // Tracking different values than the game uses is flagged.
  await post('/api/session', {budget: 1000});
  assert.equal((await state()).session.balanceStart, 1000);
  await post('/api/autobet', {on: true, stake: 10, target: 2});
  ses = (await state()).session;
  assert.ok(ses.warnings.some(w => /game's bet is ₹2/.test(w)), ses.warnings.join(' | '));
  assert.ok(ses.warnings.some(w => /Auto Cash Out is 1.5×/.test(w)));
  // A zero balance: the game can't bet, so recorded bets are practice.
  await inGame(() => { document.querySelector('.userBalanceMoney').textContent = '₹0.00'; });
  ses = (await until(state, s => s.session.balance === 0)).session;
  assert.ok(ses.warnings.some(w => /balance is ₹0.00/.test(w)));
  const before = (await state()).count;
  await inGame(() => { const d = document.createElement('div'); d.textContent = '1.20x'; document.getElementById('list').prepend(d); });
  ses = (await until(state, s => s.count > before)).session;
  assert.equal(ses.all[0].practice, true);
  await post('/api/autobet', {on: false});
  // Real money: the stop-loss also watches the game balance, whatever the records say.
  await inGame(() => { document.querySelector('.userBalanceMoney').textContent = '₹1,000.00'; });
  await until(state, s => s.session.balance === 1000);
  await post('/api/session', {budget: 1000}); // Day starts at a ₹1,000 balance; stop-loss ₹250.
  await inGame(() => { document.querySelector('.userBalanceMoney').textContent = '₹700.00'; });
  ses = (await until(state, s => s.session.balance === 700)).session;
  assert.equal(ses.realNet, -300);
  assert.equal(ses.realStopped, true);
  assert.equal(ses.stopped, true);
  assert.equal(ses.alarm, true, "the game's own Auto Play is on, so the alarm sounds");
  await inGame(() => { document.querySelector('.autoPlayButton').classList.remove('active'); });
  ses = (await until(state, s => s.session.game.gameAutoPlay === false)).session;
  assert.equal(ses.alarm, false);
});

test("follows the game's Auto Play: starts, uses the game's bet and target, skips bets the balance can't cover, stops", async () => {
  const gameFrame = monitor._context().pages()[0].frames().find(f => f.url().includes('/game'));
  const inGame = (fn, arg) => gameFrame.evaluate(fn, arg);
  const round = async v => {
    const before = (await state()).count;
    await inGame(x => { const d = document.createElement('div'); d.textContent = x.toFixed(2) + 'x'; document.getElementById('list').prepend(d); }, v);
    return until(state, s => s.count > before);
  };
  const balance = async v => {
    await inGame(x => { document.querySelector('.userBalanceMoney').textContent = '₹' + x.toFixed(2); }, v);
    return until(state, s => s.session.balance === v);
  };
  await post('/api/autobet', {on: false});
  await balance(1000);
  await post('/api/session', {budget: 1000});
  let ses = (await state()).session;
  assert.deepEqual([ses.follow, ses.autoBet, ses.canFollow], [false, null, true], 'Auto Play is off in the game: nothing is tracked');
  // Auto Play goes on in the game, with a ₹2 bet and Auto Cash Out at 1.5×.
  await inGame(() => { document.querySelector('.autoPlayButton').classList.add('active'); });
  ses = (await until(state, s => s.session.follow)).session;
  assert.deepEqual([ses.autoBet.stake, ses.autoBet.target], [2, 1.5]);
  assert.equal(ses.warnings.length, 0, ses.warnings.join(' | '));
  ses = (await round(1.6)).session;
  assert.deepEqual([ses.bets, ses.net, ses.all[0].follow, ses.all[0].practice], [1, 1, true, undefined]);
  // The bet is changed in the game: tracking uses the new amount.
  await inGame(() => { document.querySelector('.betSectionInput').value = '5'; });
  await balance(999); // Any change on the panel is read; the game took the next bet.
  ses = (await until(state, s => s.session.autoBet.stake === 5)).session;
  ses = (await round(1.2)).session;
  assert.deepEqual([ses.bets, ses.net, ses.all[0].stake, ses.all[0].result], [2, -4, 5, 'lost']);
  assert.equal(ses.realNet, -1);
  // The last bet empties the balance: it still counts, because the money was there before the round.
  await balance(5); await balance(0);
  ses = (await round(1.1)).session;
  assert.deepEqual([ses.bets, ses.net], [3, -9]);
  // Nothing left: the game cannot bet, so the next round is not counted.
  ses = (await round(3)).session;
  assert.equal(ses.bets, 3);
  // Auto Cash Out off: the bet is listed without a result.
  await balance(500);
  await inGame(() => { document.querySelector('.autoPlayTagInput').disabled = true; });
  ses = (await until(state, s => s.session.autoBet && s.session.autoBet.target === null || s.session.game.slots[0].autoCashOut === false)).session;
  await balance(508); // Cashed out by hand at 1.6× before the plane left: 500 + 5 × 1.6.
  ses = (await round(2)).session;
  assert.deepEqual([ses.bets, ses.all[0].manualExit, ses.all[0].result], [3, true, 'unknown']);
  assert.ok(ses.warnings.some(w => /Auto Cash Out is OFF/.test(w)));
  // The balance tells how a bet without a target ended, once the next round is in.
  await balance(503); // The game took the next ₹5 bet; nobody cashes this one out.
  ses = (await round(1.5)).session;
  assert.deepEqual([ses.all[1].result, ses.all[1].cashedAt, ses.all[1].profit], ['won', 1.6, 3]);
  await balance(498); // Next bet taken: the one before was lost.
  await balance(510.5); // This one is cashed out by hand at 2.5×.
  ses = (await round(3)).session;
  assert.deepEqual([ses.all[1].result, ses.all[1].profit, ses.all[0].result], ['lost', -5, 'unknown']);
  // Auto Play goes off in the game: tracking stops by itself.
  await inGame(() => { document.querySelector('.autoPlayButton').classList.remove('active'); document.querySelector('.autoPlayTagInput').disabled = false; });
  ses = (await until(state, s => !s.session.autoBet)).session;
  assert.deepEqual([ses.follow, ses.autoBet], [false, null]);
  const n = ses.all.length;
  ses = (await round(4)).session;
  assert.equal(ses.all.length, n);
  assert.deepEqual([ses.all[0].result, ses.all[0].cashedAt, ses.all[0].profit], ['won', 2.5, 7.5], 'the last bet by hand is decided after Auto Play went off');
  await balance(1000);
});

test("sets the bet and Auto Cash Out target in the game on request, and checks what the game shows", async () => {
  const gameFrame = monitor._context().pages()[0].frames().find(f => f.url().includes('/game'));
  const set = body => post('/api/game/set', body).then(r => r.json());
  const boxes = () => gameFrame.evaluate(() => [document.querySelector('.betSectionInput').value, document.querySelector('.autoPlayTagInput').value, document.querySelector('.autoPlayTagInput').disabled]);
  await post('/api/session', {budget: 1000});
  // Auto Cash Out is off in the game: it is switched on so the target can be set.
  await gameFrame.evaluate(() => { document.querySelector('.autoPlayTagInput').disabled = true; });
  const r = await set({slot: 0, bet: 10, target: 1.8});
  assert.deepEqual(r, {ok: true, slot: 0, shown: {bet: 10, target: 1.8, autoCashOut: true}});
  assert.deepEqual(await boxes(), ['10', '1.8', false]);
  const slot = (await until(state, x => x.session.game.slots[0].bet === 10)).session.game.slots[0];
  assert.deepEqual([slot.bet, slot.target, slot.autoCashOut, slot.autoPlay], [10, 1.8, true, false], 'the bet is prepared, not placed');
  // Only one of the two.
  assert.equal((await set({slot: 0, target: 2.5})).shown.target, 2.5);
  assert.deepEqual(await boxes(), ['10', '2.5', false]);
  // Refused: nothing to set, no such slot, more than today's money.
  assert.match((await set({slot: 0})).error, /Enter a bet/);
  assert.match((await set({slot: 3, bet: 5})).error, /not on screen/);
  assert.match((await set({slot: 0, bet: 5000})).error, /more than the ₹1000/);
  assert.deepEqual(await boxes(), ['10', '2.5', false]);
  // The game limits the amount: the monitor reports what the game shows instead of assuming.
  await post('/api/session', {budget: 100000});
  const limited = await set({slot: 0, bet: 50000});
  assert.equal(limited.ok, false);
  assert.match(limited.error, /game shows a bet of ₹20000, not ₹50000/);
  await post('/api/session', {budget: 1000});
  // Never while the game is betting by itself.
  await gameFrame.evaluate(() => { document.querySelector('.autoPlayButton').classList.add('active'); });
  await until(state, x => x.session.follow);
  assert.match((await set({slot: 0, bet: 3})).error, /Auto Play is on/);
  await gameFrame.evaluate(() => { document.querySelector('.autoPlayButton').classList.remove('active'); });
  await until(state, x => !x.session.autoBet);
  // Other websites cannot use it.
  assert.equal((await post('/api/game/set', {slot: 0, bet: 3}, {Origin: 'https://evil.example'})).status, 403);
  assert.equal((await boxes())[0], '20000');
});

test('stop closes the game window; history is kept and saved', async () => {
  await post('/api/stop');
  const s = await state();
  assert.equal(s.capture.status, 'stopped');
  assert.equal(s.count, 36);
  assert.equal(s.session.canBet, false, 'no bets while not capturing');
  // Every round is already in the site's log: one line each, written as it was captured.
  const log = fs.readFileSync(path.join(dir, 'data', 'rounds', `localhost_${gamePort}.ndjson`), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(log.length, 36);
  assert.deepEqual(log.slice(0, 3).map(r => r.v), [1.2, 3.45, 1]);
});

test('analysis of the captured rounds: odds table, bands, checks and a replayed bet', async () => {
  const a = await (await fetch(base + '/api/analysis?target=2&stake=10&size=11')).json();
  const values = (await state()).recent.slice(0, 11).map(r => r.v).reverse();
  assert.equal(a.ok, true);
  assert.equal(a.rounds, 11);
  assert.equal(a.total, 36);
  const hits = values.filter(v => v >= 2).length;
  assert.equal(a.base.hits, hits);
  assert.equal(a.ladder.find(r => r.target === 2).hits, hits);
  assert.equal(a.distribution.bands.reduce((n, b) => n + b.count, 0), 11);
  assert.ok(Math.abs(a.distribution.bands.reduce((n, b) => n + b.expected, 0) - 1) < 1e-9, "the game's odds add up to 100%");
  assert.equal(a.checks.odds.verdict, 'too-few', '11 rounds are not enough to judge');
  // The same ₹10 bet at 2× on each of those rounds, worked out by hand.
  assert.equal(a.backtest.bets, 11);
  assert.equal(a.backtest.net, hits * 10 - (11 - hits) * 10);
  assert.equal(a.backtest.expectedNet, -3.3);
  assert.equal(a.backtest.points.at(-1).net, a.backtest.net);
  // Bad input falls back to safe values instead of failing.
  const b = await (await fetch(base + '/api/analysis?target=abc&size=-4&stake=0')).json();
  assert.deepEqual([b.target, b.size, b.backtest.stake, b.rounds], [2, 0, 10, 36]);
  // The page and its chart script are served.
  assert.match(await (await fetch(base + '/analysis.js')).text(), /AnalysisUI/);
});

test('finished days are kept; each game site keeps its own rounds', async () => {
  const days = (await (await fetch(base + '/api/days')).json()).days;
  assert.ok(days.length >= 2, 'the days ended by "new day" in earlier tests');
  const day = days.find(d => d.bets > 0 && d.losses > 0);
  assert.ok(day && day.wagered > 0 && day.maxDrawdown > 0 && day.longestLosses >= 1, JSON.stringify(days));
  assert.equal(day.site, `http://localhost:${gamePort}`);
  // Another site starts empty, and coming back shows the first site's rounds again.
  await post('/api/start', {url: `http://127.0.0.1:${gamePort}/game`});
  const other = await until(state, s => s.count >= 11);
  assert.equal(other.site, `http://127.0.0.1:${gamePort}`);
  assert.equal(other.count, 11);
  await post('/api/stop');
  await post('/api/start', {url: `http://localhost:${gamePort}/`});
  const back = await state();
  assert.ok(back.count >= 34, 'the first site still has its rounds');
  assert.equal(back.site, `http://localhost:${gamePort}`);
  await post('/api/stop');
});

test('a monitor started again reads its rounds back from the log; a live game that goes quiet is flagged', async () => {
  const again = createMonitor({port: 0, headless: true, dataDir: path.join(dir, 'data'), profileDir: path.join(dir, 'profile2'), staleMs: 1500});
  const url = `http://localhost:${await again.listen()}`;
  try {
    const get = () => fetch(url + '/api/state').then(r => r.json());
    const s = await get();
    assert.equal(s.count, (await state()).count);
    assert.ok(s.count >= 34);
    assert.equal(s.site, `http://localhost:${gamePort}`);
    // The fake game stops adding rounds after five: soon nothing changes on its page.
    await fetch(url + '/api/start', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url: `http://localhost:${gamePort}/`})});
    const live = await until(get, x => x.capture.status === 'live' && x.capture.stale === false);
    assert.equal(live.capture.stale, false);
    const quiet = await until(get, x => x.capture.stale === true);
    assert.equal(quiet.capture.stale, true);
  } finally { await again.close(); }
});

test('clear empties the history, and keeps the rounds aside in a dated file', async () => {
  await post('/api/clear');
  assert.equal((await state()).count, 0);
  const files = fs.readdirSync(path.join(dir, 'data', 'rounds'));
  assert.ok(files.some(f => /\.cleared-.*\.ndjson$/.test(f)), files.join(', '));
});

test('never records betting odds; records the x-marked Aviator list once it appears', async () => {
  await post('/api/start', {url: `http://localhost:${gamePort}/late`});
  // First only the odds list exists: it is noticed but nothing is stored.
  const early = await until(state, s => s.capture.sawPlain);
  assert.equal(early.capture.sawPlain, true);
  assert.equal(early.count, 0);
  assert.equal(early.capture.status, 'waiting');
  // Once the game frame loads, only its rounds are stored.
  const s = await until(state, s => s.count >= 11);
  assert.equal(s.capture.source, `127.0.0.1:${gamePort}`);
  assert.deepEqual(s.recent.map(x => x.v).reverse(), [1.2, 3.45, 1, 12.3, 2.05, 1.71, 4.44, 1.08, 2.5, 1.99, 7.77]);
  assert.equal(s.breaks, 0);
  // Clear while the game's Auto Bet is tracked: the rounds still on the game's list are stored
  // again, but only the round that finishes afterwards counts as a bet.
  await post('/api/session', {budget: 1000});
  await post('/api/autobet', {on: true, stake: 10, target: 2});
  await post('/api/clear');
  assert.equal((await state()).count, 0);
  const frame = monitor._context().pages().flatMap(p => p.frames()).find(f => f.url().includes('/game'));
  await frame.evaluate(() => { const d = document.createElement('div'); d.textContent = '1.50x'; document.getElementById('list').prepend(d); });
  const cleared = await until(state, x => x.count >= 12);
  assert.equal(cleared.count, 12);
  assert.equal(cleared.session.bets, 1, 'one live round, one bet');
  assert.deepEqual([cleared.session.all[0].round, cleared.session.all[0].result, cleared.session.net], [1.5, 'lost', -10]);
  await post('/api/autobet', {on: false});
  // Diagnostics list each frame and the lists it found.
  const d = await (await fetch(base + '/api/diagnose')).json();
  assert.equal(d.ok, true);
  const gameFrame = d.frames.find(f => f.url.includes('/game'));
  assert.ok(gameFrame.candidates.some(c => c.marked && c.sample.includes('7.77x')));
  const top = d.frames.find(f => f.url.includes('/late'));
  assert.ok(top.candidates.some(c => !c.marked));
  await post('/api/stop');
});

const wireButtons = gameFrame => gameFrame.evaluate(() => {
  const betBtn = document.querySelector('.betButton');
  const playBtn = document.querySelector('.autoPlayButton');
  betBtn.addEventListener('click', () => {
    if (betBtn.classList.contains('start')) {
      betBtn.className = 'betButton cancel';
      betBtn.textContent = 'cancel';
    } else {
      betBtn.className = 'betButton start';
      betBtn.textContent = 'bet';
    }
  });
  playBtn.addEventListener('click', () => {
    // Like the real game when window.withOptions is set: switching on first shows an options box.
    if (window.withOptions && !playBtn.classList.contains('active')) {
      if (document.getElementById('opts')) return;
      const box = document.createElement('div');
      box.id = 'opts';
      box.innerHTML = '<div><span>Auto Play Options</span></div><div><button>10</button><button>40</button></div><div><button><span>reset</span></button><button id="go"><span>start</span></button></div>';
      document.body.append(box);
      box.querySelectorAll('button').forEach(b => { b.onclick = () => {
        if (b.id === 'go') { playBtn.classList.add('active'); playBtn.textContent = 'stop'; box.remove(); }
        else if (b.textContent !== 'reset') window.picked = b.textContent;
      }; });
      return;
    }
    const on = playBtn.classList.toggle('active');
    playBtn.textContent = on ? 'stop' : 'auto play';
  });
});

test('clicks .betButton and .autoPlayButton via /api/game/click with safety checks', async () => {
  await post('/api/start', {url: `http://localhost:${gamePort}/`});
  await until(state, s => s.capture.status === 'live' && s.latest === 7.77 && s.session.game && s.session.game.slots.length > 0);
  const gameFrame = monitor._context().pages()[0].frames().find(f => f.url().includes('/game'));
  await wireButtons(gameFrame);

  const click = body => post('/api/game/click', body).then(r => r.json());
  const set = body => post('/api/game/set', body).then(r => r.json());
  const round = async v => {
    const before = (await state()).count;
    await gameFrame.evaluate(x => { const d = document.createElement('div'); d.textContent = x.toFixed(2) + 'x'; document.getElementById('list').prepend(d); }, v);
    return until(state, s => s.count > before);
  };

  await post('/api/session', {budget: 1000});
  await set({slot: 0, bet: 10, target: 1.8});

  // Validation and guardrails.
  assert.match((await click({slot: 0, action: 'jump'})).error, /Choose an action/);
  assert.match((await click({slot: 3, action: 'bet'})).error, /not on screen/);
  await gameFrame.evaluate(() => { document.querySelector('.betSectionInput').value = '5000'; });
  assert.match((await click({slot: 0, action: 'bet'})).error, /more than the ₹1000/);
  await gameFrame.evaluate(() => { document.querySelector('.betSectionInput').value = '10'; });

  // Place bet -> cancel waiting bet -> cash out an in-flight bet.
  const placed = await click({slot: 0, action: 'bet'});
  assert.equal(placed.ok, true);
  assert.equal(placed.changed, true);
  assert.equal(placed.shown.button, 'cancel');
  assert.match((await click({slot: 0, action: 'bet'})).error, /already placed/);
  assert.match((await click({slot: 0, action: 'cashout'})).error, /no active bet to cash out/);

  const cancelled = await click({slot: 0, action: 'cancel'});
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.shown.button, 'bet');
  assert.match((await click({slot: 0, action: 'cancel'})).error, /no waiting bet to cancel/);

  await gameFrame.evaluate(() => {
    const b = document.querySelector('.betButton');
    b.className = 'betButton cashout';
    b.textContent = 'cash out';
  });
  const cashed = await click({slot: 0, action: 'cashout'});
  assert.equal(cashed.ok, true);
  assert.equal(cashed.shown.button, 'bet');

  // Toggle Auto Play ON, idempotent ON, refusal on Bet while Auto Play is ON, then toggle OFF.
  const autoOn = await click({slot: 0, action: 'autoplay', on: true});
  assert.equal(autoOn.ok, true);
  assert.equal(autoOn.changed, true);
  assert.equal(autoOn.shown.autoPlay, true);
  const autoAgain = await click({slot: 0, action: 'autoplay', on: true});
  assert.equal(autoAgain.ok, true);
  assert.equal(autoAgain.changed, false);
  assert.match((await click({slot: 0, action: 'bet'})).error, /Auto Play is on/);
  const autoOff = await click({slot: 0, action: 'autoplay'});
  assert.equal(autoOff.ok, true);
  assert.equal(autoOff.shown.autoPlay, false);

  // A game that answers Auto Play with an options box: the rounds are picked and Start is pressed.
  await gameFrame.evaluate(() => { window.withOptions = true; });
  assert.match((await click({slot: 0, action: 'autoplay', on: true, rounds: 77})).error, /does not offer 77 rounds/);
  const viaBox = await click({slot: 0, action: 'autoplay', on: true, rounds: 40}); // The box is still open.
  assert.equal(viaBox.ok, true, viaBox.error);
  assert.equal(viaBox.shown.autoPlay, true);
  assert.equal(await gameFrame.evaluate(() => window.picked), '40');
  assert.equal((await click({slot: 0, action: 'autoplay', on: false})).shown.autoPlay, false);
  const fresh = await click({slot: 0, action: 'autoplay', on: true}); // Box closed: opened, then Start.
  assert.equal(fresh.ok, true, fresh.error);
  assert.equal((await click({slot: 0, action: 'autoplay', on: false})).shown.autoPlay, false);
  await gameFrame.evaluate(() => { window.withOptions = false; });

  // Cooldown after a loss blocks Bet, and stop-loss blocks Bet + Auto Play ON while still allowing Cancel/Cash Out/Auto Play OFF.
  await post('/api/bet', {stake: 10, target: 2});
  await round(1.2);
  assert.match((await click({slot: 0, action: 'bet'})).error, /wait 3 more rounds/);

  await post('/api/session', {budget: 100});
  await post('/api/bet', {stake: 25, target: 2});
  await round(1.1);
  assert.equal((await state()).session.stopped, true);
  assert.match((await click({slot: 0, action: 'bet'})).error, /Stop-loss/);
  assert.match((await click({slot: 0, action: 'autoplay', on: true})).error, /Stop-loss/);
  await gameFrame.evaluate(() => {
    const b = document.querySelector('.betButton');
    b.className = 'betButton cancel';
    b.textContent = 'cancel';
  });
  assert.equal((await click({slot: 0, action: 'cancel'})).ok, true);

  // CSRF check.
  assert.equal((await post('/api/game/click', {slot: 0, action: 'bet'}, {Origin: 'https://evil.example'})).status, 403);
  assert.equal((await post('/api/game/cutoff', {}, {Origin: 'https://evil.example'})).status, 403);
  await post('/api/stop');
});

test('autoCutOff stops Auto Play and cancels waiting bets automatically on stop-loss and via /api/game/cutoff', async () => {
  await post('/api/start', {url: `http://localhost:${gamePort}/`});
  await until(state, s => s.capture.status === 'live' && s.latest === 7.77 && s.session.game && s.session.game.slots.length > 0);
  const gameFrame = monitor._context().pages()[0].frames().find(f => f.url().includes('/game'));
  await wireButtons(gameFrame);

  const click = body => post('/api/game/click', body).then(r => r.json());
  const set = body => post('/api/game/set', body).then(r => r.json());
  const cutoff = body => post('/api/game/cutoff', body).then(r => r.json());
  const round = async v => {
    const before = (await state()).count;
    await gameFrame.evaluate(x => { const d = document.createElement('div'); d.textContent = x.toFixed(2) + 'x'; document.getElementById('list').prepend(d); }, v);
    return until(state, s => s.count > before);
  };

  await post('/api/session', {budget: 1000});
  assert.deepEqual(await cutoff({}), {ok: true, triggered: false, stopped: false, enabled: true, actions: []});

  // 1. Automatic stop-loss cut-off triggered by real balance drop.
  await set({slot: 0, bet: 10, target: 2});
  await click({slot: 0, action: 'autoplay', on: true});
  await gameFrame.evaluate(() => {
    const b = document.querySelector('.betButton');
    b.className = 'betButton cancel';
    b.textContent = 'cancel';
  });
  await until(state, s => s.session.follow);

  await gameFrame.evaluate(() => { document.querySelector('.userBalanceMoney').textContent = '₹700.00'; });
  const afterDrop = (await until(state, s => s.session.stopped && !s.session.game.gameAutoPlay && s.session.game.slots[0].button === 'start')).session;
  assert.equal(afterDrop.follow, false);
  assert.equal(afterDrop.alarm, false);
  assert.equal(afterDrop.autoCutOff.last.ok, true);
  assert.equal(afterDrop.autoCutOff.last.triggered, true);
  assert.deepEqual(afterDrop.autoCutOff.last.actions.map(a => a.action), ['autoplay', 'cancel']);

  // 2. Disable autoCutOff, hit stop-loss via losing round while Auto Play follows, then re-enable to trigger immediately.
  await gameFrame.evaluate(() => { document.querySelector('.userBalanceMoney').textContent = '₹1,000.00'; });
  await until(state, s => s.session.balance === 1000);
  await post('/api/session', {budget: 100});
  assert.equal((await cutoff({enabled: false})).enabled, false);
  await set({slot: 0, bet: 25, target: 2});
  await click({slot: 0, action: 'autoplay', on: true});
  await gameFrame.evaluate(() => {
    const b = document.querySelector('.betButton');
    b.className = 'betButton cancel';
    b.textContent = 'cancel';
  });
  await until(state, s => s.session.follow);
  const stoppedWhileDisabled = (await round(1.1)).session;
  assert.equal(stoppedWhileDisabled.stopped, true);
  assert.equal(stoppedWhileDisabled.game.gameAutoPlay, true, 'auto cut-off was disabled so Auto Play stayed ON');

  const reenabled = await cutoff({enabled: true});
  assert.equal(reenabled.ok, true);
  assert.equal(reenabled.enabled, true);
  assert.equal(reenabled.triggered, true);
  assert.deepEqual(reenabled.actions.map(a => a.action), ['autoplay', 'cancel']);
  const afterReenable = (await state()).session;
  assert.equal(afterReenable.game.gameAutoPlay, false);
  assert.equal(afterReenable.game.slots[0].button, 'start');

  // 3. Forced cut-off works even before stop-loss is reached.
  await post('/api/session', {budget: 1000});
  await click({slot: 0, action: 'autoplay', on: true});
  await gameFrame.evaluate(() => {
    const b = document.querySelector('.betButton');
    b.className = 'betButton cancel';
    b.textContent = 'cancel';
  });
  const forced = await cutoff({force: true});
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.equal(forced.stopped, false);
  assert.equal(forced.triggered, true);
  assert.deepEqual(forced.actions.map(a => a.action), ['autoplay', 'cancel']);
  assert.equal(forced.slots[0].autoPlay, false);
  assert.equal(forced.slots[0].button, 'bet');
  await post('/api/stop');
});

test('autopilot: starts the game\'s Auto Play with the set bet, pauses after losses in a row, stops for the day at the loss limit', async () => {
  await post('/api/start', {url: `http://localhost:${gamePort}/`});
  await until(state, s => s.capture.status === 'live' && s.latest === 7.77 && s.session.game && s.session.game.slots.length > 0);
  const gameFrame = monitor._context().pages()[0].frames().find(f => f.url().includes('/game'));
  await wireButtons(gameFrame);
  const pilot = body => post('/api/autopilot', body).then(r => r.json());
  const setup = body => post('/api/autopilot/settings', body).then(r => r.json());
  const round = async v => {
    const before = (await state()).count;
    await gameFrame.evaluate(x => { const d = document.createElement('div'); d.textContent = x.toFixed(2) + 'x'; document.getElementById('list').prepend(d); }, v);
    return until(state, s => s.count > before);
  };
  const balance = async v => {
    await gameFrame.evaluate(x => { document.querySelector('.userBalanceMoney').textContent = '₹' + x.toFixed(2); }, v);
    return until(state, s => s.session.balance === v);
  };
  const playing = () => gameFrame.evaluate(() => document.querySelector('.autoPlayButton').classList.contains('active'));
  await gameFrame.evaluate(() => { document.querySelector('.autoPlayButton').classList.remove('active'); document.querySelector('.betButton').className = 'betButton start'; document.querySelector('.betButton').textContent = 'bet'; });
  await balance(1000);
  await post('/api/session', {budget: 10000});

  // The six values, checked as they are saved.
  assert.match((await setup({betMode: 'percent', betValue: 50})).error, /more than 10%/);
  assert.match((await setup({maxRounds: 2.5})).error, /whole number/);
  const saved = await setup({lossLimit: 40, profitTarget: 500, betMode: 'fixed', betValue: 10, target: 2, maxRounds: 50, maxMinutes: 60, lossStreak: 2, lossAction: 'pause', pauseRounds: 1});
  assert.equal(saved.ok, true, saved.error);

  // On: the bet and target go into the game and its Auto Play starts.
  const on = await pilot({on: true});
  assert.equal(on.ok, true, on.error);
  assert.equal(await playing(), true);
  assert.deepEqual(await gameFrame.evaluate(() => [document.querySelector('.betSectionInput').value, document.querySelector('.autoPlayTagInput').value]), ['10', '2']);
  assert.match((await setup({lossLimit: 50})).error, /Stop the autopilot/);

  // Two losses in a row: it pauses (Auto Play off), then starts again one round later.
  await balance(990);
  await round(1.5);
  await until(state, s => s.autopilot.day.net === -10);
  await balance(980);
  await round(1.2);
  let st = await until(state, s => s.autopilot.phase === 'paused');
  assert.equal(st.autopilot.day.net, -20);
  await until(playing, v => v === false);
  await round(3); // Sat out.
  st = await until(state, s => s.autopilot.phase === 'running');
  await until(playing, v => v === true);
  assert.equal(st.autopilot.day.rounds, 2, 'the round it sat out is not counted');

  // A win, then losses down to the limit: stopped for the day, Auto Play off, no restart.
  await balance(970);
  await balance(990);
  await round(2.5);
  await until(state, s => s.autopilot.day.net === -10);
  await setTimeoutP(50);
  await balance(980);
  await round(1.1);
  await until(state, s => s.autopilot.day.net === -20);
  // A second loss in a row pauses again at −30; after the pause one more loss reaches the limit.
  await balance(970);
  await round(1.3);
  st = await until(state, s => s.autopilot.phase === 'paused');
  assert.equal(st.autopilot.day.net, -30);
  await until(playing, v => v === false);
  await round(4);
  await until(state, s => s.autopilot.phase === 'running');
  await until(playing, v => v === true);
  await balance(960);
  await round(1.05);
  st = await until(state, s => !s.autopilot.on);
  assert.equal(st.autopilot.day.net, -40);
  assert.match(st.autopilot.day.stopped, /loss limit of ₹40/);
  await until(playing, v => v === false);
  assert.match((await pilot({on: true})).error, /done for today/);
  // Ended by the loss limit: raising the limits does not open the day again.
  assert.equal((await setup({lossLimit: 1000, maxRounds: 500})).reopened, false);
  assert.match((await pilot({on: true})).error, /start again tomorrow/);
  // Start a new day: counts and limits from zero, and the autopilot can start again.
  assert.equal((await post('/api/autopilot/newday').then(r => r.json())).ok, true);
  st = await state();
  assert.deepEqual([st.autopilot.day.net, st.autopilot.day.rounds, st.autopilot.day.stopped, st.session.bets], [0, 0, '', 0]);
  await setup({lossLimit: 40, maxRounds: 50});
  assert.ok(st.autopilot.log.some(l => /Stopped for today/.test(l.text)));
  await balance(1000);
});

test('autopilot, win back losses: the bet grows after a loss up to its cap and returns to normal after a win', async () => {
  monitor._pilotNewDay();
  const gameFrame = monitor._context().pages()[0].frames().find(f => f.url().includes('/game'));
  const pilot = body => post('/api/autopilot', body).then(r => r.json());
  const setup = body => post('/api/autopilot/settings', body).then(r => r.json());
  const round = async v => {
    const before = (await state()).count;
    await gameFrame.evaluate(x => { const d = document.createElement('div'); d.textContent = x.toFixed(2) + 'x'; document.getElementById('list').prepend(d); }, v);
    return until(state, s => s.count > before);
  };
  const balance = async v => {
    await gameFrame.evaluate(x => { document.querySelector('.userBalanceMoney').textContent = '₹' + x.toFixed(2); }, v);
    return until(state, s => s.session.balance === v);
  };
  // The game shows this bet with Auto Play on.
  const betting = n => until(() => gameFrame.evaluate(() => [document.querySelector('.betSectionInput').value, document.querySelector('.autoPlayButton').classList.contains('active')]), v => v[0] === String(n) && v[1] === true);
  await balance(1000);
  await post('/api/session', {budget: 10000});
  assert.match((await post('/api/autopilot/settings', {recoverTarget: 1}).then(r => r.json())).error, /cash-out while winning back/);
  const saved = await post('/api/autopilot/settings', {lossLimit: 500, profitTarget: 500, betMode: 'fixed', betValue: 10, target: 2, maxRounds: 50, maxMinutes: 60, lossStreak: 10, lossAction: 'stop', recover: true, recoverTarget: 2, maxBet: 30}).then(r => r.json());
  assert.equal(saved.ok, true, saved.error);
  assert.equal((await pilot({on: true})).ok, true);
  await betting(10);
  await balance(990);
  await round(1.5); // Lost ₹10: one win at 2× must bring back 10 and the usual 10.
  await betting(20);
  await balance(970);
  await round(1.2); // Lost ₹20 more: 30 open would need ₹40, but the cap is ₹30.
  await betting(30);
  let st = await state();
  assert.deepEqual([st.autopilot.debt, st.autopilot.stake, st.autopilot.day.net], [30, 30, -30]);
  await balance(940);
  await balance(1000);
  await round(3); // Won ₹30: the open losses are covered, the bet is ₹10 again.
  await betting(10);
  st = await state();
  assert.deepEqual([st.autopilot.debt, st.autopilot.stake, st.autopilot.day.net, st.autopilot.day.rounds], [0, 10, 0, 3]);
  assert.ok(st.autopilot.log.some(l => /to win back: next bet ₹30,/.test(l.text)));
  // A round limit ends the day; raising it opens the day again.
  assert.equal((await pilot({on: false})).ok, true);
  await until(() => gameFrame.evaluate(() => document.querySelector('.autoPlayButton').classList.contains('active')), v => v === false);
  assert.equal((await setup({maxRounds: 4})).ok, true);
  assert.equal((await pilot({on: true})).ok, true);
  await betting(10);
  await balance(990);
  await round(1.1);
  st = await until(state, s => !s.autopilot.on);
  assert.match(st.autopilot.day.stopped, /4 rounds were played/);
  assert.equal(st.autopilot.day.final, false);
  assert.match((await pilot({on: true})).error, /Raise that limit/);
  assert.equal((await setup({maxRounds: 4})).reopened, false, 'still at the limit');
  assert.equal((await setup({maxRounds: 10})).reopened, true);
  assert.equal((await pilot({on: true})).ok, true);
  assert.equal((await pilot({on: false})).ok, true);
  await until(() => gameFrame.evaluate(() => document.querySelector('.autoPlayButton').classList.contains('active')), v => v === false);
  await balance(1000);
});

test('autopilot plans: cash-out raised after losses within a range; and a split of a secure bet and a rider', async () => {
  const gameFrame = monitor._context().pages()[0].frames().find(f => f.url().includes('/game'));
  const pilot = body => post('/api/autopilot', body).then(r => r.json());
  const setup = body => post('/api/autopilot/settings', body).then(r => r.json());
  const round = async v => {
    const before = (await state()).count;
    await gameFrame.evaluate(x => { const d = document.createElement('div'); d.textContent = x.toFixed(2) + 'x'; document.getElementById('list').prepend(d); }, v);
    return until(state, s => s.count > before);
  };
  const balance = async v => {
    await gameFrame.evaluate(x => { document.querySelector('.userBalanceMoney').textContent = '₹' + x.toFixed(2); }, v);
    return until(state, s => s.session.balance === v);
  };
  // What each bet panel of the game shows: [amount, cash-out, Auto Play on].
  const shown = () => gameFrame.evaluate(() => [...document.querySelectorAll('.betSectionBlock')].map(b => [b.querySelector('.betSectionInput').value, b.querySelector('.autoPlayTagInput').value, b.querySelector('.autoPlayButton').classList.contains('active')]));
  const shows = want => until(shown, v => JSON.stringify(v) === JSON.stringify(want));
  const common = {lossLimit: 500, profitTarget: 500, betMode: 'fixed', betValue: 10, maxRounds: 50, maxMinutes: 60, lossStreak: 10, lossAction: 'stop', recover: false};

  // Range: the bet stays ₹10; the cash-out moves between 1.5× and 3× with the open losses.
  monitor._pilotNewDay();
  await balance(1000);
  await post('/api/session', {budget: 10000});
  assert.match((await setup({plan: 'range', minTarget: 3, maxTarget: 2})).error, /highest cash-out must be above/);
  assert.equal((await setup({...common, plan: 'range', minTarget: 1.5, maxTarget: 3})).ok, true);
  assert.equal((await pilot({on: true})).ok, true);
  await shows([['10', '1.5', true]]);
  await balance(990);
  await round(1.2); // ₹10 lost: 2.5× brings back the 10 and the usual 5.
  await shows([['10', '2.5', true]]);
  await balance(980);
  await round(1.3); // ₹20 open would need 3.5×: held at the highest, 3×.
  await shows([['10', '3', true]]);
  await balance(970);
  await balance(1000);
  await round(4); // Won ₹20 at 3×: nothing open, back to 1.5×.
  await shows([['10', '1.5', true]]);
  let st = await state();
  assert.deepEqual([st.autopilot.debt, st.autopilot.day.net, st.autopilot.day.rounds], [0, 0, 3]);
  assert.equal((await pilot({on: false})).ok, true);
  await shows([['10', '1.5', false]]);

  // Split: the game gets a second bet panel; ₹10 leaves at 1.5× and ₹5 rides to 7×.
  monitor._pilotNewDay();
  await gameFrame.evaluate(() => {
    const first = document.querySelector('.betSectionBlock'), b = first.cloneNode(true);
    b.id = 'second';
    first.after(b);
    b.querySelector('.autoPlayButton').addEventListener('click', e => { const on = e.currentTarget.classList.toggle('active'); e.currentTarget.textContent = on ? 'stop' : 'auto play'; });
    b.querySelector('.switcher').addEventListener('click', () => { const t = b.querySelector('.autoPlayTagInput'); t.disabled = !t.disabled; });
    b.querySelector('.betButton').className = 'betButton start';
  });
  await until(state, s => s.session.game.slots.length === 2);
  await balance(1000);
  assert.equal((await setup({...common, plan: 'split', minTarget: 1.5, maxTarget: 7, riderBet: 5})).ok, true);
  const on = await pilot({on: true});
  assert.equal(on.ok, true, on.error);
  await shows([['10', '1.5', true], ['5', '7', true]]);
  await balance(985);
  await round(2); // The secure bet wins ₹5, the rider loses ₹5.
  st = await until(state, s => s.autopilot.day.rounds === 1);
  assert.deepEqual([st.autopilot.day.net, st.session.all[0].stake + st.session.all[1].stake], [0, 15]);
  await round(1.2); // Both lose.
  st = await until(state, s => s.autopilot.day.rounds === 2);
  assert.equal(st.autopilot.day.net, -15);
  await round(8); // Both win: +5 and +30.
  st = await until(state, s => s.autopilot.day.rounds === 3);
  assert.equal(st.autopilot.day.net, 20);
  assert.equal((await pilot({on: false})).ok, true);
  await shows([['10', '1.5', false], ['5', '7', false]]);
  await gameFrame.evaluate(() => document.getElementById('second').remove());
  await until(state, s => s.session.game.slots.length === 1);
  // Quick setup from two numbers, and the replay asks for enough captured rounds.
  const auto = await post('/api/autopilot/auto', {budget: 1000, loss: 100}).then(r => r.json());
  assert.deepEqual([auto.ok, auto.settings.lossLimit, auto.settings.profitTarget, auto.settings.betValue, auto.settings.plan, auto.settings.protect], [true, 100, 50, 5, 'range', true]);
  assert.match((await post('/api/autopilot/auto', {budget: 100, loss: 500}).then(r => r.json())).error, /cannot be more than the budget/);
  assert.match((await fetch(base + '/api/autopilot/replay').then(r => r.json())).error, /at least 200 rounds/);
  await setup({plan: 'single', protect: false});
  await balance(1000);
});

test('presses nothing when the game button changes between the check and the press', async () => {
  await post('/api/start', {url: `http://localhost:${gamePort}/`});
  await until(state, s => s.capture.status === 'live' && s.session.game && s.session.game.slots.length > 0);
  const gameFrame = monitor._context().pages()[0].frames().find(f => f.url().includes('/game'));
  await wireButtons(gameFrame);
  await post('/api/session', {budget: 1000});

  // A waiting bet (Cancel). Something covers the button for a moment, and when it clears the
  // round has started: the same button is now Cash Out.
  await gameFrame.evaluate(() => {
    const b = document.querySelector('.betButton');
    b.className = 'betButton cancel';
    b.textContent = 'cancel';
    const r = b.getBoundingClientRect();
    const cover = document.createElement('div');
    cover.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${Math.max(r.width, 20)}px;height:${Math.max(r.height, 20)}px;z-index:9999`;
    document.body.appendChild(cover);
    setTimeout(() => { b.className = 'betButton cashout'; b.textContent = 'cash out'; cover.remove(); }, 400);
  });
  const r = await post('/api/game/click', {slot: 0, action: 'cancel'}).then(x => x.json());
  assert.equal(r.ok, false);
  assert.match(r.error, /Nothing was pressed/);
  // Still Cash Out: a press would have turned it back to Bet.
  assert.equal(await gameFrame.evaluate(() => document.querySelector('.betButton').className), 'betButton cashout');
  await post('/api/stop');
});

test("logs in to the game site with what the admin typed, and says so when the site refuses", async () => {
  const login = body => post('/api/game/login', body).then(r => r.json());
  assert.match((await login({username: 'me'})).error, /Enter the game username and password/);
  await post('/api/start', {url: `http://localhost:${gamePort}/site`});
  await until(state, s => s.capture.status === 'waiting');
  const bad = await login({username: 'me', password: 'wrong-pass'});
  assert.equal(bad.ok, false);
  assert.match(bad.error, /still shows its login form/);
  const page = monitor._context().pages().find(p => p.url().includes('/site'));
  assert.deepEqual(await page.evaluate(() => window.sent), {u: 'me', p: 'wrong-pass'});
  assert.deepEqual(await login({username: 'me', password: 'right-pass', remember: true}), {ok: true, saved: true});
  // Kept encrypted on the server: the page learns the username only, and the file has no plain password.
  assert.equal((await state()).gameLogin.saved, 'me');
  const kept = fs.readFileSync(path.join(dir, 'data', 'game-login.json'), 'utf8');
  assert.ok(!kept.includes('right-pass'));
  // Logged out in the game: one click logs in again with the saved login.
  await page.reload();
  assert.deepEqual(await login({saved: true}), {ok: true, saved: false});
  assert.deepEqual(await page.evaluate(() => window.sent), {u: 'me', p: 'right-pass'});
  assert.equal((await post('/api/game/login/forget').then(r => r.json())).ok, true);
  assert.equal((await state()).gameLogin.saved, '');
  assert.match((await login({saved: true})).error, /No game login is saved/);
  assert.match((await login({username: 'me', password: 'right-pass'})).error, /No login form|no password box/);
  assert.ok(!JSON.stringify(await state()).includes('right-pass'));
  await post('/api/stop');
});

test('accounts: sign-in is required once an account exists, a viewer can look but not act, the shared name needs accounts', async () => {
  const {createAuth} = require('../lib/auth.js');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-auth-'));
  const dataDir = path.join(dir2, 'data');
  const m = createMonitor({port: 0, headless: true, dataDir, profileDir: path.join(dir2, 'profile'), publicHost: 'monitor.example.test'});
  const p = await m.listen();
  const call = (pathname, {method = 'GET', body, cookie, host = `127.0.0.1:${p}`, headers = {}} = {}) => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: p, path: pathname, method, headers: {Host: host, 'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {}), ...headers}}, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => { let data = null; try { data = JSON.parse(text); } catch {} resolve({status: res.statusCode, headers: res.headers, text, data}); });
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    // No accounts: open to this computer as before, closed under the shared name.
    assert.equal((await call('/api/state')).status, 200);
    assert.deepEqual((await call('/api/me')).data, {ok: true, auth: false, name: '', role: 'admin', gameWindow: false});
    assert.equal((await call('/api/state', {host: 'monitor.example.test'})).status, 403);
    assert.equal((await call('/api/state', {host: 'evil.example'})).status, 403);

    const auth = createAuth(dataDir);
    assert.equal(auth.addUser('boss', 'admin', 'short').ok, false);
    assert.equal(auth.addUser('boss', 'owner', 'long-enough-1').ok, false);
    assert.equal(auth.addUser('boss', 'admin', 'long-enough-1').ok, true);
    assert.equal(auth.addUser('client', 'viewer', 'long-enough-2').ok, true);
    assert.ok(!fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8').includes('long-enough'), 'passwords are not stored');

    // Now everything needs a sign-in, on this computer too.
    assert.equal((await call('/api/state')).status, 401);
    assert.equal((await call('/events')).status, 401);
    assert.equal((await call('/preview')).status, 401);
    assert.equal((await call('/export.csv')).status, 401);
    assert.equal((await call('/api/game/click', {method: 'POST', body: {slot: 0, action: 'bet'}})).status, 401);
    const home = await call('/');
    assert.equal(home.status, 302);
    assert.equal(home.headers.location, '/login');
    assert.match((await call('/login')).text, /Sign in/);

    assert.equal((await call('/api/login', {method: 'POST', body: {name: 'client', password: 'wrong-password'}})).status, 401);
    assert.equal((await call('/api/login', {method: 'POST', body: {name: 'nobody', password: 'long-enough-2'}})).status, 401);
    assert.equal((await call('/api/login', {method: 'POST', body: {name: 'client', password: 'long-enough-2'}, headers: {Origin: 'https://evil.example'}})).status, 403);

    // The viewer, through the shared name over https.
    const shared = {host: 'monitor.example.test', headers: {'X-Forwarded-Proto': 'https', Origin: 'https://monitor.example.test'}};
    const inV = await call('/api/login', {method: 'POST', body: {name: 'Client', password: 'long-enough-2'}, ...shared});
    assert.equal(inV.status, 200);
    assert.match(inV.headers['set-cookie'][0], /HttpOnly; SameSite=Lax; Max-Age=\d+; Secure/);
    const viewer = inV.headers['set-cookie'][0].split(';')[0];
    assert.deepEqual((await call('/api/me', {cookie: viewer, ...shared})).data, {ok: true, auth: true, name: 'client', role: 'viewer', gameWindow: false});
    assert.equal((await call('/api/state', {cookie: viewer, ...shared})).status, 200);
    assert.equal((await call('/api/analysis', {cookie: viewer, ...shared})).status, 200);
    assert.equal((await call('/', {cookie: viewer, ...shared})).status, 200);
    for (const route of ['/api/start', '/api/stop', '/api/clear', '/api/bet', '/api/settings', '/api/session', '/api/game/set', '/api/game/click', '/api/game/cutoff', '/api/autobet']) {
      const r = await call(route, {method: 'POST', body: {url: 'http://localhost:1/', slot: 0, action: 'bet', bet: 5, budget: 5}, cookie: viewer, ...shared});
      assert.equal(r.status, 403, route);
      assert.match(r.data.error, /only view/);
    }
    assert.equal((await call('/api/diagnose', {cookie: viewer, ...shared})).status, 403);
    assert.equal(m.state().capture.status, 'stopped');

    // The admin can act.
    const inA = await call('/api/login', {method: 'POST', body: {name: 'boss', password: 'long-enough-1'}});
    const admin = inA.headers['set-cookie'][0].split(';')[0];
    assert.ok(!/Secure/.test(inA.headers['set-cookie'][0]), 'plain http on this computer');
    assert.equal((await call('/api/settings', {method: 'POST', body: {pauseRounds: 2}, cookie: admin})).status, 200);
    assert.equal(m.state().settings.pauseRounds, 2);

    // Signing out, and removing an account, both end the session.
    assert.equal((await call('/api/logout', {method: 'POST', cookie: admin})).status, 200);
    assert.equal((await call('/api/state', {cookie: admin})).status, 401);
    auth.removeUser('client');
    assert.equal((await call('/api/state', {cookie: viewer, ...shared})).status, 401);

    // Five wrong tries from one address lock it out for a while, even with the right password.
    const from = {headers: {'X-Forwarded-For': '203.0.113.9'}};
    for (let i = 0; i < 5; i++) assert.equal((await call('/api/login', {method: 'POST', body: {name: 'boss', password: 'nope-nope'}, ...from})).status, 401);
    assert.equal((await call('/api/login', {method: 'POST', body: {name: 'boss', password: 'long-enough-1'}, ...from})).status, 429);
    assert.equal((await call('/api/login', {method: 'POST', body: {name: 'boss', password: 'long-enough-1'}})).status, 200);
  } finally { await m.close(); }
});

test('the game window is passed through to an admin only, page and live connection', async () => {
  const net = require('node:net');
  const {createAuth} = require('../lib/auth.js');
  // Stands in for the noVNC viewer: a page, and a WebSocket handshake that answers.
  const seen = [];
  const viewer = http.createServer((req, res) => { seen.push(req.url); res.writeHead(200, {'Content-Type': 'text/html'}).end('<title>noVNC</title>'); });
  viewer.on('upgrade', (req, socket) => { seen.push({url: req.url, cookie: req.headers.cookie || null, key: req.headers['sec-websocket-key']}); socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello'); });
  const viewerPort = await listen(viewer);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-window-'));
  const dataDir = path.join(dir2, 'data');
  const m = createMonitor({port: 0, headless: true, dataDir, profileDir: path.join(dir2, 'profile'), gameWindowPort: viewerPort});
  const p = await m.listen();
  const get = (pathname, cookie) => fetch(`http://127.0.0.1:${p}${pathname}`, {headers: cookie ? {Cookie: cookie} : {}, redirect: 'manual'});
  const signIn = async (name, password) => (await fetch(`http://127.0.0.1:${p}/api/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name, password})})).headers.get('set-cookie').split(';')[0];
  const upgrade = ({cookie, origin = `http://127.0.0.1:${p}`, url = '/vnc/websockify'} = {}) => new Promise(resolve => {
    const s = net.connect(p, '127.0.0.1', () => s.write(`GET ${url} HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${origin ? `Origin: ${origin}\r\n` : ''}${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`));
    let text = '';
    s.on('data', c => { text += c; });
    s.on('close', () => resolve(text));
    s.on('error', () => resolve(text));
  });
  try {
    const auth = createAuth(dataDir);
    auth.addUser('boss', 'admin', 'long-enough-1');
    auth.addUser('client', 'viewer', 'long-enough-2');
    const admin = await signIn('boss', 'long-enough-1'), client = await signIn('client', 'long-enough-2');

    assert.equal((await (await get('/api/me', admin)).json()).gameWindow, true);
    assert.equal((await (await get('/api/me', client)).json()).gameWindow, false);

    // The viewer page.
    assert.equal((await get('/vnc/vnc.html?autoconnect=1')).status, 401);
    assert.equal((await get('/vnc/vnc.html', client)).status, 403);
    const page = await get('/vnc/vnc.html?autoconnect=1', admin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /noVNC/);
    assert.deepEqual(seen, ['/vnc.html?autoconnect=1']);

    // The live connection.
    assert.match(await upgrade(), /^HTTP\/1\.1 403/);
    assert.match(await upgrade({cookie: client}), /^HTTP\/1\.1 403/);
    assert.match(await upgrade({cookie: admin, origin: 'https://evil.example'}), /^HTTP\/1\.1 403/);
    assert.match(await upgrade({cookie: admin, origin: ''}), /^HTTP\/1\.1 403/);
    assert.match(await upgrade({cookie: admin, url: '/vnc/other'}), /^HTTP\/1\.1 403/);
    assert.equal(seen.length, 1, 'nothing refused reached the viewer');
    const live = await upgrade({cookie: admin});
    assert.match(live, /^HTTP\/1\.1 101/);
    assert.match(live, /hello$/);
    assert.deepEqual(seen[1], {url: '/websockify', cookie: null, key: 'dGhlIHNhbXBsZSBub25jZQ=='});
  } finally { await m.close(); viewer.closeAllConnections(); viewer.close(); }

  // Without a viewer configured there is no game window at all.
  assert.equal((await fetch(`${base}/vnc/vnc.html`)).status, 404);
  assert.equal((await (await fetch(`${base}/api/me`)).json()).gameWindow, false);
});
