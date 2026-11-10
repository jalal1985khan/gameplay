// Analysis of the captured rounds: how they compare with the game's published odds, whether
// anything about them differs from chance, and what a fixed bet would have done on exactly these
// rounds. Everything is computed from real captured rounds; nothing here predicts a round.
const Stats = require('./stats.js');

const RTP = Stats.RTP;
const LADDER = [1.2, 1.5, 2, 3, 5, 10, 20, 50, 100];
const EDGES = [1, 1.2, 1.5, 2, 3, 5, 10, 20, 50, Infinity];
const reach = x => Math.min(1, RTP / x); // Chance a round reaches x.
const round2 = n => Math.round(n * 100) / 100;

// The newest `size` rounds, with the missed-rounds marks moved to match.
function windowed(history, size) {
  const n = history.values.length, start = size > 0 ? Math.max(0, n - size) : 0;
  return {
    values: history.values.slice(start),
    times: history.times.slice(start),
    gaps: history.gaps.map(g => g - start).filter(g => g > 0),
  };
}

function ladder(values) {
  return LADDER.map(target => {
    const b = Stats.baseRate(values, target), m = Stats.oddsMatch(values, target);
    return {target, hits: b.hits, rate: b.rate, ci: b.ci, expected: b.expected, z: m.z, verdict: m.verdict};
  });
}

// Share of rounds that ended in each band, next to the share the game's odds give.
function distribution(values) {
  const n = values.length;
  const bands = EDGES.slice(0, -1).map((lo, i) => {
    const hi = EDGES[i + 1];
    const count = values.filter(v => v >= lo && v < hi).length;
    const expected = (lo === 1 ? 1 : reach(lo)) - (hi === Infinity ? 0 : reach(hi));
    return {lo, hi: hi === Infinity ? null : hi, count, share: n ? count / n : 0, expected};
  });
  // Chi-square goodness of fit against the published odds (8 degrees of freedom; 20.09 = 1%).
  const chi2 = n ? bands.reduce((a, b) => a + (b.count - n * b.expected) ** 2 / (n * b.expected), 0) : 0;
  const enough = n > 0 && bands.every(b => n * b.expected >= 5);
  return {bands, chi2, verdict: !enough ? 'too-few' : chi2 >= 20.09 ? 'differs' : 'matches'};
}

// Runs of rounds in a row that ended under the target, never counted across missed rounds.
function streaks(values, gaps, target) {
  let longest = 0, current = 0;
  for (const seg of Stats.segments(values, gaps)) {
    current = 0;
    for (const v of seg) { current = v < target ? current + 1 : 0; if (current > longest) longest = current; }
  }
  const q = 1 - reach(target);
  return {current, longest, currentChance: q ** current, missChance: q};
}

// Seconds between rounds, from capture times. Rounds stored together (the list as first read)
// share one time and long pauses are not play, so both are left out.
function pace(times) {
  const steps = [];
  for (let i = Math.max(1, times.length - 200); i < times.length; i++) {
    const d = (times[i] - times[i - 1]) / 1000;
    if (d >= 2 && d <= 600) steps.push(d);
  }
  if (steps.length < 5) return {secondsPerRound: null, roundsPerHour: null};
  steps.sort((a, b) => a - b);
  const median = steps[Math.floor(steps.length / 2)];
  return {secondsPerRound: Math.round(median), roundsPerHour: Math.round(3600 / median)};
}

// The same bet on every one of these rounds, cashing out at the target. stopLoss (optional):
// stop betting once down this much, as the tracker would.
function backtest(values, {stake, target, stopLoss = 0}) {
  let net = 0, peak = 0, maxDrawdown = 0, wins = 0, bets = 0, run = 0, longestLosses = 0, stoppedAt = null;
  const curve = [0];
  for (const v of values) {
    if (stopLoss > 0 && -net >= stopLoss) { stoppedAt = bets; break; }
    bets++;
    if (v >= target) { net += stake * (target - 1); wins++; run = 0; }
    else { net -= stake; run++; if (run > longestLosses) longestLosses = run; }
    if (net > peak) peak = net;
    if (peak - net > maxDrawdown) maxDrawdown = peak - net;
    curve.push(round2(net));
  }
  // At most ~300 points for the chart, always keeping the last one.
  const step = Math.max(1, Math.ceil(curve.length / 300));
  const points = [];
  for (let i = 0; i < curve.length; i += step) points.push({i, net: curve[i]});
  if (points.at(-1).i !== curve.length - 1) points.push({i: curve.length - 1, net: curve.at(-1)});
  const wagered = bets * stake;
  return {
    stake, target, bets, wins, losses: bets - wins, wagered, net: round2(net),
    expectedNet: round2(-wagered * (1 - RTP)), // What the game's odds give on this many bets.
    returnShare: wagered ? (wagered + net) / wagered : null,
    maxDrawdown: round2(maxDrawdown), longestLosses, stoppedAt, points,
  };
}

function analyse(history, {target = 2, size = 0, stake = 10, stopLoss = 0} = {}) {
  const w = windowed(history, size);
  const {values, gaps, times} = w;
  return {
    target, size, rounds: values.length,
    from: times.find(t => t > 0) || null, to: times.at(-1) || null,
    quality: Stats.quality(values, gaps),
    base: Stats.baseRate(values, target),
    ladder: ladder(values),
    distribution: distribution(values),
    checks: {
      odds: Stats.oddsMatch(values, target),
      runs: Stats.runsTest(values, target, gaps),
      serial: Stats.serialCorrelation(values, gaps),
      trends: Stats.trendChecks(values, target, gaps),
    },
    streaks: streaks(values, gaps, target),
    pace: pace(times),
    backtest: backtest(values, {stake, target, stopLoss}),
    minCases: Stats.MIN_CASES,
  };
}

// A day's tracked bets in numbers: used live and stored when the day ends.
function sessionStats(bets) {
  let net = 0, peak = 0, maxDrawdown = 0, run = 0, longestLosses = 0, chases = 0, chaseRun = 0, prev = null;
  const equity = [0];
  for (const b of bets) {
    if (b.result !== 'won' && b.result !== 'lost') continue;
    net += b.profit || 0;
    if (net > peak) peak = net;
    if (peak - net > maxDrawdown) maxDrawdown = peak - net;
    if (b.result === 'lost') { run++; if (run > longestLosses) longestLosses = run; } else run = 0;
    // Chasing: a bigger bet right after a lost one.
    if (prev && prev.result === 'lost' && b.stake > prev.stake) { chases++; chaseRun++; } else chaseRun = 0;
    prev = b;
    equity.push(round2(net));
  }
  return {maxDrawdown: round2(maxDrawdown), longestLosses, lossRun: run, chases, chaseRun, equity: equity.slice(-400)};
}

module.exports = {analyse, backtest, distribution, ladder, streaks, pace, windowed, sessionStats, LADDER};
