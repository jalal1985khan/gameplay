// Aviator Live Monitor: a small local server with one page. You enter the game URL and click
// Start live capture; it opens the game in a real browser window where you log in as usual,
// reads each finished round from the game's results list, and streams it to the monitor page.
// It listens on this computer only (127.0.0.1) and never reads or stores game logins. To share it,
// a web server in front passes requests on under MONITOR_PUBLIC_HOST; that works only once
// accounts exist (node users.js add ...), and everyone then has to sign in.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const AviatorMatch = require('./lib/match.js');
const Analysis = require('./lib/analysis.js');
const {createStore, atomicWrite} = require('./lib/store.js');
const {createAuth} = require('./lib/auth.js');

// Rounds kept in memory for the page and the analysis; the log on disk keeps every round.
const MAX_ROUNDS = 50000;
// Defaults for the settings popup. pauseRounds: after a loss the bet button hides for this many
// rounds. stopLossShare: the day ends once this share of the budget is lost.
// remindMinutes: a reminder once capture has been running this long (0 = off).
const DEFAULT_SETTINGS = {pauseRounds: 3, stopLossShare: 0.25, alarmSound: true, remindMinutes: 60};
const STOP_LOSS_CHOICES = [0.1, 0.25, 0.5, 1];
const REMIND_CHOICES = [0, 30, 60, 120];
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC = {'/analysis.js': 'text/javascript; charset=utf-8'};
const CAPTURE_SCRIPT = path.join(__dirname, 'lib', 'capture.js');
const STAY_VISIBLE_SCRIPT = path.join(__dirname, 'lib', 'stay-visible.js');
// Chrome slows or freezes pages in hidden tabs and covered windows; the game must keep running.
const KEEP_RUNNING_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
];
const PAGE = path.join(__dirname, 'public', 'index.html');
const LOGIN_PAGE = path.join(__dirname, 'public', 'login.html');

function createMonitor({
  port = 4321,
  headless = false,
  dataDir = path.join(__dirname, 'data'),
  profileDir = path.join(__dirname, 'browser-profile'),
  launch = null, // For tests: a function returning a Playwright browser context.
  gameWindowPort = 0, // Where a noVNC viewer of the game window listens on this computer (0 = none).
  publicHost = '', // The name the monitor is shared under (e.g. monitor.example.com), behind a web server.
  staleMs = 180000, // Live, but the results list unread for this long: the game has stopped updating.
} = {}) {
  const store = createStore(dataDir, MAX_ROUNDS);
  // Captured rounds, oldest first; gaps are indexes where rounds were missed before that round.
  // Each game site has its own log; the site captured last is shown when the monitor starts.
  let history = store.load(store.lastOrigin());
  // Bets the person tracks (placed by them in the game window, never by the monitor).
  // `seen` counts every round captured since the monitor started this history, so a bet is
  // matched to the round that finishes after it was added, even when old rounds are trimmed.
  const sessionFile = path.join(dataDir, 'session.json');
  // The round number of the last loss; the pause is counted from it, so changing the pause
  // setting applies straight away.
  const newSession = budget => ({budget, bets: [], lastLossRound: -Infinity, startedAt: Date.now()});
  const settingsFile = path.join(dataDir, 'settings.json');
  let settings = {...DEFAULT_SETTINGS};
  try { settings = {...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8'))}; } catch {}
  function saveSettings(input = {}) {
    const pause = Number(input.pauseRounds), share = Number(input.stopLossShare);
    if (input.pauseRounds !== undefined && !(Number.isInteger(pause) && pause >= 0 && pause <= 10)) return {ok: false, error: 'The pause after a loss must be 0 to 10 rounds.'};
    if (input.stopLossShare !== undefined && !STOP_LOSS_CHOICES.includes(share)) return {ok: false, error: 'Pick one of the stop-loss options.'};
    if (input.pauseRounds !== undefined) settings.pauseRounds = pause;
    if (input.stopLossShare !== undefined) settings.stopLossShare = share;
    if (input.remindMinutes !== undefined && !REMIND_CHOICES.includes(Number(input.remindMinutes))) return {ok: false, error: 'Pick one of the reminder options.'};
    if (input.alarmSound !== undefined) settings.alarmSound = input.alarmSound === true;
    if (input.remindMinutes !== undefined) settings.remindMinutes = Number(input.remindMinutes);
    try { atomicWrite(settingsFile, JSON.stringify(settings)); } catch {}
    broadcast();
    void maybeAutoCutOff();
    return {ok: true};
  }
  let session = newSession(1000);
  let seen = history.values.length;
  try {
    const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (saved && saved.budget > 0 && Array.isArray(saved.bets)) {
      session = {...newSession(saved.budget), ...saved};
      seen = Math.max(seen, saved.seen || 0);
      // A bet still waiting when the monitor stopped can't be matched any more.
      for (const b of session.bets) if (b.result === 'pending') b.result = 'unknown';
    }
  } catch {}
  const saveSession = () => {
    try { atomicWrite(sessionFile, JSON.stringify({...session, seen})); } catch {}
  };

  function sessionState() {
    const net = session.bets.reduce((a, b) => a + (b.profit || 0), 0);
    const stopLoss = Math.round(session.budget * settings.stopLossShare);
    const pending = session.bets.find(b => b.result === 'pending') || null;
    // A manual cash-out bet whose round finished, waiting for the person to say where they cashed out.
    const awaiting = session.bets.find(b => b.result === 'awaiting') || null;
    const cooldownLeft = Math.max(0, (session.lastLossRound ?? -Infinity) + settings.pauseRounds - seen);
    // Real money, from the game's balance: the change since the day began.
    const balance = panel ? panel.balance : null;
    const balanceStart = session.balanceStart ?? null;
    const realNet = balance !== null && balanceStart !== null ? Math.round((balance - balanceStart) * 100) / 100 : null;
    const realStopped = realNet !== null && -realNet >= stopLoss;
    const stopped = -net >= stopLoss || realStopped;
    const done = session.bets.filter(b => b.result === 'won' || b.result === 'lost');
    // The game's own Auto Bet is on: every finished round is recorded as a bet.
    const autoBet = session.autoBet || null;
    const slots = panel ? panel.slots : [];
    const gameAutoPlay = slots.some(x => x.autoPlay === true);
    // Mismatches between what is tracked and what the game is set to.
    const warnings = [];
    if (balance === 0) warnings.push(`Your game balance is ₹0.00, so the game cannot place any bet.${autoBet && !autoBet.follow || pending ? ' Bets recorded here are practice only, not real play.' : ''}`);
    const follow = !!(autoBet && autoBet.follow);
    if (follow) {
      // Tracking copies the game, so only what stops the game from betting is worth a warning.
      if (slots.some(x => x.autoPlay && x.autoCashOut === false)) warnings.push('Auto Cash Out is OFF in the game, so a bet has no fixed exit. Those bets are listed without a result; your game balance shows what they did.');
      if (fundsSeen !== null && fundsSeen > 0 && fundsSeen < autoBet.stake) warnings.push(`Your game balance (₹${fundsSeen}) is less than the game's bet (₹${autoBet.stake}), so the game is not betting. These rounds are not counted.`);
    } else if (autoBet && slots.length) {
      const real = slots.find(x => x.autoPlay) || slots[0];
      if (real.bet !== null && real.bet !== autoBet.stake) warnings.push(`The game's bet is ₹${real.bet}, but you are tracking ₹${autoBet.stake}. Press "Use the game's settings" or change the game's bet.`);
      if (real.autoCashOut === false) warnings.push('Auto Cash Out is OFF in the game, so it will not exit at your target by itself.');
      else if (real.target !== null && real.target !== autoBet.target) warnings.push(`The game's Auto Cash Out is ${real.target}×, but you are tracking ${autoBet.target}×.`);
      if (!slots.some(x => x.autoPlay) && slots.some(x => x.autoPlay === false)) warnings.push('Auto Play looks OFF in the game, so it may not be betting every round.');
    }
    if (!follow && balance !== null && balance > 0 && autoBet && balance < autoBet.stake) warnings.push(`Your game balance (₹${balance}) is less than the bet, so the game cannot place it.`);
    const stats = Analysis.sessionStats(session.bets);
    if (stats.chaseRun >= 2) warnings.push('You raised your bet after each of your last losses. That is chasing losses: go back to your planned bet, or stop for today.');
    else if (stats.chases >= 3) warnings.push(`You have raised your bet right after a loss ${stats.chases} times today.`);
    return {
      stats,
      budget: session.budget, stopLoss, net, left: session.budget + net, startedAt: session.startedAt,
      balance, balanceStart, realNet, realStopped, warnings,
      game: panel ? {slots, gameAutoPlay, at: panel.at} : null,
      bets: done.length, wins: done.filter(b => b.result === 'won').length,
      pending, awaiting, cooldownLeft, stopped, autoBet, follow,
      autoCutOff: {enabled: autoCutOffEnabled, last: lastCutOff, gaveUp: cutOffFailures >= 2},
      // The game's bet panel can be read, so tracking can start and stop with the game's Auto Play.
      canFollow: slots.some(x => x.autoPlay !== null),
      // Stop-loss reached while the game is still betting by itself: sound the alarm.
      alarm: stopped && (!!autoBet || gameAutoPlay),
      canBet: !pending && !awaiting && !autoBet && !cooldownLeft && !stopped && capture.status === 'live',
      canAutoBet: !pending && !awaiting && !autoBet && !stopped && capture.status === 'live',
      recent: session.bets.slice(-12).reverse(),
      // Every bet today (newest first, up to 200) for the results panel.
      all: session.bets.slice(-200).reverse(),
      losses: done.filter(b => b.result === 'lost').length,
      wagered: done.reduce((a, b) => a + b.stake, 0),
    };
  }

  // mode 'auto': the game's Auto Cash Out exits at target. mode 'manual': the person presses Cash
  // Out themselves and enters where after the round; target is then only their plan.
  // A bet the game could not have placed: the balance it shows is below the stake.
  const isPractice = stake => !!(panel && panel.balance !== null && panel.balance < stake);

  function placeBet({stake, target, mode} = {}) {
    mode = mode === 'manual' ? 'manual' : 'auto';
    stake = Math.round(Number(stake) * 100) / 100;
    target = Math.round(Number(target) * 100) / 100;
    const st = sessionState();
    if (!(stake > 0) || !(target > 1 && target <= 1000)) return {ok: false, error: 'Enter a bet above ₹0 and a cash-out above 1×.'};
    if (capture.status !== 'live') return {ok: false, error: 'Start live capture and open the game first, so the result can be checked.'};
    if (st.stopped) return {ok: false, error: 'Stop-loss reached. You are done for today.'};
    if (st.pending) return {ok: false, error: 'Your last bet is still waiting for its round.'};
    if (st.awaiting) return {ok: false, error: 'First enter where you cashed out on your last bet.'};
    if (st.cooldownLeft) return {ok: false, error: `After a loss, wait ${st.cooldownLeft} more round${st.cooldownLeft > 1 ? 's' : ''}.`};
    if (stake > st.left) return {ok: false, error: `That is more than the ₹${Math.round(st.left)} you have left today.`};
    session.bets.push({stake, target, mode, result: 'pending', afterRound: seen, at: Date.now(), practice: isPractice(stake)});
    saveSession();
    broadcast();
    return {ok: true};
  }

  function undoBet() {
    const last = session.bets.at(-1);
    if (!last || last.result !== 'pending') return {ok: false, error: 'There is no waiting bet to undo.'};
    session.bets.pop();
    saveSession();
    broadcast();
    return {ok: true};
  }

  // The person turned on Auto Bet + Auto Cash Out in the game itself. The monitor never bets; it
  // records each finished round as a bet of `stake` at `target`, so the stop-loss can be watched.
  function startAutoBet({stake, target} = {}) {
    stake = Math.round(Number(stake) * 100) / 100;
    target = Math.round(Number(target) * 100) / 100;
    const st = sessionState();
    if (!(stake > 0) || !(target > 1 && target <= 1000)) return {ok: false, error: 'Enter a bet above ₹0 and a cash-out above 1×.'};
    if (capture.status !== 'live') return {ok: false, error: 'Start live capture and open the game first, so every round can be checked.'};
    if (st.stopped) return {ok: false, error: 'Stop-loss reached. You are done for today.'};
    if (st.pending || st.awaiting) return {ok: false, error: 'Finish your last bet first.'};
    if (stake > st.left) return {ok: false, error: `That is more than the ₹${Math.round(st.left)} you have left today.`};
    session.autoBet = {stake, target, since: Date.now()};
    saveSession();
    broadcast();
    return {ok: true};
  }
  // Follow the game: tracking starts when Auto Play is switched on in the game, uses the game's
  // own bet and Auto Cash Out target, and stops when Auto Play is switched off. Read-only.
  // Tracking started by hand (startAutoBet) is left alone.
  function followGame() {
    const playing = panel ? panel.slots.filter(x => x.autoPlay === true && x.bet > 0) : [];
    const auto = session.autoBet;
    if (playing.length && !auto) session.autoBet = {follow: true, stake: playing[0].bet, target: playing[0].target, since: Date.now()};
    else if (playing.length && auto.follow) {
      if (auto.stake === playing[0].bet && auto.target === playing[0].target) return false;
      Object.assign(auto, {stake: playing[0].bet, target: playing[0].target});
    } else if (!playing.length && auto && auto.follow && panel && panel.slots.length) session.autoBet = null;
    else return false;
    return true;
  }

  function stopAutoBet() {
    session.autoBet = null;
    saveSession();
    broadcast();
    return {ok: true};
  }

  // Where the person cashed out on a manual bet: a multiplier, or null when they didn't cash out.
  function cashOut({at} = {}) {
    const bet = session.bets.find(b => b.result === 'awaiting');
    if (!bet) return {ok: false, error: 'No manual bet is waiting for its cash-out.'};
    if (at === null || at === undefined || at === '') {
      Object.assign(bet, {result: 'lost', profit: -bet.stake});
    } else {
      at = Math.round(Number(at) * 100) / 100;
      if (!(at >= 1)) return {ok: false, error: 'Enter the multiplier you cashed out at, like 1.85.'};
      if (at > bet.round) return {ok: false, error: `The plane crashed at ${bet.round}×, so you can't have cashed out at ${at}×.`};
      Object.assign(bet, {cashedAt: at, result: 'won', profit: Math.round(bet.stake * (at - 1) * 100) / 100});
    }
    if (bet.result === 'lost') session.lastLossRound = Math.max(session.lastLossRound ?? -Infinity, bet.roundNo);
    saveSession();
    broadcast();
    void maybeAutoCutOff();
    return {ok: true};
  }

  function resetSession(budget) {
    budget = Math.round(Number(budget));
    if (!(budget > 0)) return {ok: false, error: 'Enter the money you are ready to lose today.'};
    archiveDay();
    session = newSession(budget);
    session.balanceStart = panel ? panel.balance : null;
    wasStopped = false; lastCutOff = null; lastCutOffAttemptAt = 0; cutOffFailures = 0;
    followGame(); // Auto Play still on in the game: the new day is tracked from its first round.
    saveSession();
    broadcast();
    return {ok: true};
  }

  // The day that is ending goes to the "Past days" list, when any bet in it was decided.
  function archiveDay() {
    const st = sessionState();
    if (!st.bets) return;
    store.addDay({
      startedAt: session.startedAt, endedAt: Date.now(), site: history.origin, budget: st.budget, stopLoss: st.stopLoss,
      bets: st.bets, wins: st.wins, losses: st.losses, wagered: st.wagered, net: Math.round(st.net * 100) / 100, realNet: st.realNet,
      practice: session.bets.filter(b => b.practice).length, stopped: st.stopped,
      maxDrawdown: st.stats.maxDrawdown, longestLosses: st.stats.longestLosses,
    });
  }

  // New rounds arrived (oldest first). gap: rounds were missed before them.
  // total: all rounds being stored now. It is more than fresh when the list was read for the first
  // time (or again after Clear): rounds already on it finished before, so no bet rode on them.
  function settleBets(fresh, gap, total = fresh.length) {
    const earlier = total - fresh.length;
    seen += earlier;
    if (Number.isFinite(session.lastLossRound)) session.lastLossRound += earlier; // The pause counts live rounds only.
    const pending = session.bets.find(b => b.result === 'pending');
    if (pending && (gap || fresh.length)) {
      if (gap) pending.result = 'unknown'; // Its round may be one of the missed ones.
      else {
        const round = fresh[0], roundNo = seen + 1;
        if (pending.mode === 'manual') Object.assign(pending, {round, roundNo, result: 'awaiting'});
        else {
          const won = round >= pending.target;
          Object.assign(pending, {round, roundNo, cashedAt: won ? pending.target : null, result: won ? 'won' : 'lost', profit: won ? Math.round(pending.stake * (pending.target - 1) * 100) / 100 : -pending.stake});
          if (!won) session.lastLossRound = roundNo; // The pause counts the rounds after this one.
        }
      }
    }
    if (session.autoBet && session.autoBet.follow) {
      // One bet per game slot with Auto Play on, at the game's own amount and Auto Cash Out target.
      const plays = (panel ? panel.slots : []).filter(x => x.autoPlay === true && x.bet > 0)
        .map(x => ({stake: x.bet, target: x.autoCashOut !== false && x.target > 1 ? x.target : null}));
      // The most money seen since the last round: a bet above it cannot have been placed.
      let funds = fundsSeen === null ? Infinity : fundsSeen;
      const base = {mode: 'autobet', follow: true, at: Date.now()};
      for (const {stake, target} of plays) {
        if (funds < stake) continue;
        funds -= stake;
        if (gap) session.bets.push({...base, stake, target, result: 'unknown'});
        else fresh.forEach((round, i) => {
          // No Auto Cash Out: where the person cashed out is not known, so the bet has no result
          // here and the game balance carries the real outcome.
          if (target === null) return session.bets.push({...base, stake, target, round, roundNo: seen + 1 + i, result: 'unknown', manualExit: true});
          const won = round >= target;
          session.bets.push({...base, stake, target, round, roundNo: seen + 1 + i, cashedAt: won ? target : null,
            result: won ? 'won' : 'lost', profit: won ? Math.round(stake * (target - 1) * 100) / 100 : -stake});
        });
      }
    } else if (session.autoBet) {
      const {stake, target} = session.autoBet;
      if (gap) {
        // Some rounds passed unseen: their bets can't be checked.
        session.bets.push({stake, target, mode: 'autobet', practice: isPractice(stake), result: 'unknown', at: Date.now()});
      } else {
        fresh.forEach((round, i) => {
          const won = round >= target;
          session.bets.push({stake, target, mode: 'autobet', practice: isPractice(stake), round, roundNo: seen + 1 + i, cashedAt: won ? target : null,
            result: won ? 'won' : 'lost', profit: won ? Math.round(stake * (target - 1) * 100) / 100 : -stake, at: Date.now()});
        });
      }
    }
    if (fresh.length || gap) fundsSeen = panel ? panel.balance : null;
    seen += fresh.length;
    saveSession();
  }
  // The game's own bet panel as last read (balance, bet slots), or null when not seen.
  let panel = null;
  let baseline = null; // See clear().
  // The highest game balance read since the last finished round (the bet is taken from the balance
  // before the round and the win is paid after it), or null when no balance was read.
  let fundsSeen = null;
  let capture = {status: 'stopped', note: '', url: '', startedAt: 0, lastSnapshotAt: 0, lastRoundAt: 0, source: '', sawPlain: false};
  let context = null, stopping = false;
  // One lock for everything that types or clicks in the game, so two actions never overlap.
  let busy = false;
  let autoCutOffEnabled = true, lastCutOff = null, lastCutOffAttemptAt = 0, wasStopped = false, cutOffFailures = 0;
  const clients = new Set();
  // Live picture of the game window: Chrome's screencast sends a JPEG whenever the page changes,
  // and each viewer gets them as a motion-JPEG stream that an <img> plays directly.
  let frame = null, castPage = null, castSession = null;
  // The page where the Aviator results were found; the live view stays on it.
  let gamePage = null;
  const viewers = new Set();
  const writeFrame = (res, jpeg) => {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    res.write(jpeg);
    res.write('\r\n');
  };
  let lastFrameAt = 0, grabbing = false;
  function pushFrame(jpeg) {
    frame = jpeg;
    lastFrameAt = Date.now();
    for (const res of viewers) writeFrame(res, jpeg);
  }
  // Screencast only sends a picture when the page repaints. While someone is watching and no
  // picture came for 2 s (a still screen, or the game tab behind another tab), take a screenshot.
  const grabTimer = setInterval(async () => {
    if (!viewers.size || !castPage || grabbing || Date.now() - lastFrameAt < 2000) return;
    grabbing = true;
    try { pushFrame(await castPage.screenshot({type: 'jpeg', quality: 60, timeout: 3000})); } catch {}
    finally { grabbing = false; }
  }, 1000);

  // Tells Chrome to treat the page as focused even when another tab or app is in front.
  async function keepFocused(page) {
    try {
      const session = await page.context().newCDPSession(page);
      await session.send('Emulation.setFocusEmulationEnabled', {enabled: true});
      await session.send('Page.setWebLifecycleState', {state: 'active'}).catch(() => {});
    } catch {}
  }

  async function watchPage(page) {
    if (castPage === page || !context) return;
    const old = castSession;
    castPage = page; castSession = null;
    if (old) old.detach().catch(() => {});
    try {
      const session = await page.context().newCDPSession(page);
      session.on('Page.screencastFrame', ({data, sessionId}) => {
        session.send('Page.screencastFrameAck', {sessionId}).catch(() => {});
        if (castSession === session) pushFrame(Buffer.from(data, 'base64'));
      });
      castSession = session;
      await session.send('Page.startScreencast', {format: 'jpeg', quality: 60, maxWidth: 1000, maxHeight: 1000});
    } catch {}
    page.on('close', () => {
      if (castPage !== page || !context) return;
      castPage = null;
      const next = gamePage || context.pages().at(-1);
      if (next) watchPage(next);
    });
  }

  // Totals over all rounds, worked out again only when the rounds change.
  let summaryOf = null, summary = null;
  function totals() {
    if (summaryOf === history.values) return summary;
    const {values, times} = history, n = values.length;
    const sorted = [...values].sort((a, b) => a - b), m = Math.floor(n / 2);
    summaryOf = values;
    return summary = {
      median: n ? (n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2) : null,
      over2: n ? values.filter(v => v >= 2).length / n : null,
      pace: Analysis.pace(times),
    };
  }
  const isStale = () => capture.status === 'live' && Date.now() - capture.lastSnapshotAt > staleMs;

  function state() {
    const {values, times, gaps} = history, n = values.length;
    const start = Math.max(0, n - 200);
    return {
      capture: {...capture, stale: isStale()},
      site: history.origin,
      count: n,
      latest: n ? values[n - 1] : null,
      ...totals(),
      breaks: gaps.length,
      // Newest 200 rounds, newest first, with a flag where rounds were missed before them.
      recent: values.slice(start).map((v, i) => ({v, at: times[start + i], gap: gaps.includes(start + i)})).reverse(),
      session: sessionState(),
      settings,
    };
  }
  function broadcast() {
    const data = `data: ${JSON.stringify(state())}\n\n`;
    for (const res of clients) res.write(data);
  }
  const setCapture = patch => { capture = {...capture, ...patch}; broadcast(); };
  // Tell the page when a live capture goes quiet (game frozen, logged out, connection lost).
  let wasStale = false;
  const staleTimer = setInterval(() => {
    const stale = isStale();
    if (stale !== wasStale) { wasStale = stale; broadcast(); }
  }, Math.min(5000, Math.max(250, staleMs / 4)));

  function applyPanel(p) {
    if (!p || typeof p !== 'object' || !['waiting', 'live'].includes(capture.status)) return;
    const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const slots = Array.isArray(p.slots) ? p.slots.slice(0, 4).map(x => ({
      bet: num(x && x.bet), target: num(x && x.target),
      autoCashOut: typeof (x && x.autoCashOut) === 'boolean' ? x.autoCashOut : null,
      autoPlay: typeof (x && x.autoPlay) === 'boolean' ? x.autoPlay : null,
      button: typeof (x && x.button) === 'string' ? x.button.slice(0, 40) : null,
    })) : [];
    panel = {balance: num(p.balance), slots, at: Date.now()};
    if (panel.balance !== null) fundsSeen = Math.max(fundsSeen ?? 0, panel.balance);
    if (followGame()) saveSession();
    // The day's starting balance: the first one seen after the day began.
    if (panel.balance !== null && (session.balanceStart === undefined || session.balanceStart === null)) {
      session.balanceStart = panel.balance;
      saveSession();
    }
    broadcast();
  }

  function onPanel(p) {
    applyPanel(p);
    void maybeAutoCutOff();
  }

  function onSnapshot(snap, frameUrl = '') {
    const values = Array.isArray(snap?.values) ? snap.values.filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 1).slice(0, 300) : [];
    if (!values.length || !['waiting', 'live'].includes(capture.status)) return;
    let source = '';
    try { source = new URL(frameUrl).host; } catch {}
    // Aviator shows results as "1.23x". Plain numbers on betting sites are sports odds: never stored.
    if (snap.marked !== true) {
      if (capture.status === 'waiting' && !capture.sawPlain) setCapture({sawPlain: true});
      return;
    }
    const extra = {};
    extra.source = source;
    const newCount = Number.isInteger(snap.newCount) ? snap.newCount : null;
    const now = Date.now();
    const {fresh, gap} = AviatorMatch.newRounds(history.values, values, newCount);
    // Rounds that finished just now, for the tracked bets. With nothing stored yet the whole list
    // is new to the history, but only rounds after the ones known before Clear are live.
    let live = fresh, liveGap = gap;
    if (!history.values.length) {
      const r = baseline ? AviatorMatch.newRounds(baseline, values, newCount) : {fresh: [], gap: false};
      live = r.gap ? [] : r.fresh;
      liveGap = r.gap;
    }
    const patch = {...extra, lastSnapshotAt: now, status: 'live', note: ''};
    if (fresh.length) {
      baseline = null;
      settleBets(live, liveGap, fresh.length);
      const next = AviatorMatch.append(history.values, history.gaps, fresh, gap, MAX_ROUNDS);
      const times = [...history.times, ...fresh.map(() => now)].slice(-next.captured.length);
      store.append(history.origin, fresh, now, gap && history.values.length > 0);
      history = {...history, values: next.captured, times, gaps: next.gaps};
      patch.lastRoundAt = now;
    }
    setCapture(patch);
    void maybeAutoCutOff();
  }

  async function openBrowser() {
    if (launch) return launch();
    const {chromium} = require('playwright-core');
    const options = {headless, viewport: null, args: ['--no-first-run', '--no-default-browser-check', ...KEEP_RUNNING_ARGS]};
    const errors = [];
    // The person's own installed browser, so nothing extra has to be downloaded.
    for (const channel of ['chrome', 'msedge', undefined]) {
      try { return await chromium.launchPersistentContext(profileDir, {...options, channel}); }
      catch (e) { errors.push(String(e.message || e).split('\n')[0]); }
    }
    throw new Error(`Could not open Google Chrome or Microsoft Edge. Install Google Chrome and try again. (${errors[0]})`);
  }

  async function start(rawUrl) {
    let url;
    try { url = new URL(String(rawUrl || '').trim()); } catch {}
    if (!url || !['http:', 'https:'].includes(url.protocol)) return {ok: false, error: 'Enter the full game address, starting with https://'};
    if (context) await stop('');
    // Each game site has its own history: a different site shows its own rounds, and the
    // other site's rounds stay saved for the next time it is opened.
    baseline = null;
    if (history.origin !== url.origin) {
      history = store.load(url.origin);
      // Bets waiting on the other site's rounds can't be matched here.
      for (const b of session.bets) if (b.result === 'pending') b.result = 'unknown';
      session.autoBet = null;
      saveSession();
    }
    store.setOrigin(url.origin);
    setCapture({status: 'starting', note: 'Opening the game window…', url: url.href, startedAt: Date.now(), lastSnapshotAt: 0, lastRoundAt: 0, source: '', sawPlain: false});
    try {
      context = await openBrowser();
    } catch (e) {
      context = null;
      setCapture({status: 'error', note: e.message});
      return {ok: false, error: e.message};
    }
    const ctx = context;
    ctx.on('close', () => {
      if (context === ctx) context = null;
      if (!stopping) setCapture({status: 'stopped', note: 'The game window was closed. Click Start live capture to open it again.'});
    });
    // Every frame, including the game iframe and pages loaded later, reports through this binding.
    await ctx.exposeBinding('__aviatorReport', (src, snap) => {
      if (snap?.marked === true && src.page && src.page !== gamePage) {
        gamePage = src.page;
        gamePage.on('close', () => { if (gamePage === src.page) gamePage = null; });
        watchPage(gamePage);
      }
      onSnapshot(snap, src.frame ? src.frame.url() : '');
    });
    await ctx.exposeBinding('__aviatorPanel', (_src, p) => onPanel(p));
    await ctx.addInitScript({path: STAY_VISIBLE_SCRIPT});
    await ctx.addInitScript({path: CAPTURE_SCRIPT});
    const page = ctx.pages()[0] || await ctx.newPage();
    keepFocused(page);
    watchPage(page);
    // The game often opens in a new tab or popup: show whichever page opened last.
    // Until the results are found; after that the view stays on the game's page.
    ctx.on('page', p => { keepFocused(p); if (!gamePage) watchPage(p); });
    setCapture({status: 'waiting', note: 'Game window open. Log in if asked and open the Aviator game; rounds appear here as they finish.'});
    page.goto(url.href, {waitUntil: 'domcontentloaded', timeout: 60000}).catch(e => {
      if (context === ctx && capture.status === 'waiting') setCapture({note: `The page did not load (${String(e.message).split('\n')[0]}). Check the address, or load it in the game window.`});
    });
    return {ok: true};
  }

  async function stop(note = 'Capture stopped.') {
    castPage = null; castSession = null; frame = null; gamePage = null; panel = null; fundsSeen = null;
    wasStopped = false; lastCutOffAttemptAt = 0; cutOffFailures = 0;
    const ctx = context;
    context = null;
    stopping = true;
    try { if (ctx) await ctx.close(); } catch {} finally { stopping = false; }
    setCapture({status: 'stopped', note});
    return {ok: true};
  }

  // What each frame of the game window contains, to see why the results list is or isn't found.
  async function diagnose() {
    if (!context) return {ok: false, error: 'Not capturing.'};
    const frames = [];
    for (const page of context.pages()) for (const frame of page.frames()) {
      let info;
      try { info = await frame.evaluate(() => (window.__aviatorCandidates ? window.__aviatorCandidates() : {missing: true})); }
      catch (e) { info = {error: String(e.message).split('\n')[0]}; }
      frames.push({url: frame.url().slice(0, 200), ...info});
    }
    return {ok: true, frames};
  }

  // Read-only outline of the game frame's controls (bet panel, balance, switches), to learn how the
  // game's page is built. Returns tags, classes, short texts, input values and checkbox states only.
  async function inspect() {
    if (!context) return {ok: false, error: 'Not capturing.'};
    const out = [];
    for (const page of context.pages()) for (const frame of page.frames()) {
      let host = '';
      try { host = new URL(frame.url()).host; } catch {}
      if (capture.source && host !== capture.source) continue;
      try {
        out.push({url: frame.url().slice(0, 120), nodes: await frame.evaluate(() => {
          const keep = /bet|cash|balance|auto|amount|switch|toggle|wallet|currency|spinner|input/i;
          const rows = [];
          for (const el of document.querySelectorAll('body *')) {
            const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
            const isField = el.tagName === 'INPUT' || el.tagName === 'BUTTON';
            if (!isField && !keep.test(cls)) continue;
            if (rows.length > 400) break;
            const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').slice(0, 40);
            let depth = 0; for (let p = el; p.parentElement; p = p.parentElement) depth++;
            rows.push({d: depth, tag: el.tagName.toLowerCase(), cls: cls.slice(0, 90), text: own, value: el.value !== undefined && el.tagName === 'INPUT' ? String(el.value).slice(0, 20) : undefined,
              type: el.type, checked: el.type === 'checkbox' ? el.checked : undefined, disabled: el.disabled || undefined,
              box: (r => `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`)(el.getBoundingClientRect())});
          }
          return rows;
        })});
      } catch (e) { out.push({url: frame.url().slice(0, 120), error: String(e.message).split('\n')[0]}); }
    }
    return {ok: true, frames: out};
  }

  // Locates the live game frame containing at least `minSlots` bet blocks.
  async function findGameFrame(minSlots = 1) {
    if (!context) return null;
    let frame = null;
    for (const page of context.pages()) for (const f of page.frames()) {
      let host = '';
      try { host = new URL(f.url()).host; } catch {}
      if (host === capture.source && await f.locator('.betSectionBlock').count().catch(() => 0) >= minSlots) frame = f;
    }
    return frame;
  }

  // Types what the admin entered into the game site's own login form and submits it. The
  // username and password are used for this one call only: never stored, logged or sent back.
  async function loginGame({username, password} = {}) {
    const fail = error => ({ok: false, error});
    username = String(username ?? '').trim();
    password = String(password ?? '');
    if (!username || !password) return fail('Enter the game username and password.');
    if (username.length > 200 || password.length > 200) return fail('That is too long to be a username or password.');
    if (!context) return fail('Click Start live capture first, so the game window is open.');
    if (busy) return fail('Another game action is still running. Try again in a moment.');
    busy = true;
    try {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const findField = async () => {
        for (const page of context.pages()) for (const f of page.frames()) {
          const pw = f.locator('input[type="password"]:visible').first();
          if (await pw.count().catch(() => 0)) return {f, pw};
        }
        return null;
      };
      let form = await findField();
      if (!form) {
        const page = gamePage || context.pages().at(-1);
        if (!page) return fail('The game window is not open.');
        const opener = page.locator('button:visible, a:visible, [role="button"]:visible, div:visible, span:visible').filter({hasText: /^\s*(log ?in|sign ?in)\s*$/i}).last();
        if (!await opener.count().catch(() => 0)) return fail('No login form or Login button was found in the game window. You may be logged in already.');
        await opener.click({timeout: 3000});
        for (let i = 0; i < 12 && !form; i++) { await wait(300); form = await findField(); }
        if (!form) return fail('The Login button was pressed, but no password box appeared. Use Open game window to log in by hand.');
      }
      const {f, pw} = form;
      const kinds = 'input:is([type="text"],[type="email"],[type="tel"],:not([type])):visible';
      let user = f.locator(`form:has(input[type="password"]) ${kinds}`).first();
      if (!await user.count().catch(() => 0)) user = f.locator(kinds).last();
      if (!await user.count().catch(() => 0)) return fail('The username box was not found on the game\'s login form. Use Open game window to log in by hand.');
      await user.fill(username, {timeout: 3000});
      await pw.fill(password, {timeout: 3000});
      await pw.press('Enter', {timeout: 3000});
      for (let i = 0; i < 20; i++) {
        await wait(400);
        if (!await findField()) return {ok: true};
      }
      return fail('The game still shows its login form: the username or password was not accepted, or it asks for something more. Use Open game window to check.');
    } catch (e) {
      return fail(`The game's login form could not be filled (${String(e.message).split('\n')[0].slice(0, 120)}).`);
    } finally { busy = false; }
  }

  // Clicks a game control. `still` (optional) is checked again once the control is ready to be
  // pressed: the game's main button turns from Bet to Cancel to Cash Out and Auto Play is a
  // toggle, so a press that arrives after the state changed would do the opposite of what was
  // asked. `fallback` sends a DOM click when a pointer click cannot reach the control; it is off
  // for buttons that stake or release money, where a late click is worse than none.
  async function clickControl(locator, {still, fallback = true} = {}) {
    let why = '';
    try {
      if (still) {
        await locator.click({trial: true, timeout: 1500}); // Scrolls to it and waits; presses nothing.
        if (!await still()) return {ok: false, changed: true, why: 'the game changed before the button could be pressed'};
        await locator.click({timeout: 400});
      } else await locator.click({timeout: 1500});
      return {ok: true, why: ''};
    } catch (e) {
      why = String(e.message).split('\n')[0];
      if (fallback && /Timeout/.test(why)) {
        try {
          await locator.dispatchEvent('click', {}, {timeout: 1500});
          return {ok: true, why};
        } catch (e2) {
          why = String(e2.message).split('\n')[0];
        }
      }
      return {ok: false, why};
    }
  }

  // Reads the live balance and all bet slots directly from the game frame DOM.
  async function readFramePanel(frame) {
    return frame.evaluate(() => {
      const money = t => { const n = Number(String(t || '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) && /\d/.test(String(t)) ? n : null; };
      const isOn = el => !!el && /(^|[\s-])(active|on|checked|enabled|selected)([\s-]|$)/i.test(typeof el.className === 'string' ? el.className : '');
      const isDisabled = el => !!(el && (el.disabled || el.getAttribute('aria-disabled') === 'true' || /(^|[\s-])disabled([\s-]|$)/i.test(typeof el.className === 'string' ? el.className : '')));
      const btnState = (cls, text) => {
        if (/cancel/i.test(cls)) return 'cancel';
        if (/cash[\s_-]*out/i.test(cls)) return 'cashout';
        if (/\bstart\b/i.test(cls)) return 'bet';
        if (/cancel/i.test(text)) return 'cancel';
        if (/cash\s*out/i.test(text)) return 'cashout';
        if (/\bbet\b/i.test(text)) return 'bet';
        return null;
      };
      const balanceEl = document.querySelector('.userBalanceMoney');
      const slots = [...document.querySelectorAll('.betSectionBlock')].slice(0, 4).map(b => {
        const input = b.querySelector('.betSectionInput');
        const button = b.querySelector('.betButton');
        const tag = b.querySelector('.autoPlayTagInput');
        const sw = b.querySelector('.autoCashOut .switcher, .autoCashOut [class*=switch]');
        const play = b.querySelector('.autoPlayButton');
        const buttonCls = button && typeof button.className === 'string' ? button.className.replace('betButton', '').trim() : '';
        const buttonText = button ? button.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) : null;
        return {
          bet: input ? money(input.value) : null,
          autoCashOut: tag ? !tag.disabled || isOn(sw) : null,
          target: tag ? money(tag.value) : null,
          autoPlay: play ? isOn(play) || /stop/i.test(play.textContent) : null,
          buttonCls: buttonCls || null,
          button: button ? btnState(buttonCls, buttonText || '') : null,
          buttonText,
          hasButton: !!button,
          buttonDisabled: isDisabled(button),
          hasAutoPlay: !!play,
          autoPlayDisabled: isDisabled(play),
        };
      });
      return {balance: balanceEl ? money(balanceEl.textContent) : null, slots};
    });
  }

  function applyPanelFromFrame(fp) {
    if (!fp) return;
    applyPanel({
      balance: fp.balance,
      slots: fp.slots.map(s => ({bet: s.bet, target: s.target, autoCashOut: s.autoCashOut, autoPlay: s.autoPlay, button: s.buttonCls})),
    });
  }

  const slotView = s => s ? {bet: s.bet, target: s.target, autoCashOut: s.autoCashOut, autoPlay: s.autoPlay, button: s.button, buttonText: s.buttonText} : null;

  async function waitForPanelSlot(frame, slot, done, timeoutMs = 450) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const fp = await readFramePanel(frame);
      if (done(fp.slots[slot]) || Date.now() >= end) return fp;
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // Fills in the bet amount and the Auto Cash Out target of one bet slot in the game, when the
  // person asks for it on the monitor page, then reads both back from the game.
  async function setGame({slot = 0, bet, target} = {}) {
    const fail = error => ({ok: false, error});
    slot = Number(slot);
    const wantBet = bet !== undefined && bet !== null && bet !== '', wantTarget = target !== undefined && target !== null && target !== '';
    bet = Math.round(Number(bet) * 100) / 100;
    target = Math.round(Number(target) * 100) / 100;
    if (!wantBet && !wantTarget) return fail('Enter a bet or a cash-out target to set.');
    if (wantBet && !(bet > 0)) return fail('Enter a bet above ₹0.');
    if (wantTarget && !(target > 1 && target <= 1000)) return fail('Enter a cash-out target above 1×.');
    if (!context || capture.status !== 'live') return fail('Start live capture and open the game first.');
    const now = panel && panel.slots[slot];
    if (!Number.isInteger(slot) || !now) return fail("The game's bet panel is not on screen.");
    const st = sessionState();
    if (st.stopped) return fail('Stop-loss reached. You are done for today.');
    if (now.autoPlay === true) return fail('Auto Play is on for this bet in the game. Switch it off there before changing the bet.');
    if (now.button && !/start/i.test(now.button)) return fail('A bet is already placed or in flight on this slot. Wait for the round to finish.');
    if (wantBet && bet > st.left) return fail(`That is more than the ₹${Math.round(st.left)} you have left today.`);
    if (busy) return fail('Another game action is still running. Try again in a moment.');
    busy = true;
    try {
      const frame = await findGameFrame(slot + 1);
      if (!frame) return fail("The game's bet panel is not on screen.");
      const block = frame.locator('.betSectionBlock').nth(slot);
      const type = async (box, value) => { await box.fill(String(value), {timeout: 3000}); await box.blur({timeout: 3000}); };
      if (wantBet) await type(block.locator('.betSectionInput'), bet);
      if (wantTarget) {
        const box = block.locator('.autoPlayTagInput');
        // The target box is greyed out while Auto Cash Out is off: switch it on first.
        let why = '';
        if (await box.isDisabled({timeout: 3000})) {
          // The switch itself, or its "auto cash out" label: both sit inside the Auto Cash Out
          // part of this bet slot (Auto Play is a separate button and is never touched).
          for (const part of ['.autoCashOut .switcher', '.autoCashOut .autoPlaySwitcherText', '.autoCashOut [class*=switch]']) {
            if (!await box.isDisabled()) break;
            const c = await clickControl(block.locator(part).first());
            if (c.why) why = c.why;
            for (let i = 0; i < 10 && await box.isDisabled(); i++) await new Promise(r => setTimeout(r, 100));
          }
          if (await box.isDisabled()) return {detail: why || 'the clicks were accepted but the switch did not change', ...fail(`${wantBet ? `The bet is set to ₹${bet}, but ` : ''}Auto Cash Out could not be switched on from here. Switch it on in the game, then set the target again.`)};
        }
        await type(box, target);
      }
      // The game may round or limit what was typed: what it shows afterwards is what counts.
      await new Promise(r => setTimeout(r, 400));
      const shown = await block.evaluate(b => {
        const num = el => { const n = el ? Number(String(el.value).replace(/[^0-9.]/g, '')) : NaN; return Number.isFinite(n) && el && /\d/.test(el.value) ? n : null; };
        const tag = b.querySelector('.autoPlayTagInput');
        return {bet: num(b.querySelector('.betSectionInput')), target: num(tag), autoCashOut: tag ? !tag.disabled : null};
      });
      const wrong = [];
      if (wantBet && shown.bet !== bet) wrong.push(`the game shows a bet of ${shown.bet === null ? 'nothing' : `₹${shown.bet}`}, not ₹${bet}`);
      if (wantTarget && (shown.target !== target || shown.autoCashOut === false)) wrong.push(`the game shows Auto Cash Out ${shown.autoCashOut === false ? 'OFF' : `at ${shown.target}×`}, not at ${target}×`);
      if (wrong.length) return {ok: false, shown, error: `Not set as asked: ${wrong.join('; ')}. Check the game window (it may have its own limits).`};
      return {ok: true, slot, shown};
    } catch (e) {
      return fail(`The game's bet boxes could not be filled in (${String(e.message).split('\n')[0]}).`);
    } finally { busy = false; }
  }

  // Clicks .betButton ('bet', 'cancel', 'cashout') or .autoPlayButton ('autoplay') on one slot,
  // checking live game state and session limits, then reads back what the game shows afterwards.
  async function clickGame({slot = 0, action = 'bet', on} = {}) {
    const fail = error => ({ok: false, error});
    slot = Number(slot);
    const rawAction = String(action === undefined || action === null ? 'bet' : action).trim().toLowerCase().replace(/[\s_-]+/g, '');
    const kind = rawAction === 'bet' || rawAction === 'start' ? 'bet'
      : rawAction === 'cancel' ? 'cancel'
      : rawAction === 'cashout' ? 'cashout'
      : rawAction === 'autoplay' || rawAction === 'auto' ? 'autoplay'
      : null;
    if (!kind) return fail('Choose an action: bet, cancel, cashout, or autoplay.');
    if (kind === 'autoplay' && on !== undefined && typeof on !== 'boolean') return fail('Set "on" to true or false for autoplay.');
    if (!context || capture.status !== 'live') return fail('Start live capture and open the game first.');
    if (!Number.isInteger(slot) || slot < 0) return fail("The game's bet panel is not on screen.");
    if (busy) return fail('Another game action is still running. Try again in a moment.');
    busy = true;
    try {
      const frame = await findGameFrame(slot + 1);
      if (!frame) return fail("The game's bet panel is not on screen.");
      const fp = await readFramePanel(frame);
      const before = fp.slots[slot];
      if (!before) return fail("The game's bet panel is not on screen.");
      const st = sessionState();
      const block = frame.locator('.betSectionBlock').nth(slot);

      let targetLocator, done, mismatchError;
      if (kind === 'autoplay') {
        if (!before.hasAutoPlay) return fail('The Auto Play button was not found on this slot.');
        const wantOn = on !== undefined ? on : !before.autoPlay;
        if (wantOn) {
          if (st.stopped) return fail('Stop-loss reached. You are done for today.');
          if (!(before.bet > 0)) return fail('Enter a bet above ₹0 in the game first.');
          if (before.bet > st.left) return fail(`That is more than the ₹${Math.round(st.left)} you have left today.`);
        }
        if (before.autoPlay === wantOn) {
          applyPanelFromFrame(fp);
          return {ok: true, slot, action: kind, changed: false, shown: slotView(before)};
        }
        if (before.autoPlayDisabled) return fail('The Auto Play button is disabled in the game right now.');
        targetLocator = block.locator('.autoPlayButton');
        done = s => s && s.autoPlay === wantOn;
        mismatchError = s => `Not switched as asked: Auto Play is still ${s && s.autoPlay ? 'ON' : 'OFF'} in the game.`;
      } else {
        if (!before.hasButton) return fail('The Bet button was not found on this slot.');
        if (kind === 'bet') {
          if (st.stopped) return fail('Stop-loss reached. You are done for today.');
          if (st.cooldownLeft) return fail(`After a loss, wait ${st.cooldownLeft} more round${st.cooldownLeft > 1 ? 's' : ''}.`);
          if (before.autoPlay === true) return fail('Auto Play is on for this bet in the game. Switch it off before pressing Bet.');
          if (before.button !== 'bet') return fail('A bet is already placed or in flight on this slot.');
          if (!(before.bet > 0)) return fail('Enter a bet above ₹0 in the game first.');
          if (before.bet > st.left) return fail(`That is more than the ₹${Math.round(st.left)} you have left today.`);
        } else if (kind === 'cancel') {
          if (before.button !== 'cancel') return fail('There is no waiting bet to cancel on this slot.');
        } else if (kind === 'cashout') {
          if (before.button !== 'cashout') return fail('There is no active bet to cash out on this slot.');
        }
        if (before.buttonDisabled) {
          const label = kind === 'cashout' ? 'Cash Out' : kind === 'cancel' ? 'Cancel' : 'Bet';
          return fail(`The ${label} button is disabled in the game right now.`);
        }
        targetLocator = block.locator('.betButton');
        done = kind === 'bet' ? s => s && s.button !== 'bet'
          : kind === 'cancel' ? s => s && s.button !== 'cancel' && s.button !== 'cashout'
          : s => s && s.button !== 'cashout';
        mismatchError = s => {
          if (kind === 'cancel' && s && s.button === 'cashout') return 'The round already started before Cancel could land; Cash Out is now shown.';
          const label = s && s.button === 'cancel' ? 'Cancel' : s && s.button === 'cashout' ? 'Cash Out' : s && s.button === 'bet' ? 'Bet' : (s && s.buttonText) || 'unchanged';
          return `Not clicked as asked: the game button still shows ${label}. Check the game window.`;
        };
      }

      const still = async () => {
        const s = (await readFramePanel(frame)).slots[slot];
        return !!s && (kind === 'autoplay' ? s.autoPlay === before.autoPlay : s.button === kind);
      };
      const clicked = await clickControl(targetLocator, {still, fallback: false});
      if (!clicked.ok) return fail(clicked.changed ? `Nothing was pressed: ${clicked.why}. Check the game window.` : `The game's ${kind} button could not be clicked (${clicked.why}).`);
      const afterPanel = await waitForPanelSlot(frame, slot, done, 450);
      applyPanelFromFrame(afterPanel);
      const after = afterPanel.slots[slot];
      if (!done(after)) return {ok: false, slot, action: kind, shown: slotView(after), error: mismatchError(after)};
      return {ok: true, slot, action: kind, changed: true, shown: slotView(after)};
    } catch (e) {
      return fail(`The game's button could not be clicked (${String(e.message).split('\n')[0]}).`);
    } finally { busy = false; }
  }

  // Turns off Auto Play and cancels waiting bets across every slot when the session stop-loss
  // is reached (or when forced). Turns Auto Play off first so it cannot re-place a cancelled bet.
  async function autoCutOff({force = false} = {}) {
    const fail = error => ({ok: false, error});
    if (!context || capture.status !== 'live') return fail('Start live capture and open the game first.');
    const st = sessionState();
    if (!force && !st.stopped) return {ok: true, triggered: false, stopped: false, enabled: autoCutOffEnabled, actions: []};
    if (busy) return {busy: true, ...fail('Another game action is still running. Try again in a moment.')};
    busy = true;
    try {
      const frame = await findGameFrame(1);
      if (!frame) return fail("The game's bet panel is not on screen.");
      let fp = await readFramePanel(frame);
      const actions = [];
      const stopSlot = async (i, action, locator, disabled, still, done, stayedMsg) => {
        if (disabled) { actions.push({slot: i, action, ok: false, error: `The ${action === 'autoplay' ? 'Auto Play' : 'Cancel'} button is disabled.`}); return; }
        const c = await clickControl(locator, {fallback: false, still: async () => { fp = await readFramePanel(frame); return !!fp.slots[i] && still(fp.slots[i]); }});
        if (c.changed) return; // Already off or gone by itself: nothing to press.
        if (!c.ok) { actions.push({slot: i, action, ok: false, error: c.why}); return; }
        fp = await waitForPanelSlot(frame, i, done, 450);
        const ok = done(fp.slots[i]);
        actions.push({slot: i, action, ok, ...(ok ? {} : {error: stayedMsg})});
      };
      for (let i = 0; i < fp.slots.length; i++) {
        const block = frame.locator('.betSectionBlock').nth(i);
        if (fp.slots[i].autoPlay === true) {
          await stopSlot(i, 'autoplay', block.locator('.autoPlayButton'), fp.slots[i].autoPlayDisabled, s => s.autoPlay === true, s => s && s.autoPlay === false, 'Auto Play stayed ON in the game.');
        }
        const cur = fp.slots[i];
        if (cur && cur.button === 'cancel') {
          await stopSlot(i, 'cancel', block.locator('.betButton'), cur.buttonDisabled, s => s.button === 'cancel', s => s && s.button !== 'cancel', 'Waiting bet stayed active in the game.');
        }
      }
      const failed = actions.filter(a => !a.ok);
      const result = {
        ok: failed.length === 0,
        triggered: actions.length > 0,
        stopped: st.stopped,
        forced: !!force,
        enabled: autoCutOffEnabled,
        actions,
        slots: fp.slots.map(slotView),
        ...(failed.length ? {error: `Cut-off incomplete: ${failed.map(f => `Bet ${f.slot + 1} ${f.action} (${f.error})`).join('; ')}`} : {}),
      };
      if (actions.length > 0) {
        lastCutOff = {at: Date.now(), ok: result.ok, triggered: true, forced: result.forced, actions, ...(result.error ? {error: result.error} : {})};
      }
      applyPanelFromFrame(fp);
      return result;
    } catch (e) {
      return fail(`Stop-loss cut-off failed (${String(e.message).split('\n')[0]}).`);
    } finally { busy = false; }
  }

  async function handleCutOff({enabled, force} = {}) {
    cutOffFailures = 0; // Asked for by the person: try again.
    if (enabled !== undefined && typeof enabled !== 'boolean') return {ok: false, error: 'Set "enabled" to true or false.'};
    if (force !== undefined && typeof force !== 'boolean') return {ok: false, error: 'Set "force" to true or false.'};
    if (enabled !== undefined) autoCutOffEnabled = enabled;
    if (force) return autoCutOff({force: true});
    const st = sessionState();
    if (enabled !== undefined) {
      if (autoCutOffEnabled && context && capture.status === 'live' && st.stopped) return autoCutOff();
      broadcast();
      return {ok: true, enabled: autoCutOffEnabled, triggered: false, stopped: st.stopped, actions: []};
    }
    return autoCutOff();
  }

  async function maybeAutoCutOff() {
    if (!context || capture.status !== 'live') return;
    const st = sessionState();
    const justStopped = st.stopped && !wasStopped;
    wasStopped = st.stopped;
    if (!autoCutOffEnabled || !st.stopped || busy) return;
    // Auto Play is a toggle: if two tries did not visibly switch it off, pressing it again could
    // switch it back on, so the monitor stops trying and leaves the alarm to the person.
    if (cutOffFailures >= 2) return;
    const slots = panel ? panel.slots : [];
    const needsCutOff = slots.some(x => x.autoPlay === true || (x.button && /cancel/i.test(x.button)));
    if (!justStopped && !needsCutOff) return;
    if (!justStopped && Date.now() - lastCutOffAttemptAt < 2500) return;
    lastCutOffAttemptAt = Date.now();
    const r = await autoCutOff().catch(() => null);
    if (r && r.triggered) { cutOffFailures = r.ok ? 0 : cutOffFailures + 1; if (!r.ok) broadcast(); }
  }

  function clear() {
    // Remember the newest rounds (not shown, not saved) so the next read of the game's list can
    // tell which rounds are new and which were simply still on the list.
    baseline = capture.status === 'live' && history.values.length ? history.values.slice(-300) : null;
    store.clear(history.origin);
    history = {origin: history.origin, values: [], times: [], gaps: []};
    broadcast();
    return {ok: true};
  }

  // Analysis of the captured rounds for the page: ?target=2&size=1000&stake=10 (size 0 = all).
  function analysis(q) {
    const num = (name, fallback, ok) => { const v = Number(q.get(name)); return q.get(name) !== null && ok(v) ? v : fallback; };
    const target = Math.round(num('target', 2, v => v > 1 && v <= 1000) * 100) / 100;
    const size = num('size', 0, v => Number.isInteger(v) && v >= 0);
    const stake = num('stake', 10, v => v > 0 && v <= 1e9);
    const stopLoss = num('stopLoss', 0, v => v >= 0 && v <= 1e12);
    return {ok: true, site: history.origin, total: history.values.length, ...Analysis.analyse(history, {target, size, stake, stopLoss})};
  }

  function csv() {
    const gaps = new Set(history.gaps);
    return 'sequence,multiplier,missed_rounds_before,captured_at\n' +
      history.values.map((v, i) => `${i + 1},${v},${gaps.has(i) ? 1 : 0},${new Date(history.times[i] || 0).toISOString()}`).join('\n');
  }

  const readJson = req => new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });

  const auth = createAuth(dataDir);
  publicHost = String(publicHost || '').trim().toLowerCase();

  // Who is asking, by the name the monitor was reached under and the sign-in cookie.
  function identify(req) {
    const host = (req.headers.host || '').toLowerCase();
    const shared = !!publicHost && host === publicHost;
    const known = shared || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    const authOn = auth.enabled();
    const token = (/(?:^|;\s*)monitor_sid=([a-f0-9]{64})/.exec(req.headers.cookie || '') || [])[1] || '';
    const user = authOn ? auth.who(token) : {name: '', role: 'admin'};
    const originOk = [`http://${host}`, ...(shared ? [`https://${host}`] : [])].includes(req.headers.origin);
    return {host, shared, known, authOn, token, user, originOk};
  }

  const server = http.createServer(async (req, res) => {
    // Reached as localhost by this computer's own browser, or under the shared name through the
    // web server in front. Other websites can't use it (checked by Host, and by Origin on every
    // action), and the shared name works only with accounts, never open.
    const {host, shared, known, authOn, token, user, originOk} = identify(req);
    if (!known) { res.writeHead(403).end('forbidden'); return; }
    const {pathname, searchParams} = new URL(req.url, `http://${host}`);
    const json = (code, body, headers = {}) => res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers}).end(JSON.stringify(body));
    if (shared && !authOn) { res.writeHead(403).end('Add an account first: node users.js add <name> admin'); return; }
    const cookie = (value, maxAge) => `monitor_sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
    if (req.method === 'POST' && req.headers.origin && !originOk) { res.writeHead(403).end('forbidden'); return; }
    if (req.method === 'GET' && pathname === '/login') {
      if (user) { res.writeHead(302, {Location: '/'}).end(); return; }
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
      return fs.createReadStream(LOGIN_PAGE).pipe(res);
    }
    if (req.method === 'POST' && pathname === '/api/login') {
      if (!authOn) return json(400, {ok: false, error: 'This monitor has no accounts.'});
      const b = await readJson(req);
      // Behind the web server every request comes from this computer; it passes the real address on.
      const address = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
      await new Promise(r => setTimeout(r, 250)); // Slows guessing.
      const r = auth.login(b.name, b.password, address);
      if (!r.ok) return json(r.locked ? 429 : 401, {ok: false, error: r.error});
      return json(200, {ok: true, name: r.name, role: r.role}, {'Set-Cookie': cookie(r.token, r.maxAge)});
    }
    if (!user) {
      if (req.method === 'GET' && pathname === '/') { res.writeHead(302, {Location: '/login'}).end(); return; }
      return json(401, {ok: false, error: 'Sign in first.'});
    }
    if (req.method === 'POST' && pathname === '/api/logout') { auth.logout(token); return json(200, {ok: true}, {'Set-Cookie': cookie('', 0)}); }
    if (req.method === 'GET' && pathname === '/api/me') return json(200, {ok: true, auth: authOn, name: user.name, role: user.role, gameWindow: !!gameWindowPort && user.role === 'admin'});
    // A viewer can look at everything on the page and change nothing: not the capture, the
    // tracked bets, the settings, or anything in the game.
    const viewer = user.role !== 'admin';
    if (viewer && (req.method === 'POST' || pathname === '/api/inspect' || pathname === '/api/diagnose' || pathname.startsWith('/vnc/'))) return json(403, {ok: false, error: 'This account can only view.'});
    // The game window itself, for an admin: the noVNC viewer running on this computer, passed
    // through the monitor so it sits behind the same sign-in. Whoever opens it controls the
    // browser that is logged in to the game.
    if (gameWindowPort && req.method === 'GET' && pathname.startsWith('/vnc/')) {
      const up = http.request({host: '127.0.0.1', port: gameWindowPort, method: 'GET', path: req.url.slice(4), headers: {Host: `127.0.0.1:${gameWindowPort}`}}, r => {
        res.writeHead(r.statusCode, {...r.headers, 'Cache-Control': 'no-store'});
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502, {'Content-Type': 'text/plain; charset=utf-8'}); res.end('The game window viewer is not running on the server.'); });
      return up.end();
    }
    if (req.method === 'POST') {
      const send = r => res.writeHead(r.ok ? 200 : 400, {'Content-Type': 'application/json'}).end(JSON.stringify(r));
      if (pathname === '/api/start') return send(await start((await readJson(req)).url));
      if (pathname === '/api/stop') return send(await stop());
      if (pathname === '/api/clear') return send(clear());
      if (pathname === '/api/bet') return send(placeBet(await readJson(req)));
      if (pathname === '/api/bet/undo') return send(undoBet());
      if (pathname === '/api/game/set') return send(await setGame(await readJson(req)));
      if (pathname === '/api/game/login') return send(await loginGame(await readJson(req)));
      if (pathname === '/api/game/click') return send(await clickGame(await readJson(req)));
      if (pathname === '/api/game/cutoff') return send(await handleCutOff(await readJson(req)));
      if (pathname === '/api/settings') return send(saveSettings(await readJson(req)));
      if (pathname === '/api/autobet') { const b = await readJson(req); return send(b.on ? startAutoBet(b) : stopAutoBet()); }
      if (pathname === '/api/bet/cashout') return send(cashOut(await readJson(req)));
      if (pathname === '/api/session') return send(resetSession((await readJson(req)).budget));
    } else if (req.method === 'GET') {
      if (pathname === '/') {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        return fs.createReadStream(PAGE).pipe(res);
      }
      if (STATIC[pathname]) {
        res.writeHead(200, {'Content-Type': STATIC[pathname], 'Cache-Control': 'no-store'});
        return fs.createReadStream(path.join(PUBLIC_DIR, pathname)).pipe(res);
      }
      if (pathname === '/api/analysis') return res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(analysis(searchParams)));
      if (pathname === '/api/days') return res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({ok: true, days: store.days()}));
      if (pathname === '/preview') {
        res.writeHead(200, {'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
        viewers.add(res);
        if (frame) writeFrame(res, frame);
        req.on('close', () => viewers.delete(res));
        return;
      }
      if (pathname === '/events') {
        res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
        res.write(`data: ${JSON.stringify(state())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (pathname === '/api/inspect') return res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(await inspect()));
      if (pathname === '/api/diagnose') return res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(await diagnose(), null, 1));
      if (pathname === '/api/state') return res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(state()));
      if (pathname === '/export.csv') {
        return res.writeHead(200, {'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="aviator-rounds.csv"'}).end(csv());
      }
    }
    res.writeHead(404).end('not found');
  });

  // The game window's live connection (a WebSocket to the noVNC viewer): admins only, and only
  // from the monitor's own page.
  const tunnels = new Set();
  server.on('upgrade', (req, socket, head) => {
    const {known, shared, authOn, user, originOk} = identify(req);
    const pathname = String(req.url).split('?')[0];
    if (!gameWindowPort || !known || (shared && !authOn) || !user || user.role !== 'admin' || !originOk || pathname !== '/vnc/websockify') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const up = net.connect(gameWindowPort, '127.0.0.1', () => {
      // Only what the handshake needs is passed on; the sign-in cookie stays here.
      const keep = Object.entries(req.headers).filter(([k]) => k === 'upgrade' || k === 'connection' || k.startsWith('sec-websocket-'));
      up.write(`GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:${gameWindowPort}\r\n${keep.map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
      if (head && head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const end = () => { tunnels.delete(socket); socket.destroy(); up.destroy(); };
    tunnels.add(socket);
    socket.on('error', end); socket.on('close', end);
    up.on('error', end); up.on('close', end);
  });

  // Keep event streams open through idle proxies and sleeping laptops.
  const ping = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);

  return {
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address().port)); }),
    close: async () => {
      clearInterval(ping);
      clearInterval(grabTimer);
      clearInterval(staleTimer);
      // Close the game window first (it sends a last update), then the open pages.
      await stop('');
      for (const res of viewers) res.end();
      for (const res of clients) res.end();
      viewers.clear();
      for (const s of tunnels) s.destroy();
      clients.clear();
      // An open monitor page keeps its connection alive; close it too, or quitting waits forever.
      const closed = new Promise(r => server.close(r));
      if (server.closeAllConnections) server.closeAllConnections();
      await closed;
    },
    state, start, stop,
    _context: () => context, // For tests.
  };
}

module.exports = {createMonitor};

if (require.main === module) {
  const port = Number(process.env.PORT) || 4321;
  const monitor = createMonitor({port, headless: process.env.MONITOR_HEADLESS === '1', publicHost: process.env.MONITOR_PUBLIC_HOST || '', gameWindowPort: Number(process.env.MONITOR_GAME_WINDOW_PORT) || 0});
  monitor.listen().then(p => {
    const url = `http://localhost:${p}`;
    console.log(`Aviator Live Monitor is running at ${url}  (press Ctrl+C to quit)`);
    if (process.env.MONITOR_NO_OPEN !== '1') {
      const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
      try { spawn(cmd, args, {stdio: 'ignore', detached: true}).unref(); } catch {}
    }
  }).catch(e => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy. Is the monitor already running? Open http://localhost:${port}` : e);
    process.exit(1);
  });
  // Ctrl+C quits. If closing the game window hangs, a second Ctrl+C (or 5 seconds) forces it.
  let quitting = false;
  const quit = () => {
    if (quitting) process.exit(0);
    quitting = true;
    console.log('Closing… (press Ctrl+C again to force)');
    setTimeout(() => process.exit(0), 5000).unref();
    monitor.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}
