// Runs the real extension background script (via its test harness, with fake Chrome APIs but
// real network) against the running server and database.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, test} from 'node:test';
import {BASE, makeTracker, sql, until} from './helpers.ts';

const require = createRequire(import.meta.url);
const {loadBackground} = require('../../../tests/harness.js');
after(() => sql.end());

const TAB = 7, SITE = 'https://game.example';
const frame = {tab: {id: TAB}, frameId: 0};
const snap = (values: number[]) => ({type: 'AVIATOR_SNAPSHOT', values, newCount: null});
const stored = (trackerId: string) => sql<{seq: number; value: number; gap_before: boolean; site: string}[]>`
  SELECT seq, value::float AS value, gap_before, site FROM rounds WHERE tracker_id = ${trackerId} ORDER BY seq`;

async function capturing(key: string) {
  const bg = loadBackground({fetch});
  bg.tabs.set(TAB, {id: TAB, url: `${SITE}/aviator`, active: true});
  assert.deepEqual(await bg.send({type: 'AVIATOR_CAPTURE_START', tabId: TAB, origin: SITE}), {ok: true});
  assert.deepEqual(await bg.send({type: 'AVIATOR_CLOUD_SET', url: BASE, key}), {ok: true});
  return bg;
}

test('extension uploads captured rounds to the server, in order, once', async () => {
  const t = await makeTracker();
  const bg = await capturing(t.key);
  bg.send(snap([1.2, 3.4, 2.1]), frame);
  await until(() => stored(t.id), r => r.length === 3);
  bg.send(snap([9.9, 1.05, 1.2, 3.4, 2.1]), frame);
  bg.send(snap([9.9, 1.05, 1.2, 3.4, 2.1]), frame); // Same list again: nothing new.
  const rows = await until(() => stored(t.id), r => r.length === 5);
  assert.deepEqual(rows.map(r => [r.seq, r.value]), [[0, 2.1], [1, 3.4], [2, 1.2], [3, 1.05], [4, 9.9]]);
  assert.ok(rows.every(r => r.site === SITE && !r.gap_before));
  await until(async () => bg.local.outbox?.length, n => n === 0);
  assert.deepEqual(bg.local.outbox, []);
  assert.ok(bg.local.cloudStatus.okAt > 0);
});

test('extension keeps rounds while the key is wrong and sends them after it is fixed', async () => {
  const t = await makeTracker();
  const wrong = 'avk_' + 'z'.repeat(43);
  const bg = await capturing(wrong);
  bg.send(snap([2, 3, 4]), frame);
  await until(async () => bg.local.cloudStatus?.error, e => Boolean(e));
  assert.match(bg.local.cloudStatus.error, /did not accept the key/);
  assert.equal(bg.local.outbox.length, 3);
  // A new key starts a new stream and clears the outbox: only rounds after the fix are sent.
  await bg.send({type: 'AVIATOR_CLOUD_SET', url: BASE, key: t.key});
  bg.send(snap([5, 2, 3, 4]), frame);
  const rows = await until(() => stored(t.id), r => r.length === 1);
  assert.deepEqual(rows.map(r => r.value), [5]);
});

test('extension marks missed rounds and the dashboard export shows the break', async () => {
  const t = await makeTracker();
  const bg = await capturing(t.key);
  bg.send(snap([3, 2, 1]), frame);
  await until(() => stored(t.id), r => r.length === 3);
  bg.send(snap([30, 20, 10]), frame); // Nothing lines up with the stored rounds: a break.
  const rows = await until(() => stored(t.id), r => r.length === 6);
  assert.deepEqual(rows.map(r => r.gap_before), [false, false, false, true, false, false]);
  const [{stream}] = await sql`SELECT DISTINCT stream FROM rounds WHERE tracker_id = ${t.id}`;
  const csv = await (await fetch(`${BASE}/api/export?stream=${stream}`, {headers: {Cookie: `aviator_tracker=${t.key}`}})).text();
  assert.match(csv, /\n3,10,1,/);
});
