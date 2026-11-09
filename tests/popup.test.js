const assert = require('assert');
const vm = require('vm');
const {test, read, wait, settle, makeChrome, fairRounds} = require('./harness');

const html = read('popup.html');

test('popup: every element the script uses exists in the page', () => {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const used = new Set([...read('popup.js').matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
  for (const id of ['planBet', 'planTarget', 'planRounds', 'planBudget']) used.add(id);
  for (const id of used) assert.ok(ids.has(id), `#${id} missing from popup.html`);
});

// Loads popup.js with stats.js against fake elements built from popup.html.
async function loadPopup(stored = {}) {
  const {chrome, calls, tabs} = makeChrome();
  Object.assign(chrome.storage.local.data, JSON.parse(JSON.stringify(stored)));
  const elements = new Map();
  const element = id => {
    const listeners = {};
    return {
      id, textContent: '', innerHTML: '', className: '', value: '', dataset: {}, children: [],
      classList: {toggle() {}},
      addEventListener: (type, f) => (listeners[type] ||= []).push(f),
      fire: async (type, e = {}) => { for (const f of listeners[type] || []) await f(e); },
    };
  };
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, element(id));
  for (const [, id, value] of html.matchAll(/<input id="([^"]+)"[^>]*?value="([^"]*)"/g)) elements.get(id).value = value;
  const targets = elements.get('targets');
  targets.children = ['1.5', '2', '3', '5', '10'].map(t => ({dataset: {t}, classList: {toggle() {}}}));
  const ctx = vm.createContext({
    chrome, console, Blob, URL: Object.assign(class extends URL {}, {createObjectURL: () => 'blob:x', revokeObjectURL() {}}),
    document: {getElementById: id => elements.get(id) || null, createElement: () => ({click() {}})},
    setInterval: () => 0,
  });
  vm.runInContext(read('stats.js'), ctx, {filename: 'stats.js'});
  vm.runInContext(read('strategy.js'), ctx, {filename: 'strategy.js'});
  vm.runInContext(read('popup.js'), ctx, {filename: 'popup.js'});
  await settle();
  return {chrome, calls, tabs, $: id => elements.get(id), local: chrome.storage.local.data};
}

test('popup: empty state renders without errors', async () => {
  const p = await loadPopup();
  assert.strictEqual(p.$('count').textContent, 0);
  assert.strictEqual(p.$('captureHealth').textContent, 'Capture stopped.');
  assert.match(p.$('baseRate').textContent, /Capture some rounds/);
});

test('popup: full history renders odds, checks, quality and the break marker', async () => {
  const captured = fairRounds(600, 31);
  const p = await loadPopup({captured, gaps: [300], capture: {state: 'running', startedAt: Date.now() - 60000, lastSnapshotAt: Date.now(), lastRoundAt: Date.now() - 5000, lastGapAt: null, note: ''}});
  assert.strictEqual(p.$('count').textContent, 600);
  assert.match(p.$('quality').textContent, /1 missed-rounds break · longest unbroken stretch 300 rounds/);
  assert.match(p.$('baseRate').innerHTML, /game's built-in odds 48\.5%/);
  assert.match(p.$('baseRate').innerHTML, /Consistent with the game's odds/);
  assert.strictEqual((p.$('trends').innerHTML.match(/class="trend"/g) || []).length, 6);
  assert.strictEqual((p.$('randomness').innerHTML.match(/class="trend"/g) || []).length, 2);
  assert.match(p.$('captureHealth').textContent, /Running · results list found · last new round 5s ago/);
  // History shows the newest 40 rounds; the break at index 300 is outside them.
  assert.strictEqual((p.$('liveHistory').innerHTML.match(/class="chip /g) || []).length, 40);
});

test('popup: break marker appears inside the newest 40 rounds', async () => {
  const p = await loadPopup({captured: fairRounds(50, 2), gaps: [45]});
  assert.match(p.$('liveHistory').innerHTML, /missed rounds/);
});

test('popup: capture health covers waiting, not found, interrupted and missed rounds', async () => {
  const now = Date.now();
  let p = await loadPopup({capture: {state: 'running', startedAt: now, lastSnapshotAt: null}});
  assert.match(p.$('captureHealth').textContent, /Looking for the game's results list/);
  p = await loadPopup({capture: {state: 'running', startedAt: now - 20000, lastSnapshotAt: null}});
  assert.match(p.$('captureHealth').textContent, /has not been found/);
  p = await loadPopup({capture: {state: 'interrupted', note: 'The capture tab left the game site.'}});
  assert.strictEqual(p.$('captureHealth').className, 'health bad');
  p = await loadPopup({capture: {state: 'running', startedAt: now - 60000, lastSnapshotAt: now, lastRoundAt: now, lastGapAt: now - 1000}});
  assert.match(p.$('captureHealth').textContent, /rounds missed 1s ago \(marked\)/);
});

test('popup: storage changes update the view live', async () => {
  const p = await loadPopup();
  await p.chrome.storage.local.set({captured: [1.5, 2.5, 3.5], gaps: []});
  await p.chrome.storage.local.set({capture: {state: 'stopped', note: 'The capture tab was closed.'}});
  assert.strictEqual(p.$('count').textContent, 3);
  assert.strictEqual(p.$('captureHealth').textContent, 'The capture tab was closed.');
});

test('popup: start checks the URL and the active tab, then asks the background', async () => {
  const p = await loadPopup();
  await p.$('start').fire('click');
  assert.match(p.$('liveStatus').textContent, /valid http/);
  p.$('siteUrl').value = 'https://game.example/aviator';
  p.tabs.set(3, {id: 3, url: 'https://game.example.evil.test/', active: true});
  await p.$('start').fire('click');
  assert.match(p.$('liveStatus').textContent, /Open the configured game website/);
  p.tabs.set(3, {id: 3, url: 'https://game.example/play', active: true});
  await p.$('start').fire('click');
  assert.deepStrictEqual(p.calls.runtimeMessages.at(-1), {type: 'AVIATOR_CAPTURE_START', tabId: 3, origin: 'https://game.example'});
  assert.match(p.$('liveStatus').textContent, /Capture started/);
  p.chrome.permissions.granted = false;
  await p.$('start').fire('click');
  assert.match(p.$('liveStatus').textContent, /declined/);
});

test('popup: stop, clear and export work', async () => {
  const p = await loadPopup({captured: [1.2, 3.4], gaps: [1]});
  await p.$('stop').fire('click');
  assert.deepStrictEqual(p.calls.runtimeMessages.at(-1), {type: 'AVIATOR_CAPTURE_STOP'});
  p.$('export').fire('click');
  await p.$('clearLive').fire('click');
  assert.deepStrictEqual([p.local.captured, p.local.gaps], [[], []]);
  p.$('export').fire('click');
  assert.match(p.$('liveStatus').textContent, /No captured values/);
});

test('popup: target buttons, plan check and bet log', async () => {
  const p = await loadPopup({captured: fairRounds(200, 37), plan: {bet: 100, target: 2, rounds: 50, budget: 300, unknown: 1}});
  const five = p.$('targets').children[3];
  await p.$('targets').fire('click', {target: {closest: () => five}});
  assert.match(p.$('baseRate').innerHTML, /reached 5×/);
  await p.$('checkPlan').fire('click');
  assert.match(p.$('planResult').innerHTML, /Expected cost of this plan/);
  assert.match(p.$('planResult').innerHTML, /High risk/);
  p.$('planBet').value = '0';
  await p.$('checkPlan').fire('click');
  assert.match(p.$('planResult').innerHTML, /Enter a bet/);
  p.$('logBet').value = '100'; p.$('logCashout').value = '';
  await p.$('logAdd').fire('click');
  p.$('logBet').value = '200';
  await p.$('logAdd').fire('click');
  p.$('logBet').value = '400';
  await p.$('logAdd').fire('click');
  assert.match(p.$('logWarnings').innerHTML, /loss limit/);
  p.$('logCashout').value = '0.5';
  await p.$('logAdd').fire('click');
  assert.match(p.$('liveStatus').textContent, /cash-out of at least 1×/);
  await wait(20);
  assert.strictEqual(p.local.betLog.length, 3);
  await p.$('logReset').fire('click');
  assert.match(p.$('logSummary').innerHTML, /<strong>0<\/strong>/);
});

test('popup: strategy tester reads, simulates, replays history and saves the text', async () => {
  let p = await loadPopup();
  await p.$('testStrategy').fire('click');
  assert.match(p.$('strategyResult').innerHTML, /Describe a strategy first/);
  await p.$('strategyPresets').fire('click', {target: {closest: () => ({dataset: {s: 'Martingale: bet ₹10 at 2x, budget 2000'}})}});
  const out = p.$('strategyResult').innerHTML;
  assert.match(out, /After a loss: double the bet/);
  assert.match(out, /2,000 simulated sessions/);
  assert.match(out, /Capture at least 50 rounds/);
  assert.match(out, /not an edge/);
  await settle();
  assert.strictEqual(p.local.strategyText, 'Martingale: bet ₹10 at 2x, budget 2000');

  p = await loadPopup({captured: fairRounds(500, 6), strategyText: 'bet 10 at 2x <b>fibonacci</b>'});
  assert.strictEqual(p.$('strategyText').value, 'bet 10 at 2x <b>fibonacci</b>');
  await p.$('testStrategy').fire('click');
  const o2 = p.$('strategyResult').innerHTML;
  assert.match(o2, /On your 500 captured rounds/);
  assert.match(o2, /Not understood, so ignored: b, fibonacci, b/);
  assert.doesNotMatch(o2, /<b>fibonacci/);
});
