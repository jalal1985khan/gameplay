'use strict';
// The autopilot's rules, shared by the live autopilot and the replay over captured rounds, so
// both decide the same way. Nothing here predicts a round: the rules look only at what was won
// and lost so far.
const round2 = n => Math.round(n * 100) / 100;

// The bet and cash-out of the next round. debt: losses still to be won back.
// "range": the same bet, the cash-out raised just enough for one win to cover the open losses,
// between the lowest and highest set. "single" with win-back: a bigger bet instead, never above
// the largest bet, the room left before the loss limit, or the funds.
function planNext(a, base, debt, room = Infinity, funds = Infinity) {
  let stake = base, target = a.plan === 'single' ? a.target : a.minTarget;
  if (a.plan === 'range' && debt > 0) {
    const need = 1 + (debt + base * (a.minTarget - 1)) / base;
    target = Math.min(a.maxTarget, Math.max(a.minTarget, Math.ceil(need * 100 - 1e-6) / 100));
  } else if (a.plan === 'single' && a.recover && debt > 0) {
    target = a.recoverTarget;
    stake = Math.max(base, Math.min(Math.ceil((debt + base * (a.target - 1)) / (target - 1)), a.maxBet, room, funds));
  }
  return {stake, target};
}

// Why the day ends now, or null. d: {net, rounds, ms, streak, peak, roundCost}.
function stopReason(a, d) {
  if (d.net <= -a.lossLimit) return {kind: 'loss', text: `the loss limit of ₹${a.lossLimit} was reached`};
  // Keep the next full stake inside the loss allowance. Stopping at equality also leaves
  // room for the game's Auto Play/capture delay to cancel a queued wager.
  if (d.net - d.roundCost <= -a.lossLimit) return {kind: 'loss', text: `the next bet could reach the loss limit of ₹${a.lossLimit}`};
  if (d.net >= a.profitTarget) return {kind: 'profit', text: `the profit target of ₹${a.profitTarget} was reached`};
  if (a.protect && d.peak >= a.profitTarget / 2 && d.net <= d.peak / 2) return {kind: 'kept', text: `the profit was falling back from ₹${round2(d.peak)}, so ₹${round2(d.net)} was kept`};
  if (d.rounds >= a.maxRounds) return {kind: 'rounds', text: `${a.maxRounds} rounds were played`};
  if (d.ms >= a.maxMinutes * 60000) return {kind: 'minutes', text: `${a.maxMinutes} minutes were played`};
  if (d.streak >= a.lossStreak && a.lossAction === 'stop') return {kind: 'streak', text: `${d.streak} losses in a row`};
  return null;
}

// One day of the autopilot played over rounds that already happened, from values[start].
// Returns {net, rounds, kind}, or null when the rounds ran out before the day ended.
function replayDay(values, a, base, start, {times = [], gaps = []} = {}) {
  const startedAt = times[start];
  let previous = start;
  const rider = a.plan === 'split' ? a.riderBet : 0;
  let net = 0, rounds = 0, streak = 0, debt = 0, peak = 0, i = start;
  let {stake, target} = planNext(a, base, 0);
  const first = stopReason(a, {net, rounds, ms: 0, streak, peak, roundCost: base + rider});
  if (first) return {net, rounds, kind: first.kind};
  while (i < values.length) {
    // A replay day cannot bridge unknown rounds, even when a pause skipped over them.
    if (gaps.some(g => g > previous && g <= i)) return null;
    const elapsed = startedAt > 0 && times[i] > 0 ? Math.max(0, times[i] - startedAt) : 0;
    const before = stopReason(a, {net, rounds, ms: elapsed, streak, peak, roundCost: stake + rider});
    if (before) return {net, rounds, kind: before.kind};
    previous = i;
    const v = values[i++];
    const result = round2((v >= target ? stake * (target - 1) : -stake) + (rider ? (v >= a.maxTarget ? rider * (a.maxTarget - 1) : -rider) : 0));
    net = round2(net + result);
    rounds++;
    streak = result < 0 ? streak + 1 : 0;
    debt = round2(Math.max(0, debt - result));
    peak = Math.max(peak, net);
    const next = planNext(a, base, debt, Math.floor(a.lossLimit + net));
    const stop = stopReason(a, {net, rounds, ms: 0, streak, peak, roundCost: next.stake + rider});
    if (stop) return {net, rounds, kind: stop.kind};
    if (streak >= a.lossStreak) { i += a.pauseRounds; streak = 0; } // Sits these rounds out.
    else if (next.stake !== stake || next.target !== target) i += 1; // Changing the bet takes a round.
    ({stake, target} = next);
  }
  return null;
}

// Many such days, each starting at a different captured round, summed up.
function replaySummary(values, a, base, options = {}) {
  const step = Math.max(5, Math.floor(values.length / 300));
  const days = [];
  for (let s = 0; s < values.length; s += step) { const d = replayDay(values, a, base, s, options); if (d) days.push(d); }
  if (!days.length) return {days: 0};
  const nets = days.map(d => d.net).sort((x, y) => x - y);
  const share = kinds => days.filter(d => kinds.includes(d.kind)).length / days.length;
  return {days: days.length, profit: share(['profit']), kept: share(['kept']), loss: share(['loss']), other: share(['rounds', 'minutes', 'streak']),
    average: round2(nets.reduce((x, y) => x + y, 0) / nets.length), median: nets[Math.floor(nets.length / 2)], worst: nets[0], best: nets.at(-1),
    rounds: Math.round(days.reduce((x, d) => x + d.rounds, 0) / days.length)};
}

// Settings worked out from two numbers: the day's budget and the most the person accepts to lose.
// Small equal bets (20 of them fit in the loss limit, and never more than 1% of the budget), a
// steady 1.3× cash-out (no chasing by raising the target or stake), a profit target of half the
// loss limit, and a good day protected once it is half way there. This raises the per-bet hit
// rate, not the expected return: the game still has a house edge and no strategy guarantees profit.
function autoSettings(budget, loss) {
  budget = Number(budget); loss = Number(loss);
  if (!(budget >= 100) || !(loss >= 20)) return {error: 'Enter a budget of at least ₹100 and a loss limit of at least ₹20.'};
  if (loss > budget) return {error: 'The loss limit cannot be more than the budget.'};
  const bet = Math.max(1, Math.min(Math.floor(loss / 20), Math.floor(budget / 100)));
  return {settings: {lossLimit: Math.round(loss), profitTarget: Math.max(1, Math.round(loss / 2)), betMode: 'fixed', betValue: bet, plan: 'single', target: 1.3, minTarget: 1.5, maxTarget: 3,
    maxRounds: 100, maxMinutes: 60, lossStreak: 4, lossAction: 'pause', pauseRounds: 3, recover: false, protect: true}};
}

module.exports = {planNext, stopReason, replayDay, replaySummary, autoSettings};
