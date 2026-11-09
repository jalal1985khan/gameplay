const assert = require('assert');
const {test, settle, loadBackground} = require('./harness');

const TAB = 7, SITE = 'https://game.example';
const frame = (frameId = 0, tabId = TAB) => ({tab: {id: tabId}, frameId});
const snap = (values, newCount = null) => ({type: 'AVIATOR_SNAPSHOT', values, newCount});

async function started() {
  const bg = loadBackground();
  bg.tabs.set(TAB, {id: TAB, url: `${SITE}/aviator`, active: true});
  const res = await bg.send({type: 'AVIATOR_CAPTURE_START', tabId: TAB, origin: SITE});
  assert.deepStrictEqual(res, {ok: true});
  return bg;
}

test('background: start attaches to every frame and marks capture running', async () => {
  const bg = await started();
  assert.deepStrictEqual(bg.calls.executeScript, [{target: {tabId: TAB, allFrames: true}, files: ['content.js']}]);
  assert.strictEqual(bg.local.capture.state, 'running');
  assert.strictEqual(bg.local.capture.origin, SITE);
});

test('background: start failure is reported and capture stays stopped', async () => {
  const bg = loadBackground();
  bg.chrome.scripting.fail = 'Cannot access contents of the page';
  const res = await bg.send({type: 'AVIATOR_CAPTURE_START', tabId: TAB, origin: SITE});
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Cannot access/);
  assert.strictEqual(bg.local.capture.state, 'stopped');
});

test('background: start and stop are refused from page scripts', async () => {
  const bg = loadBackground();
  assert.strictEqual(await bg.send({type: 'AVIATOR_CAPTURE_START', tabId: TAB, origin: SITE}, frame()), undefined);
  await settle();
  assert.strictEqual(bg.local.capture, undefined);
});

test('background: a burst of snapshots stores every round once, in order', async () => {
  const bg = await started();
  bg.send(snap([5, 4, 3, 2, 1]), frame());
  bg.send(snap([6, 5, 4, 3, 2]), frame());
  bg.send(snap([7, 6, 5, 4, 3]), frame());
  bg.send(snap([7, 6, 5, 4, 3]), frame());
  bg.send(snap([9, 8, 7, 6, 5]), frame());
  await settle();
  assert.deepStrictEqual(bg.local.captured, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepStrictEqual(bg.local.gaps, []);
  assert.ok(bg.local.capture.lastRoundAt > 0);
});

test('background: only one frame reports; others are ignored', async () => {
  const bg = await started();
  bg.send(snap([5, 4, 3, 2, 1]), frame(0));
  bg.send(snap([50, 40, 30, 20, 10]), frame(3));
  await settle();
  assert.deepStrictEqual(bg.local.captured, [1, 2, 3, 4, 5]);
});

test('background: repeated values are caught through the new-element count', async () => {
  const bg = await started();
  bg.send(snap([1, 1, 1, 1, 2]), frame());
  bg.send(snap([1, 1, 1, 1, 1], 1), frame());
  await settle();
  assert.deepStrictEqual(bg.local.captured, [2, 1, 1, 1, 1, 1]);
});

test('background: missed rounds are stored after a break marker', async () => {
  const bg = await started();
  bg.send(snap([5, 4, 3, 2, 1]), frame());
  bg.send(snap([20, 19, 18, 17, 16]), frame());
  await settle();
  assert.deepStrictEqual(bg.local.captured, [1, 2, 3, 4, 5, 16, 17, 18, 19, 20]);
  assert.deepStrictEqual(bg.local.gaps, [5]);
  assert.ok(bg.local.capture.lastGapAt > 0);
});

test('background: invalid snapshots, other tabs and stopped capture are ignored', async () => {
  const bg = await started();
  bg.send(snap([5, 4, NaN, 2, 1]), frame());
  bg.send(snap([5, 4, 0.5, 2, 1]), frame());
  bg.send(snap('5,4,3'), frame());
  bg.send(snap([5, 4, 3, 2, 1]), frame(0, 99));
  bg.send(snap([5, 4, 3, 2, 1]), {});
  await settle();
  assert.strictEqual(bg.local.captured, undefined);
  await bg.send({type: 'AVIATOR_CAPTURE_STOP'});
  bg.send(snap([5, 4, 3, 2, 1]), frame());
  await settle();
  assert.strictEqual(bg.local.captured, undefined);
  assert.strictEqual(bg.local.capture.state, 'stopped');
  assert.deepStrictEqual(bg.calls.tabMessages.at(-1), {tabId: TAB, message: {type: 'AVIATOR_STOP'}});
});

test('background: page reload resumes capture without duplicating rounds', async () => {
  const bg = await started();
  bg.send(snap([5, 4, 3, 2, 1]), frame(0));
  await settle();
  bg.chrome.tabs.onUpdated.fire(TAB, {status: 'complete'}, {id: TAB, url: `${SITE}/aviator?r=1`});
  await settle();
  assert.strictEqual(bg.calls.executeScript.length, 2);
  assert.strictEqual(bg.local.capture.state, 'running');
  assert.match(bg.local.capture.note, /Resumed/);
  // After the reload the game's iframe has a new frame id; the lock was released.
  bg.send(snap([7, 6, 5, 4, 3]), frame(12));
  await settle();
  assert.deepStrictEqual(bg.local.captured, [1, 2, 3, 4, 5, 6, 7]);
});

test('background: leaving the site interrupts, returning resumes', async () => {
  const bg = await started();
  bg.chrome.tabs.onUpdated.fire(TAB, {status: 'complete'}, {id: TAB, url: 'https://other.example/'});
  await settle();
  assert.strictEqual(bg.local.capture.state, 'interrupted');
  bg.send(snap([5, 4, 3, 2, 1]), frame());
  await settle();
  assert.strictEqual(bg.local.captured, undefined);
  bg.chrome.tabs.onUpdated.fire(TAB, {status: 'complete'}, {id: TAB, url: `${SITE}/`});
  await settle();
  assert.strictEqual(bg.local.capture.state, 'running');
});

test('background: lost site access interrupts on reload', async () => {
  const bg = await started();
  bg.chrome.permissions.granted = false;
  bg.chrome.tabs.onUpdated.fire(TAB, {status: 'complete'}, {id: TAB, url: `${SITE}/`});
  await settle();
  assert.strictEqual(bg.local.capture.state, 'interrupted');
  assert.match(bg.local.capture.note, /Site access/);
});

test('background: other tabs loading do not affect capture', async () => {
  const bg = await started();
  bg.chrome.tabs.onUpdated.fire(99, {status: 'complete'}, {id: 99, url: 'https://other.example/'});
  bg.chrome.tabs.onRemoved.fire(99);
  await settle();
  assert.strictEqual(bg.local.capture.state, 'running');
  assert.strictEqual(bg.calls.executeScript.length, 1);
});

test('background: closing the capture tab stops capture', async () => {
  const bg = await started();
  bg.chrome.tabs.onRemoved.fire(TAB);
  await settle();
  assert.strictEqual(bg.local.capture.state, 'stopped');
  assert.match(bg.local.capture.note, /closed/);
});

test('background: a reloaded iframe triggers one re-attach', async () => {
  const bg = await started();
  bg.send({type: 'AVIATOR_FRAME_LOADED'}, frame());
  bg.send({type: 'AVIATOR_FRAME_LOADED'}, frame());
  await settle();
  assert.strictEqual(bg.calls.executeScript.length, 2);
});

test('background: starting in a new tab stops the old one', async () => {
  const bg = await started();
  await bg.send({type: 'AVIATOR_CAPTURE_START', tabId: 8, origin: SITE});
  assert.deepStrictEqual(bg.calls.tabMessages.at(-1), {tabId: TAB, message: {type: 'AVIATOR_STOP'}});
  assert.strictEqual(bg.local.capture.tabId, 8);
});

test('background: extension update re-attaches a running capture', async () => {
  const bg = await started();
  bg.local.captureTabId = TAB;
  bg.chrome.runtime.onInstalled.fire({reason: 'update'});
  await settle();
  assert.strictEqual(bg.calls.executeScript.length, 2);
  assert.strictEqual(bg.local.captureTabId, undefined);
  bg.tabs.delete(TAB);
  bg.chrome.runtime.onInstalled.fire({reason: 'update'});
  await settle();
  assert.strictEqual(bg.local.capture.state, 'interrupted');
});

test('background: browser restart marks capture stopped', async () => {
  const bg = await started();
  bg.chrome.runtime.onStartup.fire();
  await settle();
  assert.strictEqual(bg.local.capture.state, 'stopped');
});

test('background: history is capped at 5,000 rounds', async () => {
  const bg = await started();
  bg.local.captured = Array.from({length: 4999}, (_, i) => 1 + i / 10000);
  bg.local.gaps = [10];
  bg.send(snap([9, 8, 7, 6, 5]), frame());
  await settle();
  assert.strictEqual(bg.local.captured.length, 5000);
  assert.deepStrictEqual(bg.local.captured.slice(-5), [5, 6, 7, 8, 9]);
  assert.deepStrictEqual(bg.local.gaps, [6, 4995]);
});
