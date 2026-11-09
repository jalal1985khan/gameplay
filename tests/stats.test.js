const assert = require('assert');
const {test, fairRounds, rng} = require('./harness');
const S = require('../stats.js');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} not within ${eps} of ${b}`);

test('stats: Wilson interval matches the textbook value', () => {
  const [lo, hi] = S.baseRate(Array(50).fill(3).concat(Array(50).fill(1)), 2).ci;
  near(lo, 0.4038, 0.0005); near(hi, 0.5962, 0.0005);
  assert.deepStrictEqual(S.baseRate([], 2).ci, [0, 0]);
});

test('stats: base rate, game odds, break-even and return', () => {
  const b = S.baseRate([1, 2, 3, 1.5], 2);
  assert.strictEqual(b.rate, 0.5);
  near(b.expected, 0.485, 1e-9);
  assert.strictEqual(b.breakEven, 0.5);
  assert.strictEqual(b.returnPer100, 100);
});

test('stats: generated fair rounds follow the game odds', () => {
  const rounds = fairRounds(20000, 3);
  for (const t of [1.5, 2, 5, 10]) near(S.baseRate(rounds, t).rate, 0.97 / t, 0.012, `target ${t}`);
});

test('stats: odds match passes on fair data and flags skewed data', () => {
  // Seed 5 happens to give z = -2.86 at 5x: a genuine 1-in-100 fluke, which is why the popup
  // says to confirm on fresh data. This seed has no fluke at these targets.
  const fair = fairRounds(3000, 8);
  for (const t of [1.5, 2, 3, 5, 10]) assert.notStrictEqual(S.oddsMatch(fair, t).verdict, 'differs', `target ${t}`);
  const skewed = fair.map((v, i) => i % 3 ? v : 1); // A third of rounds forced to lose.
  assert.strictEqual(S.oddsMatch(skewed, 2).verdict, 'differs');
  assert.strictEqual(S.oddsMatch(fair.slice(0, 10), 2).verdict, 'too-few');
});

test('stats: trend checks find nothing in fair data', () => {
  const fair = fairRounds(5000, 7);
  for (const t of S.trendChecks(fair, 2)) assert.notStrictEqual(t.verdict, 'notable', t.label);
});

test('stats: trend checks catch a planted pattern', () => {
  // After a round under 1.5x the next one always reaches 2x.
  const r = rng(11), rounds = [];
  for (let i = 0; i < 2000; i++) rounds.push(rounds.at(-1) < 1.5 ? 2.5 : Math.max(1, Math.floor(0.97 / (1 - r()) * 100) / 100));
  const after = S.trendChecks(rounds, 2).find(t => t.label === 'After a round under 1.5×');
  assert.strictEqual(after.verdict, 'notable');
  assert.strictEqual(after.rate, 1);
});

test('stats: patterns never look back across a break', () => {
  const vals = [1.1, 1.1, 1.1, 3, 1.1, 1.1, 1.1, 3];
  const after3 = gaps => S.trendChecks(vals, 2, gaps).find(t => t.label.startsWith('After 3+')).n;
  assert.strictEqual(after3([]), 2);
  assert.strictEqual(after3([6]), 1);
  assert.strictEqual(after3([2, 6]), 0);
});

test('stats: segments and quality handle breaks, duplicates and bad indexes', () => {
  assert.deepStrictEqual(S.segments([1, 2, 3, 4, 5], [3, 3, 0, 9, 1.5, -1]), [[1, 2, 3], [4, 5]]);
  assert.deepStrictEqual(S.quality([1, 2, 3, 4, 5], [3]), {rounds: 5, breaks: 1, longest: 3});
  assert.deepStrictEqual(S.quality([], []), {rounds: 0, breaks: 0, longest: 0});
});

test('stats: runs test is quiet on fair data and catches streaks and alternation', () => {
  assert.notStrictEqual(S.runsTest(fairRounds(5000, 13), 2).verdict, 'notable');
  const streaky = Array.from({length: 400}, (_, i) => Math.floor(i / 20) % 2 ? 3 : 1.2);
  const s = S.runsTest(streaky, 2);
  assert.strictEqual(s.verdict, 'notable'); assert.ok(s.z < 0);
  const alternating = Array.from({length: 400}, (_, i) => i % 2 ? 3 : 1.2);
  const a = S.runsTest(alternating, 2);
  assert.strictEqual(a.verdict, 'notable'); assert.ok(a.z > 0);
  assert.strictEqual(S.runsTest([1, 1, 1], 2).verdict, 'too-few');
  assert.strictEqual(S.runsTest(Array(100).fill(1), 2).z, 0);
});

test('stats: runs test counts runs per stretch, not across breaks', () => {
  const vals = [3, 3, 1, 1, 3, 3, 1, 1];
  assert.strictEqual(S.runsTest(vals, 2).runs, 4);
  assert.strictEqual(S.runsTest(vals, 2, [4]).runs, 4);
  assert.strictEqual(S.runsTest(vals, 2, [2, 4, 6]).runs, 0); // Each stretch is one outcome only.
});

test('stats: serial correlation is quiet on fair data and catches a linked series', () => {
  assert.notStrictEqual(S.serialCorrelation(fairRounds(5000, 17)).verdict, 'notable');
  const r = rng(19), linked = [1.5];
  for (let i = 1; i < 1000; i++) linked.push(Math.max(1, linked.at(-1) * 0.8 + r() * 1.2));
  const c = S.serialCorrelation(linked);
  assert.strictEqual(c.verdict, 'notable'); assert.ok(c.r > 0.3);
  assert.strictEqual(S.serialCorrelation([2]).verdict, 'too-few');
  assert.strictEqual(S.serialCorrelation(Array(100).fill(2)).r, 0);
  assert.strictEqual(S.serialCorrelation([2, 3, 4, 5], [1, 2, 3]).n, 0);
});

test('stats: plan simulation matches the expected cost and is reproducible', () => {
  const plan = {bet: 100, target: 2, rounds: 50, budget: 2000};
  const a = S.simulatePlan(plan, 5000, rng(23)), b = S.simulatePlan(plan, 5000, rng(23));
  assert.deepStrictEqual(a, b);
  near(a.expectedLoss, 150, 1e-9);
  assert.strictEqual(a.totalWagered, 5000);
  near(a.profitChance, 0.40, 0.06);
  assert.ok(a.bustChance < 0.01);
  assert.ok(a.worst10 <= a.medianEnd);
  const reckless = S.simulatePlan({bet: 500, target: 10, rounds: 50, budget: 1000}, 5000, rng(29));
  assert.ok(reckless.bustChance > 0.5);
});

test('stats: bet log totals, loss limit and chasing warnings', () => {
  const log = [{bet: 100, won: 0}, {bet: 200, won: 0}, {bet: 400, won: 0}];
  const r = S.reviewLog(log, 1000);
  assert.deepStrictEqual([r.net, r.wagered, r.rounds, r.chases], [-700, 700, 3, 2]);
  assert.ok(r.warnings.some(w => w.includes('70%')) === false);
  assert.ok(r.warnings.some(w => w.includes('chasing')));
  assert.ok(S.reviewLog(log, 700).warnings[0].includes('loss limit'));
  assert.ok(S.reviewLog(log, 900).warnings[0].includes('78%'));
  assert.deepStrictEqual(S.reviewLog([{bet: 100, won: 250}], 1000).warnings, []);
});
