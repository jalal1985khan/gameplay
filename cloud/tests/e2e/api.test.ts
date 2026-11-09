import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {BASE, makeTracker, post, rounds, sql} from './helpers.ts';

after(() => sql.end());

test('ingest stores rounds once, keyed by stream and sequence', async () => {
  const t = await makeTracker();
  let r = await post(t.key, {stream: 'stream-aaaa', site: 'https://game.example/play', rounds: rounds(0, 3)});
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {ok: true, stored: 3, duplicates: 0, upTo: 2});
  r = await post(t.key, {stream: 'stream-aaaa', rounds: rounds(2, 3)});
  assert.deepEqual(await r.json(), {ok: true, stored: 2, duplicates: 1, upTo: 4});
  const rows = await sql`SELECT seq, value::float AS value, site FROM rounds WHERE tracker_id = ${t.id} ORDER BY seq`;
  assert.deepEqual(rows.map(x => x.seq), [0, 1, 2, 3, 4]);
  assert.equal(rows[0].site, 'https://game.example');
  // Another tracker can use the same stream name without clashing.
  const other = await makeTracker();
  assert.equal((await (await post(other.key, {stream: 'stream-aaaa', rounds: rounds(0, 1)})).json()).stored, 1);
});

test('ingest refuses bad keys and bad payloads', async () => {
  const t = await makeTracker();
  assert.equal((await post('avk_' + 'x'.repeat(43), {stream: 'stream-aaaa', rounds: rounds(0, 1)}, '10.9.9.1')).status, 401);
  const bad = await post(t.key, {stream: 'stream-aaaa', rounds: [{seq: 0, value: 0.5, at: Date.now()}]});
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /value/);
  const notJson = await fetch(`${BASE}/api/rounds`, {method: 'POST', headers: {Authorization: `Bearer ${t.key}`}, body: '{oops'});
  assert.equal(notJson.status, 400);
  const pre = await fetch(`${BASE}/api/rounds`, {method: 'OPTIONS'});
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Authorization/);
});

test('repeated wrong keys from one address are rate limited', async () => {
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await post('avk_' + 'y'.repeat(43), {}, '10.7.7.7')).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429]);
});

test('dashboard, stream and export need the session cookie', async () => {
  const dash = await fetch(`${BASE}/dashboard`, {redirect: 'manual'});
  assert.ok([303, 307, 308].includes(dash.status), String(dash.status));
  assert.equal((await fetch(`${BASE}/api/stream?stream=x`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/export?stream=x`)).status, 401);
});

test('signed-in dashboard renders stored rounds and odds', async () => {
  const t = await makeTracker('Dash test');
  await post(t.key, {stream: 'stream-dash', site: 'https://game.example', rounds: rounds(0, 40, 1.5)});
  const html = await (await fetch(`${BASE}/dashboard`, {headers: {Cookie: `aviator_tracker=${t.key}`}})).text();
  assert.match(html, /Dash test/);
  assert.match(html, /Rounds loaded<\/span><strong>40</);
  assert.match(html, /game&#x27;s built-in odds <!-- -->48\.5%/);
});

test('live stream pushes a round stored after the connection opened', async () => {
  const t = await makeTracker();
  await post(t.key, {stream: 'stream-live', rounds: rounds(0, 2)});
  const [{id: lastId}] = await sql`SELECT max(id)::int AS id FROM rounds WHERE tracker_id = ${t.id}`;
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/stream?stream=stream-live&after=${lastId}`, {headers: {Cookie: `aviator_tracker=${t.key}`}, signal: ctrl.signal});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  setTimeout(() => post(t.key, {stream: 'stream-live', rounds: [{seq: 2, value: 13.37, at: Date.now()}]}), 300);
  const reader = res.body!.getReader();
  let text = '';
  const deadline = Date.now() + 8000;
  while (!/event: rounds/.test(text) || !/\n\n/.test(text.split('event: rounds')[1] ?? '')) {
    if (Date.now() > deadline) break;
    const {value, done} = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  ctrl.abort();
  const data = JSON.parse(/event: rounds\ndata: (.*)\n/.exec(text)![1]);
  assert.deepEqual(data.map((r: {seq: number; value: number}) => [r.seq, r.value]), [[2, 13.37]]);
  // Resuming with Last-Event-ID returns nothing already delivered.
  const id = /id: (\d+)\nevent: rounds/.exec(text)![1];
  const again = await fetch(`${BASE}/api/stream?stream=stream-live`, {headers: {Cookie: `aviator_tracker=${t.key}`, 'Last-Event-ID': id}, signal: AbortSignal.timeout(2500)})
    .then(r => r.text()).catch(e => e.name === 'TimeoutError' ? '' : Promise.reject(e));
  assert.doesNotMatch(again, /event: rounds/);
});

test('export marks missed rounds from sequence jumps and gap flags', async () => {
  const t = await makeTracker();
  await post(t.key, {stream: 'stream-csv', rounds: [...rounds(0, 3), ...rounds(10, 2)]});
  await post(t.key, {stream: 'stream-csv', rounds: [{seq: 12, value: 3, gap: true, at: Date.now()}]});
  const csv = await (await fetch(`${BASE}/api/export?stream=stream-csv`, {headers: {Cookie: `aviator_tracker=${t.key}`}})).text();
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'sequence,multiplier,missed_rounds_before,captured_at');
  assert.deepEqual(lines.slice(1).map(l => l.split(',').slice(0, 3).join(',')), ['0,2,0', '1,2.01,0', '2,2.02,0', '10,2,1', '11,2.01,0', '12,3,1']);
});

test('deleting a tracker removes its rounds and its key', async () => {
  const t = await makeTracker();
  await post(t.key, {stream: 'stream-del', rounds: rounds(0, 5)});
  await sql`DELETE FROM trackers WHERE id = ${t.id}`;
  const [{n}] = await sql`SELECT count(*)::int AS n FROM rounds WHERE tracker_id = ${t.id}`;
  assert.equal(n, 0);
  assert.equal((await post(t.key, {stream: 'stream-del', rounds: rounds(5, 1)}, '10.3.3.3')).status, 401);
});

test('referrer policy keeps the Origin header on form posts (server actions need it)', async () => {
  // "no-referrer" makes browsers send "Origin: null" on form posts, which Next.js rejects.
  assert.equal((await fetch(`${BASE}/`)).headers.get('referrer-policy'), 'same-origin');
});

test('userscript is served to a signed-in browser by cookie, never by a key in the URL', async () => {
  const t = await makeTracker();
  for (const path of ['/api/userscript', '/api/userscript/aviator-streamer.user.js']) {
    const r = await fetch(`${BASE}${path}`, {headers: {Cookie: `aviator_tracker=${t.key}`}});
    assert.equal(r.status, 200, path);
    const js = await r.text();
    assert.match(js, /==UserScript==/);
    assert.ok(js.includes(JSON.stringify(t.key)), 'script carries the key');
    assert.equal((await fetch(`${BASE}${path}`)).status, 401);
    assert.equal((await fetch(`${BASE}${path}?key=${t.key}`)).status, 401, 'key in URL is not accepted');
  }
});
