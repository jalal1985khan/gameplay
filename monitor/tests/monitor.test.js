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
  <div class="autoCashOut"><div class="forAvi switcher"></div><input class="autoPlayTagInput" value="2" disabled></div></div></div>`;
const GAME = `<!doctype html><body>${PANEL}<div id="flying">1.37x</div><div id="list"></div><script>
  const list = document.getElementById('list');
  const add = v => { const d = document.createElement('div'); d.textContent = v.toFixed(2) + 'x'; list.prepend(d); while (list.children.length > 20) list.lastChild.remove(); };
  [1.20, 3.45, 1.00, 12.30, 2.05, 1.71].forEach(add);
  let i = 0; const next = [4.44, 1.08, 2.50, 1.99, 7.77];
  setInterval(() => { if (i < next.length) add(next[i++]); }, 400);
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
  assert.deepEqual(s.settings, {pauseRounds: 3, stopLossShare: 0.25, alarmSound: true});
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
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'settings.json'), 'utf8')), {pauseRounds: 0, stopLossShare: 0.5, alarmSound: true});
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

test('stop closes the game window; history is kept and saved', async () => {
  await post('/api/stop');
  const s = await state();
  assert.equal(s.capture.status, 'stopped');
  assert.equal(s.count, 28);
  assert.equal(s.session.canBet, false, 'no bets while not capturing');
  await wait(500);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'history.json'), 'utf8'));
  assert.equal(saved.values.length, 28);
});

test('clear empties the history', async () => {
  await post('/api/clear');
  assert.equal((await state()).count, 0);
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
  // Diagnostics list each frame and the lists it found.
  const d = await (await fetch(base + '/api/diagnose')).json();
  assert.equal(d.ok, true);
  const gameFrame = d.frames.find(f => f.url.includes('/game'));
  assert.ok(gameFrame.candidates.some(c => c.marked && c.sample.includes('7.77x')));
  const top = d.frames.find(f => f.url.includes('/late'));
  assert.ok(top.candidates.some(c => !c.marked));
  await post('/api/stop');
});
