import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {checkRound, crashFromHash, sha512Hex} from '../lib/fair.ts';
import {drift} from '../lib/drift.ts';
import {gapIndexes, parseMultipliersText} from '../lib/rounds.ts';
import {MAX_BATCH, parseBatch} from '../lib/validate.ts';
import AviatorStats from '../lib/stats.ts';
import AviatorStrategy from '../lib/strategy.ts';
import {generateBookmarkletCode, generateUserscript} from '../lib/client-streamer.ts';

// Deterministic fair crash points, same generator as the extension's tests.
function rng(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const fair = (n: number, seed = 1) => { const r = rng(seed); return Array.from({length: n}, () => Math.max(1, Math.floor(0.97 / (1 - r()) * 100) / 100)); };

const NOW = Date.UTC(2026, 10, 8);
const round = (seq: number, extra = {}) => ({seq, value: 2.5, at: NOW - 1000, ...extra});

test('shared stats are an exact copy of the extension\'s stats.js', () => {
  const rootFile = new URL('../../stats.js', import.meta.url);
  if (existsSync(rootFile)) {
    assert.equal(readFileSync(new URL('../lib/shared/stats.cjs', import.meta.url), 'utf8'), readFileSync(rootFile, 'utf8'));
  }
  assert.equal(AviatorStats.RTP, 0.97);
});

test('shared strategy is bundled and matches root strategy.js if present', () => {
  const rootFile = new URL('../../strategy.js', import.meta.url);
  if (existsSync(rootFile)) {
    assert.equal(readFileSync(new URL('../lib/shared/strategy.cjs', import.meta.url), 'utf8'), readFileSync(rootFile, 'utf8'));
  }
  assert.equal(AviatorStrategy.RTP, 0.97);
  const p = AviatorStrategy.parse('Bet 50 at 2x double after a loss');
  assert.equal(p.strategy.bet, 50);
  assert.equal(p.strategy.target, 2);
  assert.equal(p.strategy.onLoss.kind, 'multiply');
});

test('parseBatch accepts a valid batch and normalises it', () => {
  const r = parseBatch({stream: 'abcdef12-3456', site: 'https://game.example/aviator?x=1', rounds: [round(0), round(1, {value: 1.234, gap: true})]}, NOW);
  assert.ok(r.ok);
  assert.equal(r.batch.site, 'https://game.example');
  assert.deepEqual(r.batch.rounds.map(x => [x.seq, x.value, x.gap]), [[0, 2.5, false], [1, 1.23, true]]);
});

test('parseBatch rejects bad input with a reason', () => {
  const bad: [unknown, RegExp][] = [
    [null, /JSON object/],
    [{stream: 'x', rounds: [round(0)]}, /stream/],
    [{stream: 'abcdefgh', site: 'javascript:alert(1)', rounds: [round(0)]}, /site/],
    [{stream: 'abcdefgh', rounds: []}, /non-empty/],
    [{stream: 'abcdefgh', rounds: Array.from({length: MAX_BATCH + 1}, (_, i) => round(i))}, /at most/],
    [{stream: 'abcdefgh', rounds: [round(-1)]}, /seq/],
    [{stream: 'abcdefgh', rounds: [round(0, {value: 0.5})]}, /value/],
    [{stream: 'abcdefgh', rounds: [round(0, {value: '2'})]}, /value/],
    [{stream: 'abcdefgh', rounds: [round(0, {gap: 1})]}, /gap/],
    [{stream: 'abcdefgh', rounds: [round(0, {at: NOW + 3600000})]}, /at/],
  ];
  for (const [body, why] of bad) {
    const r = parseBatch(body, NOW);
    assert.ok(!r.ok, JSON.stringify(body)?.slice(0, 80));
    assert.match(r.error, why);
  }
});

test('gapIndexes finds marked gaps and sequence jumps', () => {
  assert.deepEqual(gapIndexes([{seq: 0, gap: false}, {seq: 1, gap: false}, {seq: 2, gap: true}, {seq: 5, gap: false}, {seq: 6, gap: false}]), [2, 3]);
});

test('parseMultipliersText parses freeform and CSV multipliers', () => {
  // Comma-separated with x and spaces, newest-first reversed
  const parsed1 = parseMultipliersText('1.05x, 2.30, 10.00x', 'newest-first');
  assert.deepEqual(parsed1.map(p => p.value), [10, 2.3, 1.05]);

  // Oldest-first preservation
  const parsed2 = parseMultipliersText('1.05, 2.30, 10.00', 'oldest-first');
  assert.deepEqual(parsed2.map(p => p.value), [1.05, 2.3, 10]);

  // With gap indicator
  const parsed3 = parseMultipliersText('2.15\ngap\n1.80', 'oldest-first');
  assert.deepEqual(parsed3, [{value: 2.15, gap: false}, {value: 1.8, gap: true}]);

  // CSV with header
  const csv = 'seq,multiplier,gap\n0,1.25,false\n1,3.50,true';
  const parsedCsv = parseMultipliersText(csv, 'oldest-first');
  assert.deepEqual(parsedCsv, [{value: 1.25, gap: false}, {value: 3.5, gap: true}]);
});

test('client-streamer generates valid bookmarklet and userscript code', () => {
  const bm = generateBookmarkletCode('https://my-tracker.example', 'avk_testkey123');
  assert.ok(bm.startsWith('javascript:'));
  assert.ok(decodeURIComponent(bm).includes('https://my-tracker.example'));
  assert.ok(decodeURIComponent(bm).includes('avk_testkey123'));

  const us = generateUserscript('https://my-tracker.example', 'avk_testkey123');
  assert.ok(us.includes('// ==UserScript=='));
  assert.ok(us.includes('https://my-tracker.example'));
  assert.ok(us.includes('avk_testkey123'));
});

test('drift stays quiet on fair rounds', () => {
  for (const seed of [1, 2, 3]) {
    const d = drift(fair(3000, seed), [], 2);
    assert.equal(d.status, 'ok', `seed ${seed}: ${JSON.stringify(d.alarms)}`);
    assert.ok(Math.abs(d.expected - 0.485) < 1e-9);
  }
});

test('drift alarms when captured rounds are skewed, in the right direction', () => {
  // Every round under 2× counted twice, as a duplicating capture bug would.
  const skewed = fair(1500, 4).flatMap(v => v < 2 ? [v, v] : [v]);
  const d = drift(skewed, [], 2);
  assert.equal(d.status, 'alarm');
  assert.equal(d.alarms.at(-1)!.direction, 'low');
});

test('drift reports too-few and resets at breaks', () => {
  assert.equal(drift(fair(20), [], 2).status, 'too-few');
  const d = drift([...Array(30).fill(1), ...fair(500, 9)], [30], 2);
  assert.equal(d.alarms.filter(a => a.index >= 30).length, 0);
});

test('sha512Hex matches the known test vector', async () => {
  assert.equal(await sha512Hex('abc'), 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
});

test('crashFromHash follows P(X >= x) = 0.97 / x', () => {
  assert.equal(crashFromHash('0000000000000'), 1);
  assert.equal(crashFromHash('8000000000000'), 1.94);
  const r = rng(5);
  const xs = Array.from({length: 20000}, () => crashFromHash(Math.floor(r() * 2 ** 52).toString(16).padStart(13, '0')));
  const share = xs.filter(x => x >= 2).length / xs.length;
  assert.ok(Math.abs(share - 0.485) < 0.015, String(share));
});

test('checkRound compares the hash and the result', async () => {
  const hash = await sha512Hex('serverABC' + 'c1c2c3');
  const ok = await checkRound({serverSeed: ' serverABC ', clientSeeds: ['c1', 'c2', 'c3'], shownHash: hash.toUpperCase(), shownResult: crashFromHash(hash)});
  assert.equal(ok.hashMatches, true);
  assert.equal(ok.resultMatches, true);
  const bad = await checkRound({serverSeed: 'serverABC', clientSeeds: ['c1', 'c3', 'c2'], shownHash: hash});
  assert.equal(bad.hashMatches, false);
  assert.equal(bad.resultMatches, null);
});
