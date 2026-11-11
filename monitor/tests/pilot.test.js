'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {planNext, stopReason, replayDay, replaySummary, autoSettings} = require('../lib/pilot.js');

const base = {lossLimit: 100, profitTarget: 50, betMode: 'fixed', betValue: 5, target: 2, maxRounds: 100, maxMinutes: 60, lossStreak: 4, lossAction: 'pause', pauseRounds: 3,
  recover: false, recoverTarget: 2, maxBet: 40, plan: 'single', minTarget: 1.5, maxTarget: 3, riderBet: 5, protect: false};

test('quick setup uses small fixed bets, a steady high-hit-rate target, and a protected day', () => {
  const {settings} = autoSettings(1000, 100);
  assert.deepEqual([settings.lossLimit, settings.profitTarget, settings.betValue, settings.plan, settings.target, settings.recover, settings.protect], [100, 50, 5, 'single', 1.3, false, true]);
  assert.deepEqual(planNext(settings, settings.betValue, 20), {stake: 5, target: 1.3}, 'a loss does not raise the stake or cash-out target');
  assert.equal(autoSettings(200, 100).settings.betValue, 2, 'never more than 1% of the budget');
  assert.match(autoSettings(1000, 2000).error, /cannot be more than the budget/);
  assert.match(autoSettings(50, 10).error, /at least/);
});

test('the next bet: cash-out raised within the range, or the bet raised within its caps', () => {
  const range = {...base, plan: 'range'};
  assert.deepEqual(planNext(range, 5, 0), {stake: 5, target: 1.5});
  assert.deepEqual(planNext(range, 5, 5), {stake: 5, target: 2.5});
  assert.deepEqual(planNext(range, 5, 50), {stake: 5, target: 3}, 'held at the highest');
  const raise = {...base, recover: true};
  assert.deepEqual(planNext(raise, 5, 5), {stake: 10, target: 2});
  assert.deepEqual(planNext(raise, 5, 500), {stake: 40, target: 2}, 'held at the largest bet');
  assert.deepEqual(planNext(raise, 5, 500, 12), {stake: 12, target: 2}, 'held at the room before the loss limit');
});

test('the day ends at the first limit; a good day is kept when it falls back', () => {
  const d = {net: 0, rounds: 0, ms: 0, streak: 0, peak: 0, roundCost: 5};
  assert.equal(stopReason(base, d), null);
  assert.equal(stopReason(base, {...d, net: -100}).kind, 'loss');
  assert.equal(stopReason(base, {...d, net: -95}).kind, 'loss', 'one more full bet could reach the limit');
  assert.equal(stopReason(base, {...d, net: -94}), null, 'one full bet still fits below the limit');
  assert.equal(stopReason(base, {...d, net: 50}).kind, 'profit');
  assert.equal(stopReason(base, {...d, rounds: 100}).kind, 'rounds');
  assert.equal(stopReason({...base, protect: true}, {...d, net: 12, peak: 30}).kind, 'kept');
  assert.equal(stopReason({...base, protect: true}, {...d, net: 20, peak: 30}), null);
  assert.equal(stopReason(base, {...d, net: 12, peak: 30}), null, 'only when switched on');
});

test('a replayed day follows the same rules, and the summary adds the days up', () => {
  // Ten wins at 2× with ₹5: +50, the profit target.
  assert.deepEqual(replayDay(Array(20).fill(2.5), base, 5, 0), {net: 50, rounds: 10, kind: 'profit'});
  // Only losses: stops after 19 bets of ₹5, before the 20th would reach the limit.
  const lost = replayDay(Array(200).fill(1.1), base, 5, 0);
  assert.deepEqual([lost.net, lost.kind], [-95, 'loss']);
  assert.equal(replayDay([1.1, 1.1], base, 5, 0), null, 'the rounds ran out before the day ended');
  const sum = replaySummary(Array(400).fill(2.5), base, 5);
  assert.deepEqual([sum.profit, sum.loss, sum.average, sum.worst], [1, 0, 50, 50]);
  // Split: ₹5 at 1.5× wins 2.5, the ₹5 rider to 3× loses 5, on every round of 2×.
  const split = replayDay(Array(200).fill(2), {...base, plan: 'split'}, 5, 0);
  assert.equal(split.kind, 'loss');
});
