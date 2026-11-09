const assert = require('assert');
const {test} = require('./harness');
const M = require('../match.js');

test('match: empty history takes the whole snapshot, oldest first', () => {
  assert.deepStrictEqual(M.newRounds([], [5, 4, 3, 2, 1]), {fresh: [1, 2, 3, 4, 5], gap: false});
});

test('match: unchanged snapshot adds nothing', () => {
  assert.deepStrictEqual(M.newRounds([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), {fresh: [], gap: false});
});

test('match: new rounds in front are added in order', () => {
  assert.deepStrictEqual(M.newRounds([1, 2, 3, 4, 5], [7, 6, 5, 4, 3]), {fresh: [6, 7], gap: false});
});

test('match: overlap of exactly 3 at the end of the list still matches', () => {
  assert.deepStrictEqual(M.newRounds([1, 2, 3, 4, 5], [9, 8, 7, 6, 5, 4, 3]).fresh, [6, 7, 8, 9]);
});

test('match: overlap of only 2 is treated as a break', () => {
  const r = M.newRounds([1, 2, 3, 4, 5], [10, 9, 8, 7, 6, 5, 4]);
  assert.deepStrictEqual(r, {fresh: [4, 5, 6, 7, 8, 9, 10], gap: true});
});

test('match: no overlap at all is a break keeping the visible rounds', () => {
  assert.deepStrictEqual(M.newRounds([1, 2, 3, 4, 5], [20, 19, 18, 17, 16]), {fresh: [16, 17, 18, 19, 20], gap: true});
});

test('match: a repeated round is caught through the new-element count', () => {
  const history = [2, 1, 1, 1, 1, 1];
  assert.deepStrictEqual(M.newRounds(history, [1, 1, 1, 1, 1]).fresh, [], 'values alone cannot see it');
  assert.deepStrictEqual(M.newRounds(history, [1, 1, 1, 1, 1], 1), {fresh: [1], gap: false});
});

test('match: a new-element count that contradicts the history is ignored', () => {
  // The count says 1 new round, but the rest does not match: fall back to values.
  assert.deepStrictEqual(M.newRounds([1, 2, 3, 4, 5], [7, 6, 5, 4, 3], 1).fresh, [6, 7]);
  assert.deepStrictEqual(M.newRounds([1, 2, 3, 4, 5], [5, 4, 3, 2, 1], 0).fresh, []);
});

test('match: a short history needs only as much overlap as it has', () => {
  assert.deepStrictEqual(M.newRounds([3, 4], [6, 5, 4, 3, 9]), {fresh: [5, 6], gap: false});
});

test('match: a longer (expanded) list matches against what is stored', () => {
  assert.deepStrictEqual(M.newRounds([3, 4, 5, 6, 7], [8, 7, 6, 5, 4, 3, 2, 1, 0.5]).fresh, [8]);
});

test('match: append records the break position and caps the history', () => {
  assert.deepStrictEqual(M.append([1, 2, 3], [], [4, 5], true), {captured: [1, 2, 3, 4, 5], gaps: [3]});
  assert.deepStrictEqual(M.append([], [], [4, 5], true), {captured: [4, 5], gaps: []});
  assert.deepStrictEqual(M.append([1, 2, 3], [], [], true), {captured: [1, 2, 3], gaps: []});
  const big = M.append(Array(4990).fill(1.5), [5, 4000], Array(20).fill(2), true);
  assert.strictEqual(big.captured.length, 5000);
  assert.deepStrictEqual(big.gaps, [3990, 4980]);
});
