// Strategy tester: turns a betting strategy written in plain words into rules, then plays those
// rules on the captured history and on many simulated sessions with the game's real odds.
// Nothing here predicts a round. It shows what a strategy actually does to your money.
const AviatorStrategy = (() => {
  const RTP = 0.97;
  const DEFAULTS = Object.freeze({
    bet: 100, target: 2, budget: 2000, rounds: 100,
    trigger: {kind: 'every'},
    onLoss: {kind: 'same'}, onWin: {kind: 'same'},
    winReset: 0, maxBet: 0, stopLoss: 0, takeProfit: 0,
  });
  const WORDS = {a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10};
  const N = '(\\d+(?:\\.\\d+)?)';
  const COUNT = '(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)';
  const MONEY = `(?:₹|rs\\.?|inr)?\\s*${N}\\s*(?:₹|rs\\b|rupees?\\b|inr\\b)?`;
  const LOSS = '(?:a\\s+|each\\s+|every\\s+|any\\s+)?(?:loss(?:es)?|lose|losing|lost\\s+round|i\\s+lose)';
  const WIN = '(?:a\\s+|each\\s+|every\\s+|any\\s+)?(?:wins?|winning|won\\s+round|i\\s+win)';
  const ACTION = `(double|triple|quadruple|halve|reset|go\\s+back\\s+to\\s+(?:the\\s+)?(?:base|start)|keep\\s+(?:it\\s+|the\\s+bet\\s+)?(?:the\\s+)?same|(?:multiply|times)\\s+(?:it\\s+|the\\s+bet\\s+)?(?:by\\s+)?${N}|(?:increase|raise|add|up)\\s+(?:it\\s+|the\\s+bet\\s+)?(?:by\\s+)?${MONEY}\\s*(%|percent)?|(?:decrease|lower|reduce|cut|subtract)\\s+(?:it\\s+|the\\s+bet\\s+)?(?:by\\s+)?${MONEY}\\s*(%|percent)?)`;
  const STOP = new Set('i im i\'m me my will then and or but so to the a an of on at in it is be with each every per round rounds bet bets betting stake play playing time times always just only start keep game aviator x plane flight session when if after before until strategy my using use go flat then'.split(' '));

  const count = w => WORDS[w] ?? Number(w);

  // Reads one ACTION match into a bet change. base is the starting bet, for "go back to base".
  function action(m) {
    const [, word, mult, upAmt, upPct, downAmt, downPct] = m;
    if (/^double/.test(word)) return {kind: 'multiply', factor: 2};
    if (/^triple/.test(word)) return {kind: 'multiply', factor: 3};
    if (/^quadruple/.test(word)) return {kind: 'multiply', factor: 4};
    if (/^halve/.test(word)) return {kind: 'multiply', factor: 0.5};
    if (/^(reset|go back)/.test(word)) return {kind: 'reset'};
    if (/^keep/.test(word)) return {kind: 'same'};
    if (mult) return {kind: 'multiply', factor: Number(mult)};
    if (upAmt) return upPct ? {kind: 'multiply', factor: 1 + Number(upAmt) / 100} : {kind: 'add', amount: Number(upAmt)};
    if (downAmt) return downPct ? {kind: 'multiply', factor: Math.max(0, 1 - Number(downAmt) / 100)} : {kind: 'add', amount: -Number(downAmt)};
    return null;
  }

  // Parses a plain-words strategy. Returns the rules, what each understood phrase meant, and any
  // words it could not use, so the person can check the reading before trusting the numbers.
  function parse(text) {
    let s = ` ${String(text || '').toLowerCase().replace(/[×✕]/g, 'x').replace(/[’`]/g, "'").replace(/\s+/g, ' ')} `;
    const st = JSON.parse(JSON.stringify(DEFAULTS));
    const understood = [];
    // Applies a regex; on a match, runs fn, records the phrase and blanks it out of the text.
    const take = (re, fn) => {
      const m = s.match(re);
      if (!m) return false;
      if (fn(m) === false) return false;
      understood.push(m[0].trim());
      s = s.slice(0, m.index) + ' '.repeat(m[0].length) + s.slice(m.index + m[0].length);
      return true;
    };
    let dalembert = false;

    // Named systems first; explicit phrases later can still override their parts.
    take(/\b(?:reverse|anti-?)\s*martingale\b|\bparoli\b/, () => { st.onWin = {kind: 'multiply', factor: 2}; st.onLoss = {kind: 'reset'}; st.winReset = 3; })
      || take(/\bmartingale\b/, () => { st.onLoss = {kind: 'multiply', factor: 2}; st.onWin = {kind: 'reset'}; });
    take(/\bd'?\s*alembert\b/, () => { dalembert = true; st.onWin = {kind: 'reset'}; });

    // Stops and limits, before plain amounts so "stop at 500 loss" is not read as a bet or target.
    take(new RegExp(`(?:stop[- ]?loss|loss\\s+limit|max(?:imum)?\\s+loss)\\s*(?:of|at|is|=|:)?\\s*${MONEY}`), m => { st.stopLoss = Number(m[1]); })
      || take(new RegExp(`stop\\s+(?:at\\s+|if\\s+|when\\s+|after\\s+|once\\s+)?(?:i\\s*(?:am|'m)\\s+|i\\s+)?(?:down|losing|lose|lost)\\s*(?:of\\s+|by\\s+)?${MONEY}`), m => { st.stopLoss = Number(m[1]); })
      || take(new RegExp(`stop\\s+(?:at|after|once|when)\\s+(?:a\\s+)?${MONEY}\\s*(?:loss|down|lost)\\b`), m => { st.stopLoss = Number(m[1]); });
    take(new RegExp(`(?:take[- ]?profit|profit\\s+(?:target|goal|limit)|win\\s+(?:target|goal|limit)|target\\s+profit)\\s*(?:of|at|is|=|:)?\\s*${MONEY}`), m => { st.takeProfit = Number(m[1]); })
      || take(new RegExp(`stop\\s+(?:at\\s+|if\\s+|when\\s+|after\\s+|once\\s+)?(?:i\\s*(?:am|'m)\\s+|i\\s+)?(?:up|ahead|winning|win|won|profit(?:\\s+of)?)\\s*(?:of\\s+|by\\s+)?${MONEY}`), m => { st.takeProfit = Number(m[1]); })
      || take(new RegExp(`stop\\s+(?:at|after|once|when)\\s+(?:a\\s+)?${MONEY}\\s*(?:profit|up|ahead|won|win)\\b`), m => { st.takeProfit = Number(m[1]); });
    take(new RegExp(`(?:max(?:imum)?\\s+bet|bet\\s+(?:cap|limit)|table\\s+limit|never\\s+bet\\s+more\\s+than|cap\\s+(?:the\\s+)?bets?\\s+at)\\s*(?:of|at|is|=|:)?\\s*${MONEY}`), m => { st.maxBet = Number(m[1]); });
    take(new RegExp(`(?:budget|bankroll|balance|start(?:ing)?\\s+with)\\s*(?:of|is|=|:)?\\s*${MONEY}`), m => { st.budget = Number(m[1]); });
    take(new RegExp(`(?<!wait\\s)(?<!after\\s)(?:\\bfor|\\bplay|session\\s+of)\\s+${N}\\s+rounds?`), m => { st.rounds = Math.round(Number(m[1])); });

    // Bet changes after a loss or a win, in either word order.
    const change = (outcome, key) =>
      take(new RegExp(`${ACTION}\\s*(?:it\\s+|the\\s+bet\\s+|the\\s+stake\\s+)?(?:after|on|when|if|following)\\s+${outcome}`), m => { const a = action(m); if (!a) return false; st[key] = a; })
      || take(new RegExp(`(?:after|on|when|if|following)\\s+${outcome}\\s*,?\\s*(?:then\\s+|i\\s+)?${ACTION}`), m => { const a = action(m); if (!a) return false; st[key] = a; });
    change(LOSS, 'onLoss');
    change(WIN, 'onWin');
    take(new RegExp(`reset\\s+(?:it\\s+|the\\s+bet\\s+)?after\\s+${COUNT}\\s+wins?(?:\\s+in\\s+a\\s+row)?`), m => { st.winReset = count(m[1]); });

    // When to bet: after a run of low rounds, or after a high round.
    const under = `(?:under|below|less\\s+than|<)\\s*${N}\\s*x?`;
    take(new RegExp(`(?:after|wait\\s+for)\\s+${COUNT}\\s+(?:(?:low|bad|losing)\\s+)?(?:rounds?|flights?|crashes|results?)?\\s*(?:in\\s+a\\s+row\\s+)?${under}(?:\\s+in\\s+a\\s+row)?`), m => { st.trigger = {kind: 'afterLows', count: count(m[1]), below: Number(m[2])}; })
      || take(new RegExp(`(?:after|wait\\s+for)\\s+${COUNT}\\s+(?:(?:low|bad)\\s+(?:rounds?|flights?|crashes)|reds?|blues?)(?:\\s+in\\s+a\\s+row)?`), m => { st.trigger = {kind: 'afterLows', count: count(m[1]), below: 2}; })
      || take(new RegExp(`(?:after|wait\\s+for)\\s+(?:a\\s+|one\\s+)?(?:round\\s+|flight\\s+)?(?:of\\s+|above\\s+|over\\s+|at\\s+least\\s+|>=?\\s*)?${N}\\s*x\\s*(?:or\\s+more|or\\s+higher|\\+)?`), m => { st.trigger = {kind: 'afterHigh', above: Number(m[1])}; })
      || take(/(?:after|wait\s+for)\s+(?:a\s+)?pink/, () => { st.trigger = {kind: 'afterHigh', above: 10}; });

    // Plain amounts last.
    take(new RegExp(`(?:cash\\s*-?\\s*out|exit|collect|withdraw|target)\\s*(?:at|@|of|on)?\\s*${N}\\s*x?`), m => { st.target = Number(m[1]); })
      || take(new RegExp(`(?:at|@)\\s*${N}\\s*x\\b`), m => { st.target = Number(m[1]); })
      || take(new RegExp(`\\b${N}\\s*x\\b`), m => { st.target = Number(m[1]); });
    take(new RegExp(`(?:bet|stake|wager)(?:\\s+amount)?\\s*(?:of|is|=|:)?\\s*${MONEY}`), m => { st.bet = Number(m[1]); })
      || take(new RegExp(`(?:₹|rs\\.?\\s*|inr\\s*)${N}|${N}\\s*(?:rs\\b|rupees?\\b|inr\\b)`), m => { st.bet = Number(m[1] ?? m[2]); });

    if (dalembert) {
      if (st.onLoss.kind === 'same') st.onLoss = {kind: 'add', amount: st.bet};
      if (st.onWin.kind === 'reset') st.onWin = {kind: 'add', amount: -st.bet};
    }
    const ignored = s.replace(/[^a-z0-9.%₹' ]/g, ' ').split(' ').filter(w => w && !STOP.has(w));
    return {strategy: st, understood, ignored, errors: validate(st)};
  }

  function validate(st) {
    const e = [];
    if (!(st.bet > 0)) e.push('The bet must be above 0.');
    if (!(st.target > 1)) e.push('The cash-out target must be above 1×.');
    if (st.target > 1000) e.push('The cash-out target must be 1000× or less.');
    if (!(st.budget >= st.bet)) e.push('The budget must be at least one bet.');
    if (!(st.rounds >= 1 && st.rounds <= 2000)) e.push('A session must be 1 to 2000 rounds.');
    if (st.trigger.kind === 'afterLows' && !(st.trigger.count >= 1 && st.trigger.count <= 50 && st.trigger.below > 1)) e.push('The "after low rounds" rule needs 1 to 50 rounds and a level above 1×.');
    for (const k of ['onLoss', 'onWin']) if (st[k].kind === 'multiply' && !(st[k].factor >= 0 && st[k].factor <= 100)) e.push('A bet multiplier must be between 0 and 100.');
    return e;
  }

  const money = n => `₹${Number(n).toLocaleString(undefined, {maximumFractionDigits: 2})}`;
  const changeText = (c, base) => c.kind === 'multiply' ? (c.factor === 2 ? 'double the bet' : c.factor === 0.5 ? 'halve the bet' : `multiply the bet by ${+c.factor.toFixed(3)}`)
    : c.kind === 'add' ? (c.amount >= 0 ? `raise the bet by ${money(c.amount)}` : `lower the bet by ${money(-c.amount)} (not below ${money(base)})`)
    : c.kind === 'reset' ? `go back to ${money(base)}` : 'keep the same bet';

  // The rules in plain words, so the person can check them.
  function describe(st) {
    const out = [`Start with a bet of ${money(st.bet)} and cash out at ${st.target}×.`];
    out.push(st.trigger.kind === 'afterLows' ? `Only bet after ${st.trigger.count} round${st.trigger.count > 1 ? 's' : ''} in a row under ${st.trigger.below}×; skip other rounds.`
      : st.trigger.kind === 'afterHigh' ? `Only bet right after a round of ${st.trigger.above}× or more; skip other rounds.` : 'Bet every round.');
    out.push(`After a loss: ${changeText(st.onLoss, st.bet)}.`);
    out.push(`After a win: ${changeText(st.onWin, st.bet)}${st.winReset ? `, and go back to ${money(st.bet)} after ${st.winReset} wins in a row` : ''}.`);
    if (st.maxBet) out.push(`Never bet more than ${money(st.maxBet)}.`);
    out.push(`Session: ${money(st.budget)} budget, up to ${st.rounds} rounds${st.stopLoss ? `, stop when down ${money(st.stopLoss)}` : ''}${st.takeProfit ? `, stop when up ${money(st.takeProfit)}` : ''}.`);
    return out;
  }

  function nextBet(st, stake, change) {
    let b = change.kind === 'multiply' ? stake * change.factor : change.kind === 'add' ? stake + change.amount : change.kind === 'reset' ? st.bet : stake;
    b = Math.max(st.bet * (change.kind === 'add' ? 1 : 0), b);
    return Math.round(Math.max(0.01, b) * 100) / 100;
  }

  function wants(st, history) {
    const t = st.trigger, n = history.length;
    if (t.kind === 'afterLows') {
      if (n < t.count) return false;
      for (let i = n - t.count; i < n; i++) if (history[i] >= t.below) return false;
      return true;
    }
    if (t.kind === 'afterHigh') return n > 0 && history[n - 1] >= t.above;
    return true;
  }

  // Plays one session. next() returns the next round's crash point, or undefined when rounds run out.
  // history holds earlier rounds of the same unbroken stretch, for the betting trigger.
  function playSession(st, next, history = []) {
    let bal = st.budget, stake = st.bet, streak = 0, played = 0, bets = 0, wins = 0, wagered = 0;
    let peak = bal, maxDrawdown = 0, biggestBet = 0, lossRun = 0, longestLossRun = 0, end = 'rounds';
    const seen = history.slice(-50);
    while (played < st.rounds) {
      if (st.stopLoss && st.budget - bal >= st.stopLoss) { end = 'stopLoss'; break; }
      if (st.takeProfit && bal - st.budget >= st.takeProfit) { end = 'takeProfit'; break; }
      const bet = wants(st, seen);
      const amount = Math.min(stake, st.maxBet || Infinity);
      if (bet && amount > bal + 1e-9) { end = 'bust'; break; }
      const v = next();
      if (v === undefined) { end = 'data'; break; }
      played++;
      if (bet) {
        bets++; wagered += amount; biggestBet = Math.max(biggestBet, amount);
        if (v >= st.target) {
          wins++; bal += amount * (st.target - 1); lossRun = 0; streak++;
          stake = st.winReset && streak >= st.winReset ? (streak = 0, st.bet) : nextBet(st, amount, st.onWin);
        } else {
          bal -= amount; lossRun++; streak = 0;
          longestLossRun = Math.max(longestLossRun, lossRun);
          stake = nextBet(st, amount, st.onLoss);
        }
        peak = Math.max(peak, bal); maxDrawdown = Math.max(maxDrawdown, peak - bal);
      }
      seen.push(v); if (seen.length > 50) seen.shift();
    }
    return {end, played, bets, wins, wagered, net: bal - st.budget, maxDrawdown, biggestBet, longestLossRun, history: seen};
  }

  function summarize(sessions, budget) {
    const nets = sessions.map(s => s.net).sort((a, b) => a - b), n = sessions.length;
    const sum = k => sessions.reduce((a, s) => a + s[k], 0);
    const bets = sum('bets'), wagered = sum('wagered'), net = sum('net');
    return {
      sessions: n, bets, wins: sum('wins'), wagered, net,
      hitRate: bets ? sum('wins') / bets : 0,
      returnPer100: wagered ? (wagered + net) / wagered * 100 : 100,
      avgNet: n ? net / n : 0,
      aheadChance: n ? sessions.filter(s => s.net > 0).length / n : 0,
      bustChance: n ? sessions.filter(s => s.end === 'bust').length / n : 0,
      stopLossChance: n ? sessions.filter(s => s.end === 'stopLoss').length / n : 0,
      takeProfitChance: n ? sessions.filter(s => s.end === 'takeProfit').length / n : 0,
      medianNet: n ? nets[Math.floor(n / 2)] : 0,
      worst10: n ? nets[Math.floor(n * 0.1)] : 0,
      worst: n ? nets[0] : 0,
      best: n ? nets[n - 1] : 0,
      maxDrawdown: Math.max(0, ...sessions.map(s => s.maxDrawdown)),
      biggestBet: Math.max(0, ...sessions.map(s => s.biggestBet)),
      longestLossRun: Math.max(0, ...sessions.map(s => s.longestLossRun)),
      budget,
    };
  }

  // Plays the strategy through the captured history as back-to-back sessions. A new session starts
  // at each missed-rounds break, and the betting trigger never looks back across one.
  function backtest(st, values, gaps = []) {
    const cuts = [0, ...[...new Set(gaps)].filter(g => Number.isInteger(g) && g > 0 && g < values.length).sort((a, b) => a - b), values.length];
    const sessions = [];
    for (let j = 0; j < cuts.length - 1; j++) {
      let i = cuts[j], history = [];
      const stop = cuts[j + 1];
      while (i < stop) {
        const s = playSession(st, () => (i < stop ? values[i++] : undefined), history);
        history = s.history;
        // A session cut short by the end of the data with no bets placed adds nothing.
        if (s.end !== 'data' || s.bets) sessions.push(s);
        if (s.end === 'data') break;
        if (!s.played) break; // Busted or stopped before playing: avoid looping forever.
      }
    }
    return summarize(sessions, st.budget);
  }

  // Fair crash point with the game's odds: P(X >= x) = 0.97 / x, two decimals, never below 1.00.
  const crash = random => Math.max(1, Math.floor(RTP / (1 - random()) * 100) / 100);

  function simulate(st, sessions = 2000, random = Math.random) {
    const out = [];
    for (let k = 0; k < sessions; k++) {
      // Warm-up rounds so a trigger like "after 3 rounds under 2×" can fire from the first round.
      const warm = Array.from({length: 10}, () => crash(random));
      out.push(playSession(st, () => crash(random), warm));
    }
    return summarize(out, st.budget);
  }

  // A plain-words verdict from the simulated results.
  function verdict(sim) {
    const notes = [];
    const cost = 100 - sim.returnPer100;
    notes.push(`Every ₹100 this strategy bets comes back as about ₹${sim.returnPer100.toFixed(1)} on average: a cost of ₹${cost.toFixed(1)} per ₹100, close to the ~3% the game keeps from any strategy (the rest is random variation).`);
    if (sim.aheadChance >= 0.6 && sim.avgNet < 0) notes.push(`It finishes ahead in ${(sim.aheadChance * 100).toFixed(0)}% of sessions, yet loses money overall: the losing sessions are much bigger than the winning ones. A high "win rate" is not an edge.`);
    if (sim.bustChance >= 0.05) notes.push(`${(sim.bustChance * 100).toFixed(1)}% of sessions run out of money for the next bet, because the bet grows faster than the budget can cover.`);
    if (sim.biggestBet >= sim.budget * 0.25) notes.push(`Bets grow to ₹${Math.round(sim.biggestBet).toLocaleString()} at worst, which is ${Math.round(sim.biggestBet / sim.budget * 100)}% of the budget on one round.`);
    return notes;
  }

  return {parse, describe, validate, playSession, backtest, simulate, verdict, crash, DEFAULTS, RTP};
})();
if (typeof module !== 'undefined') module.exports = AviatorStrategy;
