// Charts and tables built from the captured rounds and the day's tracked bets. Loaded after the
// page's own script and uses its helpers ($, money, signed, pct, fmt, state, target, post).
// Everything shown is computed from real captured rounds; nothing predicts a round.
const AnalysisUI = (() => {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const setHtml = (el, html) => { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } };
  const x2 = v => `${Number(v).toLocaleString(undefined, {maximumFractionDigits: 2})}×`;
  const share = p => `${(p * 100).toFixed(1)}%`;

  // ---- One tooltip for every chart ----
  const tip = document.createElement('div');
  tip.className = 'viz-tip';
  tip.hidden = true;
  document.body.append(tip);
  function showTip(html, ev) {
    tip.innerHTML = html;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, ev.clientX + 14))}px`;
    tip.style.top = `${Math.max(8, ev.clientY - h - 12)}px`;
  }
  const hideTip = () => { tip.hidden = true; };
  document.addEventListener('mousemove', ev => {
    const mark = ev.target.closest && ev.target.closest('[data-tip]');
    if (mark) showTip(mark.dataset.tip, ev);
    else if (!ev.target.closest || !ev.target.closest('.viz-line')) hideTip();
  });

  // A column with a rounded top and a square foot on the baseline.
  function column(x, y, w, h) {
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  const W = 640;

  // ---- Latest rounds: how high each one went, on a log scale ----
  function roundsChart(el, recent, tgt) {
    const rows = recent.slice(0, 60).reverse(); // Oldest on the left.
    if (rows.length < 2) { setHtml(el, '<p class="empty">Shown once a few rounds are captured.</p>'); return; }
    const W = 1100, H = 200, L = 40, R = 10, T = 12, B = 22; // A wide panel: a wider drawing, so the text stays small.
    const top = Math.max(10, ...rows.map(r => r.v), tgt * 1.2);
    const y = v => T + (H - T - B) * (1 - Math.log(Math.min(top, Math.max(1, v))) / Math.log(top));
    const slot = (W - L - R) / 60, bw = Math.min(24, slot - 2);
    const ticks = [1, 2, 5, 10, 20, 50, 100, 1000, 10000].filter(t => t <= top);
    let svg = '';
    for (const t of ticks) svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t}×</text>`;
    rows.forEach((r, i) => {
      const x = L + (60 - rows.length + i) * slot + 1, yy = y(r.v), h = Math.max(1.5, H - B - yy);
      const when = r.at ? new Date(r.at).toLocaleTimeString() : '';
      svg += `<path class="${r.v >= tgt ? 's1' : 's2'}" d="${column(x, H - B - h, bw, h)}" data-tip="<b>${fmt(r.v)}</b>${when ? `<br>${when}` : ''}<br>${r.v >= tgt ? `reached ${x2(tgt)}` : `ended before ${x2(tgt)}`}"/>`;
    });
    svg += `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(tgt)}" y2="${y(tgt)}"/>`;
    svg += `<text class="tick" x="${L}" y="${H - 5}">older</text><text class="tick" x="${W - R}" y="${H - 5}" text-anchor="end">newest</text>`;
    setHtml(el, `<div class="legend"><span><i class="k s1"></i>Reached ${x2(tgt)}</span><span><i class="k s2"></i>Ended before ${x2(tgt)}</span><span><i class="k line"></i>Your target</span></div>` +
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="The last ${rows.length} rounds, oldest to newest">${svg}</svg>`);
  }

  // ---- Where rounds ended, next to the share the game's odds give ----
  function distributionChart(el, d, n) {
    const H = 200, L = 40, R = 10, T = 12, B = 24;
    const top = Math.max(0.2, ...d.bands.map(b => Math.max(b.share, b.expected))) * 1.1;
    const y = p => T + (H - T - B) * (1 - p / top);
    const slot = (W - L - R) / d.bands.length, bw = 24;
    let svg = '';
    for (let t = 0; t <= top; t += 0.05) svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${Math.round(t * 100)}%</text>`;
    d.bands.forEach((b, i) => {
      const cx = L + slot * (i + 0.5), yy = y(b.share), name = b.hi ? `${b.lo}× to ${b.hi}×` : `${b.lo}× and up`;
      const tipText = `<b>${name}</b><br>Your rounds: ${share(b.share)} (${b.count.toLocaleString()} of ${n.toLocaleString()})<br>Game's odds: ${share(b.expected)}`;
      svg += `<rect class="hit" x="${cx - slot / 2}" y="${T}" width="${slot}" height="${H - T - B}" data-tip="${esc(tipText)}"/>`;
      if (b.count) svg += `<path class="s1" d="${column(cx - bw / 2, yy, bw, H - B - yy)}" data-tip="${esc(tipText)}"/>`;
      svg += `<line class="mark" x1="${cx - 18}" x2="${cx + 18}" y1="${y(b.expected)}" y2="${y(b.expected)}"/>`;
      svg += `<text class="tick" x="${cx}" y="${H - 6}" text-anchor="middle">${b.hi ? `${b.lo}–${b.hi}×` : `${b.lo}×+`}</text>`;
    });
    setHtml(el, `<div class="legend"><span><i class="k s1"></i>Your captured rounds</span><span><i class="k mark"></i>The game's odds</span></div>` +
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of rounds that ended in each multiplier band">${svg}</svg>`);
  }

  // ---- A running total as a line, with a crosshair ----
  // points: [{i, net}]; unit names what i counts ("bet" or "round").
  const lines = new WeakMap();
  function lineChart(el, points, unit, label) {
    if (points.length < 2) { setHtml(el, `<p class="empty">Shown after the first ${unit}s.</p>`); return; }
    const H = 180, L = 56, R = 64, T = 12, B = 22;
    const lo = Math.min(0, ...points.map(p => p.net)), hi = Math.max(0, ...points.map(p => p.net));
    const span = hi - lo || 1, last = points.at(-1), maxI = last.i || 1;
    const x = i => L + (W - L - R) * i / maxI, y = v => T + (H - T - B) * (1 - (v - lo) / span);
    const path = points.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.net).toFixed(1)}`).join('');
    let svg = '';
    for (const v of [...new Set([lo, 0, hi])]) svg += `<line class="${v === 0 ? 'zero' : 'grid'}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v === 0 ? '₹0' : signed(v)}</text>`;
    svg += `<path class="area" d="${path}L${x(last.i).toFixed(1)},${y(0)}L${x(points[0].i)},${y(0)}Z"/><path class="line" d="${path}"/>`;
    svg += `<circle class="dot" cx="${x(last.i)}" cy="${y(last.net)}" r="4"/><text class="end" x="${x(last.i) + 8}" y="${y(last.net) + 4}">${signed(last.net)}</text>`;
    svg += `<text class="tick" x="${L}" y="${H - 5}">first ${unit}</text><text class="tick" x="${W - R}" y="${H - 5}" text-anchor="end">${unit} ${maxI.toLocaleString()}</text>`;
    svg += `<line class="cross" y1="${T}" y2="${H - B}" hidden/><circle class="dot cross-dot" r="4" hidden/>`;
    setHtml(el, `<svg class="viz-line" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${svg}</svg>`);
    lines.set(el, {points, x, y, unit, label});
    if (!el.dataset.bound) {
      el.dataset.bound = '1';
      el.addEventListener('mousemove', ev => {
        const c = lines.get(el), svgEl = el.querySelector('svg');
        if (!c || !svgEl) return;
        const box = svgEl.getBoundingClientRect(), px = (ev.clientX - box.left) / box.width * W;
        let best = c.points[0];
        for (const p of c.points) if (Math.abs(c.x(p.i) - px) < Math.abs(c.x(best.i) - px)) best = p;
        const cross = svgEl.querySelector('.cross'), dot = svgEl.querySelector('.cross-dot');
        cross.setAttribute('x1', c.x(best.i)); cross.setAttribute('x2', c.x(best.i)); cross.removeAttribute('hidden');
        dot.setAttribute('cx', c.x(best.i)); dot.setAttribute('cy', c.y(best.net)); dot.removeAttribute('hidden');
        showTip(`<b>${signed(best.net)}</b><br>after ${best.i.toLocaleString()} ${c.unit}${best.i === 1 ? '' : 's'}`, ev);
      });
      el.addEventListener('mouseleave', () => {
        hideTip();
        for (const n of el.querySelectorAll('.cross,.cross-dot')) n.setAttribute('hidden', '');
      });
    }
  }

  // ---- Tables and checks ----
  const VERDICT = {
    matches: ['ok', "Matches the game's odds"],
    differs: ['bad', "Differs from the game's odds"],
    noise: ['ok', 'No pattern: within chance'],
    notable: ['warn', 'Unusual'],
  };
  const badge = (v, need) => v === 'too-few' ? `<span class="vb muted">Too few rounds${need ? ` (needs ${need})` : ''}</span>` : `<span class="vb ${VERDICT[v][0]}">${VERDICT[v][1]}</span>`;

  function ladderTable(a) {
    return `<table class="rtable"><thead><tr><th>Cash-out</th><th>Reached it</th><th>Your rounds</th><th>Likely range</th><th>Game's odds</th><th>Check</th></tr></thead><tbody>` +
      a.ladder.map(r => `<tr${r.target === a.target ? ' class="sel"' : ''}><td>${x2(r.target)}</td><td>${r.hits.toLocaleString()}</td><td>${a.rounds ? share(r.rate) : '—'}</td>` +
        `<td>${a.rounds ? `${share(r.ci[0])} – ${share(r.ci[1])}` : '—'}</td><td>${share(r.expected)}</td><td>${badge(r.verdict, a.minCases)}</td></tr>`).join('') + '</tbody></table>';
  }

  function checksList(a) {
    const c = a.checks, rows = [];
    rows.push([`Share that reached ${x2(a.target)}`, a.rounds ? `${share(a.base.rate)} of your rounds, ${share(a.base.expected)} by the game's odds` : '', badge(c.odds.verdict, a.minCases)]);
    rows.push(['Where rounds ended (all bands together)', a.distribution.verdict === 'too-few' ? '' : `chi-square ${a.distribution.chi2.toFixed(1)} (20.1 or more would differ)`, badge(a.distribution.verdict)]);
    rows.push(['Wins and losses in streaks or alternating', c.runs.verdict === 'too-few' ? '' : `${c.runs.runs} runs seen, ${c.runs.expected.toFixed(0)} expected by chance`, badge(c.runs.verdict, a.minCases)]);
    rows.push(['A high round followed by a high round', c.serial.verdict === 'too-few' ? '' : `correlation ${c.serial.r.toFixed(3)} (0 = none)`, badge(c.serial.verdict, a.minCases)]);
    for (const t of c.trends) rows.push([t.label, t.n ? `${share(t.rate)} reached ${x2(a.target)} in ${t.n.toLocaleString()} cases, ${share(t.restRate)} otherwise` : 'has not happened yet', badge(t.verdict, a.minCases)]);
    const odd = [c.runs, c.serial, ...c.trends].some(t => t.verdict === 'notable');
    const off = c.odds.verdict === 'differs' || a.distribution.verdict === 'differs';
    return `<div class="checks">${rows.map(r => `<div><span><b>${esc(r[0])}</b>${r[1] ? `<small>${esc(r[1])}</small>` : ''}</span>${r[2]}</div>`).join('')}</div>` +
      (off ? `<p class="fine">A difference from the game's odds most often means rounds were missed or read twice${a.quality.breaks ? ` (this history has ${a.quality.breaks} missed-rounds break${a.quality.breaks > 1 ? 's' : ''})` : ''}. It is not a way to win.</p>` : '') +
      (odd ? '<p class="fine">"Unusual" means the past rounds differ from chance on that one check. Ten checks run at once, so one can stand out by luck, and it says nothing about the next round.</p>' : '');
  }

  function tiles(a) {
    const s = a.streaks, p = a.pace;
    const tile = (label, value, note) => `<div class="tile"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`;
    return tile('Rounds analysed', a.rounds.toLocaleString(), a.from ? `since ${new Date(a.from).toLocaleDateString()} ${new Date(a.from).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}` : 'none yet') +
      tile('Pace', p.roundsPerHour ? `${p.roundsPerHour}/hour` : '—', p.secondsPerRound ? `one round about every ${p.secondsPerRound} s` : 'shown after a few live rounds') +
      tile(`Rounds in a row under ${x2(a.target)}`, s.current, `longest seen: ${s.longest}. The next round still has a ${share(1 - s.missChance)} chance.`) +
      tile(`Back per ₹100 at ${x2(a.target)}`, a.rounds ? `₹${a.base.returnPer100.toFixed(1)}` : '—', `the game's odds give ₹97. Breaks: ${a.quality.breaks}`);
  }

  function backtestHtml(a) {
    const b = a.backtest;
    if (!b.bets) return '';
    const line = (k, v, cls = '') => `<div><span>${k}</span><b class="${cls}">${v}</b></div>`;
    return `<div class="lines">` +
      line(`${money(b.stake)} at ${x2(b.target)} on each of these ${b.bets.toLocaleString()} rounds`, `${signed(b.net)}`, b.net > 0 ? 'good' : b.net < 0 ? 'bad' : '') +
      line("What the game's odds give on that many bets", signed(b.expectedNet), 'bad') +
      line('Won / lost', `${b.wins.toLocaleString()} / ${b.losses.toLocaleString()}`) +
      line('Biggest drop from a high point', `−${money(b.maxDrawdown)}`) +
      line('Most losses in a row', b.longestLosses) +
      (b.stoppedAt !== null ? line('Your stop-loss would have ended it', `after ${b.stoppedAt.toLocaleString()} bets`, 'bad') : '') +
      `</div><p class="fine">This replays rounds that already happened. A good stretch here does not carry on: every bet costs about 3% on average.</p>`;
  }

  // ---- Fetching ----
  let size = 1000, lastKey = '', lastAt = 0, timer = 0, inFlight = false, shown = null;
  try { const s = localStorage.getItem('analysisSize'); if (s !== null && [200, 1000, 5000, 0].includes(Number(s))) size = Number(s); } catch {}

  function renderAnalysis(a) {
    shown = a;
    setHtml($('aTiles'), tiles(a));
    distributionChart($('aDist'), a.distribution, a.rounds);
    setHtml($('aLadder'), ladderTable(a));
    setHtml($('aChecks'), checksList(a));
    setHtml($('aBack'), backtestHtml(a));
    lineChart($('aBackChart'), a.backtest.points, 'round', `Running result of ${money(a.backtest.stake)} at ${x2(a.target)} on every captured round`);
    $('aBackTitle').textContent = `If you had bet the same on every round: ${money(a.backtest.stake)} at ${x2(a.target)}`;
    $('aSite').textContent = a.site ? a.site.replace(/^https?:\/\//, '') : '';
  }

  async function load(key, query) {
    inFlight = true;
    try {
      const a = await (await fetch(`/api/analysis?${query}`)).json();
      if (a.ok) { lastKey = key; renderAnalysis(a); }
    } catch {} finally { inFlight = false; lastAt = Date.now(); }
  }

  function update() {
    if (!state) return;
    for (const b of $('aSizes').children) b.classList.toggle('on', Number(b.dataset.size) === size);
    roundsChart($('aRounds'), state.recent, target);
    const stake = Number($('stakeInput').value) > 0 ? Number($('stakeInput').value) : 10;
    const stop = state.session ? state.session.stopLoss : 0;
    const query = `target=${target}&size=${size}&stake=${stake}&stopLoss=${stop}`;
    const key = `${state.site}|${state.count}|${state.breaks}|${query}`;
    if (key === lastKey || inFlight) return;
    // New rounds arrive every few seconds; ask at most once per 1.5 s.
    clearTimeout(timer);
    timer = setTimeout(() => load(key, query), Math.max(0, 1500 - (Date.now() - lastAt)));
  }

  $('aSizes').addEventListener('click', e => {
    const b = e.target.closest('button[data-size]');
    if (!b) return;
    size = Number(b.dataset.size);
    try { localStorage.setItem('analysisSize', size); } catch {}
    lastAt = 0;
    update();
  });

  // ---- Past days ----
  let daysKey = '';
  async function loadDays() {
    const ses = state && state.session;
    const key = ses ? String(ses.startedAt) : '';
    if (!ses || key === daysKey) return;
    daysKey = key;
    try {
      const r = await (await fetch('/api/days')).json();
      const rows = (r.days || []).map(d => `<tr><td>${new Date(d.startedAt).toLocaleDateString()}</td><td>${d.bets}</td><td>${d.bets ? pct(d.wins / d.bets) : '—'}</td><td>${money(d.wagered)}</td>` +
        `<td>−${money(d.maxDrawdown || 0)}</td><td><b class="${d.net > 0 ? 'good' : d.net < 0 ? 'bad' : ''}">${signed(d.net)}</b>${d.stopped ? ' <span class="tag">stop-loss</span>' : ''}</td></tr>`).join('');
      const total = (r.days || []).reduce((a, d) => a + d.net, 0);
      $('daysNote').textContent = r.days && r.days.length ? `${r.days.length} day${r.days.length > 1 ? 's' : ''}, ${signed(total)} in total` : '';
      setHtml($('daysRows'), rows || '<tr><td colspan="6" class="empty">Days you finish appear here when you start a new day.</td></tr>');
    } catch { daysKey = ''; }
  }

  function updateSession() {
    const ses = state && state.session;
    if (!ses) return;
    const eq = ses.stats.equity;
    lineChart($('rEquity'), eq.map((net, i) => ({i, net})), 'bet', "Today's running result, bet by bet");
    loadDays();
  }

  return {update, updateSession, current: () => shown};
})();
