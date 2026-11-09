// Probability statistics over captured rounds (chronological, oldest first).
// Nothing here predicts a round: it measures how often targets were reached, overall and
// after specific recent patterns, and whether any difference is larger than random noise.
const AviatorStats = (() => {
  const RTP = 0.97; // Published return-to-player of the game.
  const MIN_CASES = 30;
  const NOTABLE_Z = 2.6; // Stricter than 1.96 because several checks run at once.

  // 95% Wilson score interval for a proportion.
  function wilson(hits, n) {
    if (!n) return [0, 0];
    const z = 1.96, p = hits / n, d = 1 + z * z / n;
    const mid = (p + z * z / (2 * n)) / d;
    const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return [Math.max(0, mid - half), Math.min(1, mid + half)];
  }

  function baseRate(values, target) {
    const n = values.length, hits = values.filter(v => v >= target).length;
    const rate = n ? hits / n : 0;
    return {
      n, hits, rate, ci: wilson(hits, n),
      expected: Math.min(1, RTP / target), // Theoretical chance of reaching the target.
      breakEven: 1 / target, // Hit rate needed to not lose money at this target.
      returnPer100: rate * target * 100, // Average amount back per ₹100 bet, from the data.
    };
  }

  // Conditions on the rounds before round i. Each returns true when the pattern held.
  function conditions(target) {
    const streak = (vs, i, k, test) => i >= k && vs.slice(i - k, i).every(test);
    return [
      {label: 'After a round under 1.5×', test: (vs, i) => i >= 1 && vs[i - 1] < 1.5},
      {label: 'After 3+ rounds in a row under 2×', test: (vs, i) => streak(vs, i, 3, v => v < 2)},
      {label: 'After 5+ rounds in a row under 2×', test: (vs, i) => streak(vs, i, 5, v => v < 2)},
      {label: `After a round that reached ${target}×`, test: (vs, i) => i >= 1 && vs[i - 1] >= target},
      {label: 'After a round of 10× or more', test: (vs, i) => i >= 1 && vs[i - 1] >= 10},
      {label: 'When the median of the last 10 rounds was under 2×', test: (vs, i) => i >= 10 && median(vs.slice(i - 10, i)) < 2},
    ];
  }
  function median(xs) {
    const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  const verdict = (n, z) => n < MIN_CASES ? 'too-few' : Math.abs(z) >= NOTABLE_Z ? 'notable' : 'noise';

  // Splits the history at missed-rounds breaks (gaps: indexes where rounds were missed before
  // that value) into stretches of consecutive rounds. Checks never look back across a break.
  function segments(values, gaps = []) {
    const cuts = [0, ...[...new Set(gaps)].filter(g => Number.isInteger(g) && g > 0 && g < values.length).sort((a, b) => a - b), values.length];
    return cuts.slice(0, -1).map((start, j) => values.slice(start, cuts[j + 1]));
  }

  // Whether the captured hit rate agrees with the game's published odds at this target.
  // A large difference points at capture problems (missed or duplicate rounds) first.
  function oddsMatch(values, target) {
    const n = values.length, hits = values.filter(v => v >= target).length, p = Math.min(1, RTP / target);
    const se = Math.sqrt(n * p * (1 - p));
    const z = se ? (hits - n * p) / se : 0;
    return {n, hits, z, verdict: n < MIN_CASES ? 'too-few' : Math.abs(z) >= NOTABLE_Z ? 'differs' : 'matches'};
  }

  // Compare the hit rate after a pattern against the hit rate in all other rounds.
  function trendChecks(values, target, gaps = []) {
    const segs = segments(values, gaps);
    return conditions(target).map(({label, test}) => {
      let n = 0, hits = 0, restN = 0, restHits = 0;
      for (const seg of segs) seg.forEach((v, i) => {
        if (test(seg, i)) { n++; if (v >= target) hits++; }
        else { restN++; if (v >= target) restHits++; }
      });
      const rate = n ? hits / n : 0, restRate = restN ? restHits / restN : 0;
      let z = 0;
      if (n && restN) {
        const pooled = (hits + restHits) / (n + restN);
        const se = Math.sqrt(pooled * (1 - pooled) * (1 / n + 1 / restN));
        z = se ? (rate - restRate) / se : 0;
      }
      return {label, n, hits, rate, restRate, z, verdict: verdict(n, z), ci: wilson(hits, n)};
    });
  }

  // Wald–Wolfowitz runs test on "reached the target", per unbroken stretch, combined.
  // Fewer runs than chance means streaks; more means wins and losses alternate.
  function runsTest(values, target, gaps = []) {
    let n = 0, runs = 0, expected = 0, variance = 0;
    for (const seg of segments(values, gaps)) {
      const m = seg.length, n1 = seg.filter(v => v >= target).length, n2 = m - n1;
      n += m;
      if (!n1 || !n2) continue; // One outcome only: exactly one run, nothing to test.
      let r = 1;
      for (let i = 1; i < m; i++) if ((seg[i] >= target) !== (seg[i - 1] >= target)) r++;
      runs += r;
      expected += 2 * n1 * n2 / m + 1;
      variance += 2 * n1 * n2 * (2 * n1 * n2 - m) / (m * m * (m - 1));
    }
    const z = variance > 0 ? (runs - expected) / Math.sqrt(variance) : 0;
    return {n, runs, expected, z, verdict: verdict(n, z)};
  }

  // Lag-1 correlation of log multipliers within unbroken stretches: does a high round follow a high one?
  function serialCorrelation(values, gaps = []) {
    const xs = [], ys = [];
    for (const seg of segments(values, gaps)) {
      for (let i = 1; i < seg.length; i++) { xs.push(Math.log(seg[i - 1])); ys.push(Math.log(seg[i])); }
    }
    const n = xs.length;
    if (n < 2) return {n, r: 0, z: 0, verdict: 'too-few'};
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    // A series that barely varies leaves only rounding error in sxx/syy, which must not read as r = ±1.
    const r = sxx > 1e-9 * n && syy > 1e-9 * n ? sxy / Math.sqrt(sxx * syy) : 0;
    const z = r * Math.sqrt(n);
    return {n, r, z, verdict: verdict(n, z)};
  }

  // How complete the captured history is.
  function quality(values, gaps = []) {
    const segs = segments(values, gaps);
    return {rounds: values.length, breaks: segs.length - 1, longest: Math.max(0, ...segs.map(s => s.length))};
  }

  // Play a betting plan through many simulated sessions using the game's built-in odds.
  // A session ends early ("busted") when the remaining budget can't cover the next bet.
  function simulatePlan({bet, target, rounds, budget}, sessions = 5000, random = Math.random) {
    const p = Math.min(1, RTP / target), ends = [];
    let busted = 0, profit = 0;
    for (let s = 0; s < sessions; s++) {
      let bal = budget;
      for (let r = 0; r < rounds; r++) {
        if (bal < bet) { busted++; break; }
        bal += random() < p ? bet * (target - 1) : -bet;
      }
      ends.push(bal);
      if (bal > budget) profit++;
    }
    ends.sort((a, b) => a - b);
    return {
      expectedLoss: bet * rounds * (1 - RTP),
      totalWagered: bet * rounds,
      bustChance: busted / sessions,
      profitChance: profit / sessions,
      medianEnd: ends[Math.floor(sessions / 2)],
      worst10: ends[Math.floor(sessions * 0.1)], // 1 in 10 sessions ends at or below this.
    };
  }

  // Review a session's bet log ({bet, won} entries, won = amount returned, 0 on a loss).
  function reviewLog(log, limit) {
    let net = 0, wagered = 0, chases = 0, chaseRun = 0;
    log.forEach((e, i) => {
      net += e.won - e.bet; wagered += e.bet;
      const prev = log[i - 1];
      // Chasing: raising the bet right after a losing round.
      if (prev && prev.won === 0 && e.bet > prev.bet) { chases++; chaseRun++; } else chaseRun = 0;
    });
    const warnings = [];
    if (limit > 0 && -net >= limit) warnings.push(`You've reached your loss limit (₹${limit}). Stop for today.`);
    else if (limit > 0 && -net >= limit * 0.75) warnings.push(`You've lost ${Math.round(-net / limit * 100)}% of your loss limit.`);
    if (chaseRun >= 2) warnings.push('You raised your bet after each of your last losses. That is chasing losses: go back to your planned bet or stop.');
    else if (chases >= 3) warnings.push(`You've raised your bet right after a loss ${chases} times this session.`);
    return {net, wagered, rounds: log.length, chases, warnings};
  }

  return {baseRate, oddsMatch, trendChecks, runsTest, serialCorrelation, quality, segments, simulatePlan, reviewLog, RTP, MIN_CASES, NOTABLE_Z};
})();
if (typeof module !== 'undefined') module.exports = AviatorStats;
