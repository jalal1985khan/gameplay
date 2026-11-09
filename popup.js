const $ = (id) => document.getElementById(id);
let captured = [];
// Indexes into captured where rounds were missed before that value.
let gaps = [];
// Capture state kept by the background: tab, site, running/interrupted/stopped, timings.
let capture = null;
let target = 2;
let betLog = [];
const fmt = n => `${Number(n).toLocaleString(undefined,{maximumFractionDigits:2})}×`;
const pct = p => `${(p*100).toFixed(1)}%`;
const rupees = n => `₹${Math.round(n).toLocaleString()}`;
const num = id => Number($(id).value);
const ago = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const tag = r => r.verdict === 'too-few' ? `<span class="tag">need ${AviatorStats.MIN_CASES}+ cases</span>`
  : r.verdict === 'notable' ? `<span class="tag notable">notable · z ${r.z.toFixed(1)}</span>`
  : `<span class="tag">within noise · z ${r.z.toFixed(1)}</span>`;

function render() {
  $('count').textContent = captured.length;
  const q = AviatorStats.quality(captured, gaps);
  $('quality').textContent = q.rounds
    ? `${q.breaks ? `${q.breaks} missed-rounds break${q.breaks > 1 ? 's' : ''}` : 'No missed rounds'} · longest unbroken stretch ${q.longest} rounds`
    : '';
  if (!captured.length) {
    $('median').textContent = $('latest').textContent = $('over2').textContent = '—';
    $('liveHistory').className = 'recent empty';
    $('liveHistory').textContent = 'No values captured yet.';
    $('baseRate').className = 'empty';
    $('baseRate').textContent = 'Capture some rounds to see the odds.';
    $('trends').innerHTML = $('randomness').innerHTML = '';
    return;
  }
  const sorted = [...captured].sort((a,b)=>a-b), m = Math.floor(sorted.length/2);
  $('median').textContent = fmt(sorted.length%2 ? sorted[m] : (sorted[m-1]+sorted[m])/2);
  $('latest').textContent = fmt(captured[captured.length-1]);
  $('over2').textContent = `${(captured.filter(x=>x>=2).length/captured.length*100).toFixed(1)}%`;
  renderOdds();
  $('liveHistory').className = 'recent';
  const gapAt = new Set(gaps), chips = [];
  for (let i = captured.length - 1; i >= Math.max(0, captured.length - 40); i--) {
    const v = captured[i];
    chips.push(`<span class="chip ${v<1.5?'low':v>=5?'high':''}">${fmt(v)}</span>`);
    if (gapAt.has(i)) chips.push('<span class="chip gap" title="Rounds were missed here">missed rounds</span>');
  }
  $('liveHistory').innerHTML = chips.join('');
}

function renderOdds() {
  const b = AviatorStats.baseRate(captured, target);
  const ev = b.returnPer100;
  const match = AviatorStats.oddsMatch(captured, target);
  $('baseRate').className = '';
  $('baseRate').innerHTML =
    `<div class="sub">Share of captured rounds that reached ${target}×</div>` +
    `<div class="big">${pct(b.rate)}</div>` +
    `<div class="sub">${b.hits} of ${b.n} captured rounds · 95% range ${pct(b.ci[0])}–${pct(b.ci[1])} · game's built-in odds ${pct(b.expected)}</div>` +
    `<div class="ev ${ev < 100 ? 'loss' : 'gain'}">Need ${pct(b.breakEven)} to break even. In your data, ₹100 bets at ${target}× returned ₹${ev.toFixed(0)} on average.</div>` +
    (match.verdict === 'differs'
      ? `<div class="warn">Your data is far from the game's odds (z ${match.z.toFixed(1)}). Check capture quality first: missed or duplicate rounds are far more likely than a beatable game.</div>`
      : match.verdict === 'matches' ? `<div class="sub">Consistent with the game's odds (z ${match.z.toFixed(1)}): past rounds give no edge.</div>` : '');
  $('trends').innerHTML = AviatorStats.trendChecks(captured, target, gaps).map(t =>
    `<div class="trend"><div class="row"><span>${t.label}</span>${tag(t)}</div>` +
    `<div class="row sub"><span>Reached ${target}×: <span class="rate">${t.n ? pct(t.rate) : '—'}</span> (${t.hits}/${t.n})</span><span>other rounds ${pct(t.restRate)}</span></div></div>`).join('');
  const runs = AviatorStats.runsTest(captured, target, gaps), corr = AviatorStats.serialCorrelation(captured, gaps);
  const check = (label, r, detail) => `<div class="trend"><div class="row"><span>${label}</span>${tag(r)}</div><div class="row sub"><span>${detail}</span></div></div>`;
  $('randomness').innerHTML =
    check(`Do rounds reaching ${target}× come in streaks?`, runs,
      runs.verdict === 'too-few' ? `${runs.n} rounds so far` : `${runs.runs} streaks vs ${runs.expected.toFixed(1)} expected by chance`) +
    check('Does a high round tend to follow a high round?', corr,
      corr.verdict === 'too-few' ? `${corr.n} pairs so far` : `correlation ${corr.r.toFixed(3)} over ${corr.n} pairs (0 = no link)`);
}

function renderHealth() {
  const el = $('captureHealth'), now = Date.now();
  if (!capture || capture.state === 'stopped') { el.className = 'health'; el.textContent = capture?.note || 'Capture stopped.'; return; }
  if (capture.state === 'interrupted') { el.className = 'health bad'; el.textContent = capture.note || 'Capture interrupted.'; return; }
  if (!capture.lastSnapshotAt) {
    const late = now - capture.startedAt > 15000;
    el.className = late ? 'health bad' : 'health';
    el.textContent = late
      ? 'Running, but the results list has not been found. Make sure the game has loaded in the capture tab.'
      : 'Running. Looking for the game\'s results list…';
    return;
  }
  const missed = capture.lastGapAt && now - capture.lastGapAt < 600000 ? ` · rounds missed ${ago(now - capture.lastGapAt)} (marked)` : '';
  el.className = missed ? 'health bad' : 'health ok';
  el.textContent = `Running · results list found · last new round ${capture.lastRoundAt ? ago(now - capture.lastRoundAt) : 'not yet'}${missed}${capture.note ? ` · ${capture.note}` : ''}`;
}

$('targets').addEventListener('click', e => {
  const btn = e.target.closest('button[data-t]');
  if (!btn) return;
  target = Number(btn.dataset.t);
  for (const b of $('targets').children) b.classList.toggle('on', b === btn);
  render();
});
$('checkPlan').addEventListener('click', () => {
  const plan = {bet: num('planBet'), target: num('planTarget'), rounds: Math.min(2000, Math.round(num('planRounds'))), budget: num('planBudget')};
  if (!(plan.bet > 0 && plan.target > 1 && plan.rounds > 0 && plan.budget >= plan.bet)) {
    $('planResult').innerHTML = '<div class="verdict bad">Enter a bet, a target above 1×, a number of rounds, and a budget at least as big as one bet.</div>'; return;
  }
  chrome.storage.local.set({plan});
  const r = AviatorStats.simulatePlan(plan);
  const line = (k, v) => `<div class="line"><span>${k}</span><b>${v}</b></div>`;
  const risky = r.bustChance >= 0.2 || plan.bet > plan.budget * 0.1;
  $('planResult').innerHTML =
    line('Total you would bet', rupees(r.totalWagered)) +
    line('Expected cost of this plan', `−${rupees(r.expectedLoss)}`) +
    line('Chance you finish ahead', pct(r.profitChance)) +
    line('Chance you lose the whole budget', pct(r.bustChance)) +
    line('Typical budget left at the end', rupees(r.medianEnd)) +
    line('Bad session (1 in 10) leaves you with', rupees(r.worst10)) +
    `<div class="verdict ${risky ? 'bad' : ''}">${risky
      ? `High risk: ${plan.bet > plan.budget * 0.1 ? 'each bet is more than 10% of your budget' : 'you have a big chance of losing the whole budget'}. Smaller bets or fewer rounds lower the risk.`
      : `Lower risk, but on average this plan still costs about ${rupees(r.expectedLoss)}. Only play with money you are fine losing.`}</div>`;
  renderLog();
});

// ---- Strategy tester ----
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const signed = n => `${n < 0 ? '−' : '+'}${rupees(Math.abs(n))}`;
function testStrategy() {
  const text = $('strategyText').value.trim();
  if (!text) { $('strategyResult').innerHTML = '<div class="verdict bad">Describe a strategy first, or pick one of the examples.</div>'; return; }
  chrome.storage.local.set({strategyText: text});
  const p = AviatorStrategy.parse(text);
  const line = (k, v) => `<div class="line"><span>${k}</span><b>${v}</b></div>`;
  let html = `<h4>How I read it</h4><ul>${AviatorStrategy.describe(p.strategy).map(d => `<li>${esc(d)}</li>`).join('')}</ul>`;
  if (p.ignored.length) html += `<div class="warn">Not understood, so ignored: ${esc(p.ignored.join(', '))}. Rephrase it if it matters.</div>`;
  if (p.errors.length) { $('strategyResult').innerHTML = html + p.errors.map(e => `<div class="verdict bad">${esc(e)}</div>`).join(''); return; }
  const sim = AviatorStrategy.simulate(p.strategy);
  html += `<h4>2,000 simulated sessions (game's real odds)</h4>` +
    line('Rounds bet that won', pct(sim.hitRate)) +
    line('Sessions that finished ahead', pct(sim.aheadChance)) +
    line('Average result per session', signed(sim.avgNet)) +
    line('Return per ₹100 bet', `₹${sim.returnPer100.toFixed(1)}`) +
    line('Ran out of money for the next bet', pct(sim.bustChance)) +
    (p.strategy.stopLoss ? line('Hit the stop-loss', pct(sim.stopLossChance)) : '') +
    (p.strategy.takeProfit ? line('Hit the take-profit', pct(sim.takeProfitChance)) : '') +
    line('Typical session', signed(sim.medianNet)) +
    line('Bad session (1 in 10)', signed(sim.worst10)) +
    line('Biggest single bet', rupees(sim.biggestBet));
  if (captured.length >= 50) {
    const bt = AviatorStrategy.backtest(p.strategy, captured, gaps);
    html += `<h4>On your ${captured.length} captured rounds</h4>` + (bt.bets
      ? line('Sessions played', bt.sessions) + line('Bets placed', `${bt.bets} (won ${pct(bt.hitRate)})`) +
        line('Total bet', rupees(bt.wagered)) + line('Net result', signed(bt.net)) +
        line('Sessions ahead / out of money', `${pct(bt.aheadChance)} / ${pct(bt.bustChance)}`) +
        line('Longest losing run', `${bt.longestLossRun} bets`) +
        `<div class="sub">One run of real history is a small, lucky-or-unlucky sample. The simulation above is the reliable number.</div>`
      : '<div class="sub">The strategy never placed a bet on this history.</div>');
  } else html += `<div class="sub">Capture at least 50 rounds to also replay it on real history (${captured.length} so far).</div>`;
  const notes = AviatorStrategy.verdict(sim);
  html += notes.map((n, i) => `<div class="verdict ${i ? 'bad' : ''}">${esc(n)}</div>`).join('');
  $('strategyResult').innerHTML = html;
}
$('testStrategy').addEventListener('click', testStrategy);
$('strategyPresets').addEventListener('click', e => {
  const btn = e.target.closest('button[data-s]');
  if (!btn) return;
  $('strategyText').value = btn.dataset.s;
  testStrategy();
});

function renderLog() {
  const review = AviatorStats.reviewLog(betLog, num('planBudget'));
  $('logWarnings').innerHTML = review.warnings.map(w => `<div class="warn">${w}</div>`).join('');
  $('logSummary').innerHTML =
    `<article><span>Rounds</span><strong>${review.rounds}</strong></article>` +
    `<article><span>Wagered</span><strong>${rupees(review.wagered)}</strong></article>` +
    `<article><span>Net</span><strong>${review.net < 0 ? '−' : '+'}${rupees(Math.abs(review.net))}</strong></article>`;
  $('logList').innerHTML = betLog.slice(-20).reverse().map(e =>
    `<span class="chip ${e.won ? 'win' : 'loss'}">${rupees(e.bet)} ${e.won ? `→ ${rupees(e.won)}` : 'lost'}</span>`).join('');
}
$('planBudget').addEventListener('input', renderLog);
$('logAdd').addEventListener('click', () => {
  const bet = num('logBet'), cashout = num('logCashout');
  if (!(bet > 0) || !Number.isFinite(cashout) || (cashout && cashout < 1)) { $('liveStatus').textContent = 'Enter a bet above 0 and a cash-out of at least 1× (blank if lost).'; return; }
  betLog.push({bet, won: cashout ? bet * cashout : 0, at: Date.now()});
  chrome.storage.local.set({betLog});
  $('logCashout').value = '';
  $('liveStatus').textContent = '';
  renderLog();
});
$('logReset').addEventListener('click', () => { betLog = []; chrome.storage.local.set({betLog}); renderLog(); });

function normalizeUrl(raw) {
  try { const u = new URL(raw); return ['http:','https:'].includes(u.protocol) ? u.origin : null; } catch { return null; }
}
$('saveUrl').addEventListener('click', async () => {
  const origin = normalizeUrl($('siteUrl').value.trim());
  if (!origin) { $('liveStatus').textContent = 'Enter a valid http:// or https:// website URL.'; return; }
  await chrome.storage.local.set({siteUrl: $('siteUrl').value.trim()});
  $('liveStatus').textContent = `Saved website origin: ${origin}`;
});
$('start').addEventListener('click', async () => {
  const raw = $('siteUrl').value.trim();
  const origin = normalizeUrl(raw);
  if (!origin) { $('liveStatus').textContent = 'Enter a valid http:// or https:// website URL first.'; return; }
  // The game usually runs in an iframe on the provider's own domain, which activeTab does not cover.
  // Requested before any other await so the click still counts as a user gesture.
  const granted = await chrome.permissions.request({origins:['<all_urls>']}).catch(() => false);
  if (!granted) { $('liveStatus').textContent = 'Site access was declined, so the game iframe cannot be read. Click Start again and allow access.'; return; }
  await chrome.storage.local.set({siteUrl: raw});
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  // Exact origin match: a prefix check would also accept e.g. https://site.com.evil.example.
  if (!tab?.id || normalizeUrl(tab.url || '') !== origin) {
    $('liveStatus').textContent = `Open the configured game website (${origin}) in the active tab, then start capture again.`; return;
  }
  const result = await chrome.runtime.sendMessage({type: 'AVIATOR_CAPTURE_START', tabId: tab.id, origin}).catch(e => ({ok: false, error: e?.message}));
  $('liveStatus').textContent = result?.ok
    ? 'Capture started. It keeps running if you switch tabs, and resumes by itself if the game page reloads.'
    : `Could not attach: ${result?.error || 'unknown error'}. Refresh the game tab and try again. Some embedded games cannot be read.`;
});
$('stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({type: 'AVIATOR_CAPTURE_STOP'}).catch(() => {});
  $('liveStatus').textContent = '';
});
$('clearLive').addEventListener('click', async () => {
  captured = []; gaps = [];
  await chrome.storage.local.set({captured: [], gaps: []});
  render();
  $('liveStatus').textContent = 'Local capture history cleared.';
});
$('export').addEventListener('click', () => {
  if (!captured.length) { $('liveStatus').textContent='No captured values to export.'; return; }
  const gapAt = new Set(gaps);
  const csv = 'sequence,multiplier,missed_rounds_before\n'+captured.map((v,i)=>`${i+1},${v},${gapAt.has(i)?1:0}`).join('\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a'); a.href=url; a.download='aviator-live-history.csv'; a.click(); URL.revokeObjectURL(url);
});

// ---- Cloud sync ----
let cloud = null, cloudStatus = {};
function renderCloud() {
  const el = $('cloudStatus');
  if (!cloud?.url) { $('cloudBadge').textContent = 'off'; el.className = 'health'; el.textContent = 'Cloud sync is off.'; return; }
  const pending = cloudStatus.pending ? ` · ${cloudStatus.pending} round${cloudStatus.pending > 1 ? 's' : ''} waiting` : '';
  if (cloudStatus.error) {
    $('cloudBadge').textContent = 'problem';
    el.className = 'health bad';
    el.textContent = `${cloudStatus.error}${pending}`;
  } else {
    $('cloudBadge').textContent = 'on';
    el.className = cloudStatus.okAt ? 'health ok' : 'health';
    el.textContent = `Sending to ${cloud.url}${cloudStatus.okAt ? ` · last upload ${ago(Date.now() - cloudStatus.okAt)}` : ' · waiting for the first round'}${pending}`;
  }
}
$('cloudSave').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({type: 'AVIATOR_CLOUD_SET', url: $('cloudUrl').value.trim(), key: $('cloudKey').value.trim()}).catch(e => ({ok: false, error: e?.message}));
  $('liveStatus').textContent = res?.ok ? 'Cloud sync saved. New rounds are uploaded as they are captured.' : `Cloud sync not saved: ${res?.error || 'unknown error'}`;
});
$('cloudOff').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({type: 'AVIATOR_CLOUD_SET', url: '', key: ''}).catch(() => {});
  $('cloudKey').value = '';
  $('liveStatus').textContent = 'Cloud sync turned off. Rounds waiting for upload were discarded.';
});

// Storage is the single source of truth: the background stores rounds and capture state.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.capture) { capture = changes.capture.newValue || null; renderHealth(); }
  if (changes.cloud || changes.cloudStatus) {
    if (changes.cloud) cloud = changes.cloud.newValue || null;
    if (changes.cloudStatus) cloudStatus = changes.cloudStatus.newValue || {};
    renderCloud();
  }
  if (!changes.captured && !changes.gaps) return;
  if (changes.gaps) gaps = Array.isArray(changes.gaps.newValue) ? changes.gaps.newValue.filter(Number.isInteger) : [];
  if (changes.captured) captured = Array.isArray(changes.captured.newValue) ? changes.captured.newValue.filter(Number.isFinite) : [];
  render();
});
chrome.storage.local.get(['siteUrl','captured','gaps','plan','betLog','capture','cloud','cloudStatus','strategyText'], data => {
  if (typeof data.strategyText === 'string') $('strategyText').value = data.strategyText;
  cloud = data.cloud || null; cloudStatus = data.cloudStatus || {};
  if (cloud?.url) { $('cloudUrl').value = cloud.url; $('cloudKey').value = cloud.key || ''; }
  renderCloud();
  if (cloud?.url) chrome.runtime.sendMessage({type: 'AVIATOR_CLOUD_FLUSH'}).catch(() => {});
  if (data.siteUrl) $('siteUrl').value = data.siteUrl;
  if (data.plan) for (const [k, v] of Object.entries(data.plan)) { const input = $(`plan${k[0].toUpperCase()}${k.slice(1)}`); if (input) input.value = v; }
  if (Array.isArray(data.betLog)) betLog = data.betLog.filter(e => Number.isFinite(e?.bet) && Number.isFinite(e?.won));
  if (data.plan?.bet) $('logBet').value = data.plan.bet;
  renderLog();
  if (Array.isArray(data.gaps)) gaps = data.gaps.filter(Number.isInteger);
  if (Array.isArray(data.captured)) captured = data.captured.filter(Number.isFinite);
  capture = data.capture || null;
  render();
  renderHealth();
});
// Keep "last new round … ago" current while the popup is open.
setInterval(() => { renderHealth(); renderCloud(); }, 5000);
