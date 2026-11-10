// Aviator Live Monitor: a small local server with one page. You enter the game URL and click
// Start live capture; it opens the game in a real browser window where you log in as usual,
// reads each finished round from the game's results list, and streams it to the monitor page.
// Runs only on this computer (127.0.0.1). It never reads or stores logins, and never places bets.
const http = require('http');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const AviatorMatch = require('./lib/match.js');
const Analysis = require('./lib/analysis.js');
const {createStore, atomicWrite} = require('./lib/store.js');

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

function createMonitor({
  port = 4321,
  headless = false,
  dataDir = path.join(__dirname, 'data'),
  profileDir = path.join(__dirname, 'browser-profile'),
  launch = null, // For tests: a function returning a Playwright browser context.
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
    if (balance === 0) warnings.push('Your game balance is ₹0.00, so the game cannot place any bet. Bets recorded here are practice only, not real play.');
    if (autoBet && slots.length) {
      const real = slots.find(x => x.autoPlay) || slots[0];
      if (real.bet !== null && real.bet !== autoBet.stake) warnings.push(`The game's bet is ₹${real.bet}, but you are tracking ₹${autoBet.stake}. Press "Use the game's settings" or change the game's bet.`);
      if (real.autoCashOut === false) warnings.push('Auto Cash Out is OFF in the game, so it will not exit at your target by itself.');
      else if (real.target !== null && real.target !== autoBet.target) warnings.push(`The game's Auto Cash Out is ${real.target}×, but you are tracking ${autoBet.target}×.`);
      if (!slots.some(x => x.autoPlay) && slots.some(x => x.autoPlay === false)) warnings.push('Auto Play looks OFF in the game, so it may not be betting every round.');
    }
    if (balance !== null && balance > 0 && autoBet && balance < autoBet.stake) warnings.push(`Your game balance (₹${balance}) is less than the bet, so the game cannot place it.`);
    const stats = Analysis.sessionStats(session.bets);
    if (stats.chaseRun >= 2) warnings.push('You raised your bet after each of your last losses. That is chasing losses: go back to your planned bet, or stop for today.');
    else if (stats.chases >= 3) warnings.push(`You have raised your bet right after a loss ${stats.chases} times today.`);
    return {
      stats,
      budget: session.budget, stopLoss, net, left: session.budget + net, startedAt: session.startedAt,
      balance, balanceStart, realNet, realStopped, warnings,
      game: panel ? {slots, gameAutoPlay, at: panel.at} : null,
      bets: done.length, wins: done.filter(b => b.result === 'won').length,
      pending, awaiting, cooldownLeft, stopped, autoBet,
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
    return {ok: true};
  }

  function resetSession(budget) {
    budget = Math.round(Number(budget));
    if (!(budget > 0)) return {ok: false, error: 'Enter the money you are ready to lose today.'};
    archiveDay();
    session = newSession(budget);
    session.balanceStart = panel ? panel.balance : null;
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
  function settleBets(fresh, gap) {
    const pending = session.bets.find(b => b.result === 'pending');
    if (pending) {
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
    if (session.autoBet) {
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
    seen += fresh.length;
    saveSession();
  }
  // The game's own bet panel as last read (balance, bet slots), or null when not seen.
  let panel = null;
  let capture = {status: 'stopped', note: '', url: '', startedAt: 0, lastSnapshotAt: 0, lastRoundAt: 0, source: '', sawPlain: false};
  let context = null, stopping = false;
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

  function onPanel(p) {
    if (!p || typeof p !== 'object' || !['waiting', 'live'].includes(capture.status)) return;
    const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const slots = Array.isArray(p.slots) ? p.slots.slice(0, 4).map(x => ({
      bet: num(x && x.bet), target: num(x && x.target),
      autoCashOut: typeof (x && x.autoCashOut) === 'boolean' ? x.autoCashOut : null,
      autoPlay: typeof (x && x.autoPlay) === 'boolean' ? x.autoPlay : null,
      button: typeof (x && x.button) === 'string' ? x.button.slice(0, 40) : null,
    })) : [];
    panel = {balance: num(p.balance), slots, at: Date.now()};
    // The day's starting balance: the first one seen after the day began.
    if (panel.balance !== null && (session.balanceStart === undefined || session.balanceStart === null)) {
      session.balanceStart = panel.balance;
      saveSession();
    }
    broadcast();
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
    const patch = {...extra, lastSnapshotAt: now, status: 'live', note: ''};
    if (fresh.length) {
      settleBets(fresh, gap);
      const next = AviatorMatch.append(history.values, history.gaps, fresh, gap, MAX_ROUNDS);
      const times = [...history.times, ...fresh.map(() => now)].slice(-next.captured.length);
      store.append(history.origin, fresh, now, gap && history.values.length > 0);
      history = {...history, values: next.captured, times, gaps: next.gaps};
      patch.lastRoundAt = now;
    }
    setCapture(patch);
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
    castPage = null; castSession = null; frame = null; gamePage = null; panel = null;
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
              type: el.type, checked: el.type === 'checkbox' ? el.checked : undefined, disabled: el.disabled || undefined});
          }
          return rows;
        })});
      } catch (e) { out.push({url: frame.url().slice(0, 120), error: String(e.message).split('\n')[0]}); }
    }
    return {ok: true, frames: out};
  }

  function clear() {
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

  const server = http.createServer(async (req, res) => {
    // Only this computer's own browser may use the monitor: other websites can't open game
    // windows or read rounds through it (checked by Host, and by Origin on every action).
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { res.writeHead(403).end('forbidden'); return; }
    const {pathname, searchParams} = new URL(req.url, `http://${host}`);
    if (req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `http://${host}`) { res.writeHead(403).end('forbidden'); return; }
      const send = r => res.writeHead(r.ok ? 200 : 400, {'Content-Type': 'application/json'}).end(JSON.stringify(r));
      if (pathname === '/api/start') return send(await start((await readJson(req)).url));
      if (pathname === '/api/stop') return send(await stop());
      if (pathname === '/api/clear') return send(clear());
      if (pathname === '/api/bet') return send(placeBet(await readJson(req)));
      if (pathname === '/api/bet/undo') return send(undoBet());
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
  const monitor = createMonitor({port, headless: process.env.MONITOR_HEADLESS === '1'});
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
