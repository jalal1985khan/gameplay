import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {makeTracker, post, rounds, sql} from './helpers.ts';
import {APP_SOURCES, checkStreamWrite, insertRounds} from '../../lib/rounds.ts';
import {db} from '../../lib/db.ts';

after(async () => { await sql.end(); await db().end(); });

test('app forms may not write into a live capture stream', async () => {
  const t = await makeTracker();
  await post(t.key, {stream: 'live-stream-1', site: 'https://game.example', rounds: rounds(0, 5)});
  await post(t.key, {stream: 'api-no-site-1', rounds: rounds(0, 2)});
  for (const source of Object.values(APP_SOURCES)) {
    assert.match(await checkStreamWrite(t.id, 'live-stream-1', source) ?? '', /live capture/, source);
    assert.match(await checkStreamWrite(t.id, 'api-no-site-1', source) ?? '', /live capture/, source);
    assert.equal(await checkStreamWrite(t.id, 'brand-new', source), null, source);
  }
});

test('app forms may rewrite their own kind of stream, but not another kind', async () => {
  const t = await makeTracker();
  await insertRounds(t.id, 'manual', [{seq: 0, value: 2, gap: false}], APP_SOURCES.manual);
  await insertRounds(t.id, 'sample-simulation', [{seq: 0, value: 2, gap: false}], APP_SOURCES.sample);
  assert.equal(await checkStreamWrite(t.id, 'manual', APP_SOURCES.manual), null);
  assert.equal(await checkStreamWrite(t.id, 'sample-simulation', APP_SOURCES.sample), null);
  assert.ok(await checkStreamWrite(t.id, 'manual', APP_SOURCES.sample));
  assert.ok(await checkStreamWrite(t.id, 'sample-simulation', APP_SOURCES.import));
  // Another tracker's stream of the same name does not count.
  const other = await makeTracker();
  assert.equal(await checkStreamWrite(other.id, 'manual', APP_SOURCES.sample), null);
});
