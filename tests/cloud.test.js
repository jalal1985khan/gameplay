const assert = require('assert');
const {test, settle, loadBackground} = require('./harness');

const TAB = 7, SITE = 'https://game.example', SERVER = 'https://tracker.example';
const KEY = 'avk_' + 'a'.repeat(43);
const frame = () => ({tab: {id: TAB}, frameId: 0});
const snap = values => ({type: 'AVIATOR_SNAPSHOT', values, newCount: null});

async function started({cloud = true} = {}) {
  const bg = loadBackground();
  bg.tabs.set(TAB, {id: TAB, url: `${SITE}/aviator`, active: true});
  await bg.send({type: 'AVIATOR_CAPTURE_START', tabId: TAB, origin: SITE});
  if (cloud) assert.deepStrictEqual(await bg.send({type: 'AVIATOR_CLOUD_SET', url: `${SERVER}/some/path`, key: KEY}), {ok: true});
  return bg;
}

test('cloud: off by default, nothing is sent', async () => {
  const bg = await started({cloud: false});
  bg.send(snap([3, 2, 1]), frame());
  await settle();
  assert.deepStrictEqual(bg.local.captured, [1, 2, 3]);
  assert.strictEqual(bg.net.requests.length, 0);
  assert.strictEqual(bg.local.outbox, undefined);
});

test('cloud: rounds are uploaded once, in order, with growing sequence numbers', async () => {
  const bg = await started();
  bg.send(snap([3, 2, 1]), frame());
  await settle();
  bg.send(snap([5, 4, 3, 2, 1]), frame());
  await settle();
  const sent = bg.net.requests.flatMap(r => r.body.rounds);
  assert.deepStrictEqual(sent.map(r => [r.seq, r.value]), [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]);
  const req = bg.net.requests[0];
  assert.strictEqual(req.url, `${SERVER}/api/rounds`);
  assert.strictEqual(req.headers.Authorization, `Bearer ${KEY}`);
  assert.strictEqual(req.body.site, SITE);
  assert.match(req.body.stream, /^[0-9a-f-]{36}$/);
  assert.deepStrictEqual(bg.local.outbox, []);
  assert.strictEqual(bg.local.cloudStatus.error, '');
});

test('cloud: failed uploads keep rounds and retry with the same sequence numbers', async () => {
  const bg = await started();
  bg.net.reply = () => new Error('offline');
  bg.send(snap([3, 2, 1]), frame());
  await settle();
  assert.strictEqual(bg.local.outbox.length, 3);
  assert.match(bg.local.cloudStatus.error, /Could not reach/);
  bg.net.reply = () => ({status: 200, body: {ok: true}});
  bg.send(snap([4, 3, 2, 1]), frame());
  await settle();
  const last = bg.net.requests.at(-1).body.rounds;
  assert.deepStrictEqual(last.map(r => r.seq), [0, 1, 2, 3]);
  assert.deepStrictEqual(bg.local.outbox, []);
});

test('cloud: a rejected key is reported and rounds are kept', async () => {
  const bg = await started();
  bg.net.reply = () => ({status: 401, body: {error: 'invalid or missing key'}});
  bg.send(snap([2, 1, 1.5]), frame());
  await settle();
  assert.match(bg.local.cloudStatus.error, /did not accept the key/);
  assert.strictEqual(bg.local.outbox.length, 3);
});

test('cloud: missed rounds are marked on the first round after the break', async () => {
  const bg = await started();
  bg.send(snap([3, 2, 1]), frame());
  await settle();
  bg.send(snap([30, 20, 10]), frame());
  await settle();
  const sent = bg.net.requests.flatMap(r => r.body.rounds);
  assert.deepStrictEqual(sent.map(r => r.gap), [false, false, false, true, false, false]);
});

test('cloud: settings are checked, refused from pages, and turning off clears the outbox', async () => {
  const bg = await started({cloud: false});
  assert.match((await bg.send({type: 'AVIATOR_CLOUD_SET', url: 'http://tracker.example', key: KEY})).error, /https/);
  assert.match((await bg.send({type: 'AVIATOR_CLOUD_SET', url: SERVER, key: 'nope'})).error, /avk_/);
  assert.deepStrictEqual(await bg.send({type: 'AVIATOR_CLOUD_SET', url: 'http://localhost:3000', key: KEY}), {ok: true});
  assert.strictEqual(await bg.send({type: 'AVIATOR_CLOUD_SET', url: SERVER, key: KEY}, frame()), undefined);
  await settle();
  assert.strictEqual(bg.local.cloud.url, 'http://localhost:3000');
  const stream = bg.local.cloud.stream;
  await bg.send({type: 'AVIATOR_CLOUD_SET', url: 'http://localhost:3000', key: KEY});
  assert.strictEqual(bg.local.cloud.stream, stream, 'same server and key keep the stream');
  await bg.send({type: 'AVIATOR_CLOUD_SET', url: '', key: ''});
  assert.strictEqual(bg.local.cloud, null);
  assert.deepStrictEqual(bg.local.outbox, []);
});
