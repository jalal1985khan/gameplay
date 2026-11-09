const assert = require('assert');
const {test, fairRounds, rng} = require('./harness');
const T = require('../strategy.js');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} not within ${eps} of ${b}`);

test('strategy: parses a full plain-words strategy', () => {
  const p = T.parse('Bet ₹50 at 1.5x after 3 rounds under 2x, double after a loss, stop loss 1000, stop when up 400, budget 5000, for 200 rounds, max bet 800');
  const s = p.strategy;
  assert.strictEqual(s.bet, 50); assert.strictEqual(s.target, 1.5);
  assert.deepStrictEqual(s.trigger, {kind: 'afterLows', count: 3, below: 2});
  assert.deepStrictEqual(s.onLoss, {kind: 'multiply', factor: 2});
  assert.strictEqual(s.stopLoss, 1000); assert.strictEqual(s.takeProfit, 400);
  assert.strictEqual(s.budget, 5000); assert.strictEqual(s.rounds, 200); assert.strictEqual(s.maxBet, 800);
  assert.deepStrictEqual(p.ignored, []); assert.deepStrictEqual(p.errors, []);
});

test('strategy: named systems and phrasing variants', () => {
  const m = T.parse('Martingale at 3x bet 10').strategy;
  assert.deepStrictEqual([m.onLoss, m.onWin, m.target, m.bet], [{kind: 'multiply', factor: 2}, {kind: 'reset'}, 3, 10]);
  const r = T.parse('reverse martingale bet 20').strategy;
  assert.deepStrictEqual([r.onWin, r.onLoss, r.winReset], [{kind: 'multiply', factor: 2}, {kind: 'reset'}, 3]);
  const d = T.parse("D'Alembert at 2x, bet ₹20").strategy;
  assert.deepStrictEqual([d.onLoss, d.onWin], [{kind: 'add', amount: 20}, {kind: 'add', amount: -20}]);
  assert.deepStrictEqual(T.parse('after a loss increase the bet by 50%').strategy.onLoss, {kind: 'multiply', factor: 1.5});
  assert.deepStrictEqual(T.parse('triple on loss').strategy.onLoss, {kind: 'multiply', factor: 3});
  assert.deepStrictEqual(T.parse('raise by 25 after a loss').strategy.onLoss, {kind: 'add', amount: 25});
  assert.deepStrictEqual(T.parse('wait for 4 reds').strategy.trigger, {kind: 'afterLows', count: 4, below: 2});
  assert.deepStrictEqual(T.parse('after a 10x bet 100 at 5x').strategy.trigger, {kind: 'afterHigh', above: 10});
  assert.strictEqual(T.parse('cash out at 1.2x').strategy.target, 1.2);
});

test('strategy: reports words it could not use, and invalid rules', () => {
  assert.deepStrictEqual(T.parse('fibonacci at 2x').ignored, ['fibonacci']);
  assert.ok(T.parse('bet 5000 budget 100').errors.length);
  assert.ok(T.parse('cash out at 1x').errors.length);
});

test('strategy: a session follows the rules exactly', () => {
  const st = T.parse('martingale at 2x bet 10 budget 100 for 10 rounds').strategy;
  const rounds = [1.5, 1.2, 3, 1, 1, 1, 1];
  let i = 0;
  const s = T.playSession(st, () => rounds[i++]);
  // Bets 10, 20 lose; 40 wins (+40) → net +10; then 10, 20, 40 lose (balance 40); next bet 80 > 40 → out of money.
  assert.strictEqual(s.end, 'bust');
  assert.strictEqual(s.bets, 6); assert.strictEqual(s.wins, 1);
  assert.strictEqual(s.net, -60); assert.strictEqual(s.biggestBet, 40); assert.strictEqual(s.longestLossRun, 3);
});

test('strategy: trigger, max bet, stop-loss and take-profit', () => {
  const play = (text, rounds) => { let i = 0; return T.playSession(T.parse(text).strategy, () => rounds[i++]); };
  // Bets only on the round after three rounds under 2x.
  const t = play('bet 10 at 2x after 3 rounds under 2x for 6 rounds', [1, 1, 1, 5, 1, 1]);
  assert.strictEqual(t.bets, 1); assert.strictEqual(t.net, 10);
  assert.strictEqual(play('martingale bet 10 at 2x max bet 30 for 5 rounds', [1, 1, 1, 1, 1]).biggestBet, 30);
  assert.strictEqual(play('bet 10 at 2x stop loss 30 for 10 rounds', Array(10).fill(1)).end, 'stopLoss');
  assert.strictEqual(play('bet 10 at 2x stop when up 20 for 10 rounds', Array(10).fill(3)).end, 'takeProfit');
});

test('strategy: backtest splits sessions and never looks across a break', () => {
  const st = T.parse('bet 10 at 2x after 2 rounds under 2x for 100 rounds').strategy;
  const vals = [1, 1, 3, 1, 1, 3];
  assert.strictEqual(T.backtest(st, vals).bets, 2);
  // Break before index 4: the second "two lows" now straddles it, so only one bet.
  const b = T.backtest(st, vals, [4]);
  assert.strictEqual(b.bets, 1);
  assert.strictEqual(T.backtest(st, []).sessions, 0);
});

test('strategy: simulated crash points follow the game odds', () => {
  const r = rng(5), xs = Array.from({length: 20000}, () => T.crash(r));
  for (const t of [1.5, 2, 5]) near(xs.filter(x => x >= t).length / xs.length, 0.97 / t, 0.012, `target ${t}`);
});

test('strategy: no strategy beats the house edge', () => {
  for (const text of ['flat bet 100 at 2x', 'martingale bet 10 at 2x', 'reverse martingale bet 20', "d'alembert bet 20 at 2x", 'bet 100 at 2x after 3 rounds under 2x', 'bet 100 at 1.2x']) {
    const sim = T.simulate(T.parse(text).strategy, 3000, rng(9));
    assert.ok(sim.returnPer100 < 100, `${text}: ${sim.returnPer100}`);
    near(sim.returnPer100, 97, 2.5, text);
  }
});

test('strategy: Martingale wins most sessions but loses money, and the verdict says so', () => {
  const sim = T.simulate(T.parse('martingale bet 10 at 2x budget 2000').strategy, 3000, rng(3));
  assert.ok(sim.aheadChance > 0.5 && sim.avgNet < 0);
  const v = T.verdict(sim).join(' ');
  assert.match(v, /not an edge/);
  assert.match(v, /run out of money/);
});

test('strategy: backtest on fair history also lands near the house edge', () => {
  const bt = T.backtest(T.parse('flat bet 10 at 2x budget 100000 for 2000 rounds').strategy, fairRounds(20000, 4));
  near(bt.returnPer100, 97, 2.5);
});

test('strategy: "wait for N rounds under X" is a trigger, not a session length', () => {
  const s = T.parse('Wait for 3 rounds under 2x, then bet ₹100 at 2x').strategy;
  assert.deepStrictEqual(s.trigger, {kind: 'afterLows', count: 3, below: 2});
  assert.strictEqual(s.rounds, 100);
  assert.strictEqual(T.parse('bet 100 at 2x after 2 rounds below 1.5x for 50 rounds').strategy.rounds, 50);
});
