'use client';
import {useEffect, useMemo, useRef, useState} from 'react';
import AviatorStats from '@/lib/stats.ts';
import AviatorStrategy, {type ParsedStrategy, type StrategySummary} from '@/lib/strategy.ts';
import {drift} from '@/lib/drift.ts';
import type {Round, Stream} from '@/lib/rounds.ts';
import {generateBookmarkletCode} from '@/lib/client-streamer.ts';
import {APP_SOURCES} from '@/lib/app-sources.ts';
import {GenerateSampleForm, ImportHistoryForm, ManualEntryForm} from '../forms.tsx';

const TARGETS = [1.5, 2, 3, 5, 10];
const LIMIT = 5000;
const fmt = (n: number) => `${n.toLocaleString(undefined, {maximumFractionDigits: 2})}×`;
const pct = (p: number) => `${(p * 100).toFixed(1)}%`;
const money = (n: number) => `₹${Math.round(n).toLocaleString()}`;
const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

function gapsOf(rounds: Round[]) {
  const out: number[] = [];
  for (let i = 1; i < rounds.length; i++) if (rounds[i].gap || rounds[i].seq !== rounds[i - 1].seq + 1) out.push(i);
  return out;
}

function Tag({r}: {r: {verdict: string; z: number}}) {
  if (r.verdict === 'too-few') return <span className="tag">need {AviatorStats.MIN_CASES}+ cases</span>;
  if (r.verdict === 'notable') return <span className="tag notable">notable · z {r.z.toFixed(1)}</span>;
  return <span className="tag">within noise · z {r.z.toFixed(1)}</span>;
}

type Live = 'connecting' | 'live' | 'down';

export function Dashboard({streams, stream, initial, apiKey, welcome}: {
  streams: Stream[]; stream: string | null; initial: Round[]; apiKey: string; welcome: boolean;
}) {
  const [rounds, setRounds] = useState<Round[]>(initial);
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set());
  const [live, setLive] = useState<Live>('connecting');
  const [target, setTarget] = useState(2);
  const [now, setNow] = useState(() => Date.now());
  const [showConnect, setShowConnect] = useState(welcome || !stream);
  const [origin, setOrigin] = useState('');
  const [planBudget, setPlanBudget] = useState(2000);

  useEffect(() => {
    setOrigin(window.location.origin);
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  // Live feed via Server-Sent Events
  useEffect(() => {
    if (!stream) return;
    const after = initial.reduce((m, r) => Math.max(m, r.id), 0);
    const es = new EventSource(`/api/stream?stream=${encodeURIComponent(stream)}&after=${after}`);
    es.onopen = () => setLive('live');
    es.onerror = () => setLive(es.readyState === EventSource.CLOSED ? 'down' : 'connecting');
    es.addEventListener('rounds', e => {
      const incoming: Round[] = JSON.parse((e as MessageEvent).data);
      setLive('live');
      setFreshIds(new Set(incoming.map(r => r.id)));
      setRounds(prev => {
        const bySeq = new Map(prev.map(r => [r.seq, r]));
        for (const r of incoming) bySeq.set(r.seq, r);
        return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-LIMIT);
      });
    });
    return () => es.close();
  }, [stream, initial]);

  const values = useMemo(() => rounds.map(r => r.value), [rounds]);
  const gaps = useMemo(() => gapsOf(rounds), [rounds]);
  const s = useMemo(() => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b), m = Math.floor(sorted.length / 2);
    return {
      median: sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2,
      quality: AviatorStats.quality(values, gaps),
      base: AviatorStats.baseRate(values, target),
      match: AviatorStats.oddsMatch(values, target),
      trends: AviatorStats.trendChecks(values, target, gaps),
      runs: AviatorStats.runsTest(values, target, gaps),
      corr: AviatorStats.serialCorrelation(values, gaps),
      drift: drift(values, gaps, target),
    };
  }, [values, gaps, target]);

  // The forms write only into their own kind of stream, never into a live capture stream.
  const site = streams.find(x => x.stream === stream)?.site ?? null;
  const targets = {
    manual: site === APP_SOURCES.manual && stream ? stream : 'manual',
    import: site === APP_SOURCES.import && stream ? stream : 'imported-history',
    sample: site === APP_SOURCES.sample && stream ? stream : 'sample-simulation',
    existing: streams.map(x => x.stream),
  };

  const last = rounds.at(-1);
  const stale = last && now - last.at > 120000;

  return <>
    <IngestionPanel
      origin={origin}
      apiKey={apiKey}
      targets={targets}
      show={showConnect}
      onToggle={() => setShowConnect(v => !v)}
    />

    {!stream || !rounds.length ? (
      <EmptyStatePanel targets={targets} />
    ) : <>
      <div className="row" style={{marginTop: 20, alignItems: 'center'}}>
        <div className="sub">
          <span className={`dot ${live === 'live' && !stale ? 'live' : live === 'down' ? 'down' : ''}`} />
          {live === 'live' ? (stale ? `Connected · no new round for ${ago(now - last!.at)}` : 'Live · updates as rounds finish')
            : live === 'down' ? 'Disconnected. Reload the page.' : 'Connecting…'}
        </div>
        <div style={{display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap'}}>
          {streams.length > 1 && (
            <form className="inline" style={{margin: 0}}>
              <label style={{margin: 0}}>Stream:
                <select name="stream" defaultValue={stream} onChange={e => e.currentTarget.form?.requestSubmit()} style={{display: 'inline-block', width: 'auto', margin: '0 0 0 6px', padding: '5px 8px'}}>
                  {streams.map(st => <option key={st.stream} value={st.stream}>{st.site ?? 'stream'} · {st.rounds} rounds · {st.stream.slice(0, 12)}</option>)}
                </select>
              </label>
            </form>
          )}
          <a className="button secondary" href={`/api/export?stream=${encodeURIComponent(stream)}`} style={{padding: '6px 12px', fontSize: 13}}>Export CSV</a>
        </div>
      </div>

      <div className="panel" style={{marginTop: 12, padding: '12px 16px'}}>
        <div className="row" style={{alignItems: 'center'}}>
          <strong style={{fontSize: 13, color: 'var(--muted)'}}>Quick Round Entry</strong>
          <ManualEntryForm stream={targets.manual} />
        </div>
      </div>
      {targets.manual !== stream && <p className="sub" style={{marginTop: 6}}>Quick entries go to the &quot;{targets.manual}&quot; stream, so they never disturb this live stream&apos;s round numbers.</p>}

      <div className="tiles" style={{marginTop: 12}}>
        <div className="tile"><span>Rounds loaded</span><strong>{rounds.length}</strong></div>
        <div className="tile"><span>Median</span><strong>{s ? fmt(s.median) : '—'}</strong></div>
        <div className="tile"><span>Latest</span><strong>{last ? fmt(last.value) : '—'}</strong></div>
        <div className="tile"><span>Last round</span><strong>{last ? ago(now - last.at) : '—'}</strong></div>
      </div>
      {s && <p className="sub">{s.quality.breaks ? `${s.quality.breaks} missed-rounds break${s.quality.breaks > 1 ? 's' : ''}` : 'No missed rounds'} · longest unbroken stretch {s.quality.longest} rounds</p>}

      <h2>Live rounds (newest first)</h2>
      <div className="panel chips">
        {rounds.slice(-60).reverse().flatMap((r, i, arr) => {
          const out = [<span key={r.id} className={`chip ${r.value < 1.5 ? 'low' : r.value >= 5 ? 'high' : ''} ${freshIds.has(r.id) ? 'fresh' : ''}`}>{fmt(r.value)}</span>];
          const prev = arr[i + 1];
          if (prev && (r.gap || r.seq !== prev.seq + 1)) out.push(<span key={`g${r.id}`} className="chip gap">missed rounds</span>);
          return out;
        })}
      </div>

      <h2>Odds at a cash-out target</h2>
      <div className="targets">{TARGETS.map(t => <button key={t} className={t === target ? 'on' : ''} onClick={() => setTarget(t)}>{t}×</button>)}</div>
      {s && <div className="grid">
        <div className="panel">
          <div className="sub">Share of rounds that reached {target}×</div>
          <div className="big">{pct(s.base.rate)}</div>
          <div className="sub">{s.base.hits} of {s.base.n} · 95% range {pct(s.base.ci[0])}–{pct(s.base.ci[1])} · game&apos;s built-in odds {pct(s.base.expected)}</div>
          <div className="sub" style={{marginTop: 8}}>Need {pct(s.base.breakEven)} to break even. In this data, ₹100 bets at {target}× returned <b className={s.base.returnPer100 < 100 ? 'bad' : 'good'}>₹{s.base.returnPer100.toFixed(0)}</b> on average.</div>
          {s.match.verdict === 'differs' && <div className="warn">This data is far from the game&apos;s odds (z {s.match.z.toFixed(1)}). Check capture first: missed or doubled rounds are far more likely than a beatable game.</div>}
          {s.match.verdict === 'matches' && <div className="sub" style={{marginTop: 8}}>Consistent with the game&apos;s odds (z {s.match.z.toFixed(1)}): past rounds give no edge.</div>}
        </div>
        <DriftPanel d={s.drift} target={target} />
      </div>}

      {s && <div className="grid" style={{marginTop: 16}}>
        <div className="panel">
          <h3 style={{marginTop: 0}}>Pattern checks: does history change the odds?</h3>
          {s.trends.map(t => <div className="check" key={t.label}>
            <div className="row"><span>{t.label}</span><Tag r={t} /></div>
            <div className="row sub"><span>Reached {target}×: {t.n ? pct(t.rate) : '—'} ({t.hits}/{t.n})</span><span>other rounds {pct(t.restRate)}</span></div>
          </div>)}
        </div>
        <div className="panel">
          <h3 style={{marginTop: 0}}>Randomness checks</h3>
          <div className="check"><div className="row"><span>Do rounds reaching {target}× come in streaks?</span><Tag r={s.runs} /></div>
            <div className="sub">{s.runs.verdict === 'too-few' ? `${s.runs.n} rounds so far` : `${s.runs.runs} streaks vs ${s.runs.expected.toFixed(1)} expected by chance`}</div></div>
          <div className="check"><div className="row"><span>Does a high round follow a high round?</span><Tag r={s.corr} /></div>
            <div className="sub">{s.corr.verdict === 'too-few' ? `${s.corr.n} pairs so far` : `correlation ${s.corr.r.toFixed(3)} over ${s.corr.n} pairs (0 = no link)`}</div></div>
          <p className="sub">A result counts as notable only beyond random noise (|z| ≥ {AviatorStats.NOTABLE_Z}, {AviatorStats.MIN_CASES}+ cases). With this many checks a fluke will eventually look notable, so confirm it on new rounds before trusting it. Checks never look across missed rounds.</p>
        </div>
      </div>}
    </>}

    <PlanPanel onBudgetChange={setPlanBudget} />
    <StrategyPanel values={values} gaps={gaps} />
    <BetLogPanel budget={planBudget} />
  </>;
}

function DriftPanel({d, target}: {d: ReturnType<typeof drift>; target: number}) {
  const recentAlarm = d.alarms.at(-1);
  return <div className="panel">
    <div className="row"><span className="sub">Live drift monitor at {target}×</span>
      <span className={`tag ${d.status === 'alarm' ? 'bad' : d.status === 'ok' ? 'ok' : ''}`}>{d.status === 'too-few' ? 'warming up' : d.status === 'alarm' ? 'drift detected' : 'on expected odds'}</span></div>
    <div className="big">{d.recentRate == null ? '—' : pct(d.recentRate)}</div>
    <div className="sub">hit rate over the last {d.recentN} rounds · expected {pct(d.expected)}</div>
    <Meter label="Evidence of a higher rate" v={d.upper} max={d.threshold} />
    <Meter label="Evidence of a lower rate" v={d.lower} max={d.threshold} />
    {d.status === 'alarm' && recentAlarm && <div className="warn">The hit rate moved {recentAlarm.direction === 'high' ? 'above' : 'below'} the game&apos;s odds. Check capture health first (missed, doubled or misread rounds). If capture is fine, confirm it holds on the next few hundred rounds: short runs like this happen by chance.</div>}
    <p className="sub">Watches every new round (CUSUM). It resets at missed rounds and alarms when the evidence fills the bar.</p>
  </div>;
}

function Meter({label, v, max}: {label: string; v: number; max: number}) {
  const w = Math.min(100, v / max * 100);
  return <div style={{marginTop: 8}}>
    <div className="row sub"><span>{label}</span><span>{Math.round(w)}%</span></div>
    <div style={{height: 6, borderRadius: 3, background: 'var(--chip)'}}><div style={{width: `${w}%`, height: '100%', borderRadius: 3, background: w > 80 ? 'var(--bad)' : 'var(--muted)'}} /></div>
  </div>;
}

type Targets = {manual: string; import: string; sample: string; existing: string[]};

function EmptyStatePanel({targets}: {targets: Targets}) {
  return (
    <div className="panel" style={{marginTop: 16}}>
      <h3 style={{marginTop: 0, fontSize: 16}}>No rounds recorded yet</h3>
      <p className="sub">
        Choose any of these methods to start analyzing immediately — <strong>no Chrome extension required</strong>:
      </p>
      <div className="grid" style={{marginTop: 12}}>
        <div className="tile">
          <strong>1-Click Simulation</strong>
          <span style={{marginBottom: 10}}>Generate 100 sample rounds with the true 97% RTP distribution to test all features instantly.</span>
          <GenerateSampleForm stream={targets.sample} existing={targets.existing} />
        </div>
        <div className="tile">
          <strong>Paste / CSV Import</strong>
          <span style={{marginBottom: 10}}>Paste past round multipliers (e.g. 1.84, 2.05, 1.02x) or upload a CSV file.</span>
          <ImportHistoryForm stream={targets.import} existing={targets.existing} />
        </div>
      </div>
    </div>
  );
}

function IngestionPanel({
  origin, apiKey, targets, show, onToggle,
}: {
  origin: string; apiKey: string; targets: Targets; show: boolean; onToggle: () => void;
}) {
  const [tab, setTab] = useState<'bookmarklet' | 'userscript' | 'import' | 'manual' | 'sample' | 'extension' | 'api'>('bookmarklet');
  const [copied, setCopied] = useState(false);

  const bookmarkletHref = useMemo(() => {
    if (!origin || !apiKey) return '#';
    return generateBookmarkletCode(origin, apiKey);
  }, [origin, apiKey]);

  // React refuses to render javascript: URLs, so the bookmarklet is set on the DOM node directly.
  // Without this the dragged bookmark would only throw "React has blocked a javascript: URL".
  const pill = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (pill.current && bookmarkletHref !== '#') pill.current.setAttribute('href', bookmarkletHref);
  }, [bookmarkletHref, tab]);

  const copyBookmarklet = () => {
    navigator.clipboard.writeText(bookmarkletHref);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <details className="panel" open={show}>
      <summary style={{cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'space-between'}} onClick={e => { e.preventDefault(); onToggle(); }}>
        <span>📥 Capture &amp; Ingest Data (Extension-Independent)</span>
        <span className="sub">{show ? '▲ Collapse' : '▼ Expand options'}</span>
      </summary>

      <div className="tabs" style={{marginTop: 14}}>
        <button type="button" className={`tab-btn ${tab === 'bookmarklet' ? 'active' : ''}`} onClick={() => setTab('bookmarklet')}>⚡ Universal Bookmarklet</button>
        <button type="button" className={`tab-btn ${tab === 'userscript' ? 'active' : ''}`} onClick={() => setTab('userscript')}>📜 Userscript (Tampermonkey)</button>
        <button type="button" className={`tab-btn ${tab === 'import' ? 'active' : ''}`} onClick={() => setTab('import')}>📋 Paste / CSV Import</button>
        <button type="button" className={`tab-btn ${tab === 'manual' ? 'active' : ''}`} onClick={() => setTab('manual')}>✍ Manual Entry</button>
        <button type="button" className={`tab-btn ${tab === 'sample' ? 'active' : ''}`} onClick={() => setTab('sample')}>🎲 Simulate Sample Data</button>
        <button type="button" className={`tab-btn ${tab === 'extension' ? 'active' : ''}`} onClick={() => setTab('extension')}>🧩 Chrome Extension</button>
        <button type="button" className={`tab-btn ${tab === 'api' ? 'active' : ''}`} onClick={() => setTab('api')}>🔌 HTTP API</button>
      </div>

      {tab === 'bookmarklet' && (
        <div>
          <p className="sub">
            The <strong>Universal Bookmarklet</strong> works on <strong>any browser</strong> (Chrome, Safari, Firefox, Edge, Brave, Android &amp; iOS mobile browsers) without installing any extension or developer mode!
          </p>
          <div style={{margin: '14px 0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap'}}>
            <a ref={pill} className="bookmarklet-pill" onClick={e => {
              // Clicking here would run the streamer on this dashboard and upload its own chips.
              e.preventDefault();
              if (window.innerWidth <= 768) {
                copyBookmarklet();
                alert('On mobile: bookmark any page, edit the bookmark URL, and paste the copied code!');
              } else alert('Drag this button to your bookmarks bar, then click the bookmark on your game page.');
            }}>
              ✈ Aviator Live Streamer
            </a>
            <button type="button" className="copy-pill" onClick={copyBookmarklet}>
              {copied ? '✓ Copied code' : 'Copy bookmarklet code'}
            </button>
          </div>
          <ol className="sub" style={{paddingLeft: 20, margin: '8px 0'}}>
            <li>Drag the button above to your browser&apos;s Bookmarks / Favorites bar (or copy the code).</li>
            <li>Open your Aviator game page.</li>
            <li>Click the bookmarklet from your bookmarks bar. A floating status badge will appear and automatically stream finished rounds here in real time!</li>
            <li><em>Note:</em> If your game runs inside a cross-origin iframe, either right-click the game frame and choose &quot;Open frame in new tab&quot; to click the bookmarklet there, or use the Userscript tab below.</li>
          </ol>
        </div>
      )}

      {tab === 'userscript' && (
        <div>
          <p className="sub">
            Run capture automatically in the background using Tampermonkey, Violentmonkey, or Greasemonkey. Works inside all game iframes automatically.
          </p>
          <div style={{margin: '12px 0'}}>
            <a
              href="/api/userscript/aviator-streamer.user.js"
              target="_blank"
              rel="noreferrer"
              className="button"
            >
              📥 Install Userscript (.user.js)
            </a>
          </div>
          <p className="sub">
            When installed, the script detects the Aviator result ribbon whenever the game runs and streams rounds directly to this tracker.
          </p>
        </div>
      )}

      {tab === 'import' && (
        <div style={{marginTop: 8}}>
          <ImportHistoryForm stream={targets.import} existing={targets.existing} />
        </div>
      )}

      {tab === 'manual' && (
        <div style={{marginTop: 8}}>
          <h3 style={{marginTop: 0}}>Manual Round Input</h3>
          <p className="sub">Enter multipliers one-by-one as they finish on your screen.</p>
          <ManualEntryForm stream={targets.manual} />
        </div>
      )}

      {tab === 'sample' && (
        <div style={{marginTop: 8}}>
          <GenerateSampleForm stream={targets.sample} existing={targets.existing} />
        </div>
      )}

      {tab === 'extension' && (
        <div>
          <p className="sub">
            If you already use the Aviator Live History Analyzer Chrome extension, you can link it here:
          </p>
          <ol className="sub" style={{paddingLeft: 20}}>
            <li>Open the extension popup in Chrome and expand <b>Cloud sync</b>.</li>
            <li>Paste the server address and tracker key below, then press <b>Save cloud settings</b>.</li>
            <li>Start capture on the game page. Rounds will sync here automatically.</li>
          </ol>
          <label>Server address<input readOnly value={origin} onFocus={e => e.currentTarget.select()} /></label>
          <label>Tracker key<input readOnly value={apiKey} onFocus={e => e.currentTarget.select()} /></label>
        </div>
      )}

      {tab === 'api' && (
        <div>
          <p className="sub">POST rounds directly from any scraper, Python script, or worker:</p>
          <pre className="mono" style={{background: 'var(--chip)', padding: '10px 12px', borderRadius: 8, overflowX: 'auto'}}>
{`curl -X POST "${origin}/api/rounds" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "stream": "custom-bot-1",
    "site": "https://game.example",
    "rounds": [
      {"seq": 0, "value": 2.15, "gap": false, "at": ${Date.now()}}
    ]
  }'`}
          </pre>
        </div>
      )}
    </details>
  );
}

function PlanPanel({onBudgetChange}: {onBudgetChange?: (b: number) => void}) {
  const [plan, setPlan] = useState({bet: 100, target: 2, rounds: 50, budget: 2000});
  const [result, setResult] = useState<ReturnType<typeof AviatorStats.simulatePlan> | null>(null);
  const valid = plan.bet > 0 && plan.target > 1 && plan.rounds > 0 && plan.rounds <= 2000 && plan.budget >= plan.bet;

  const update = (k: keyof typeof plan, v: number) => {
    const next = {...plan, [k]: v};
    setPlan(next);
    if (k === 'budget' && onBudgetChange) onBudgetChange(v);
  };

  const field = (k: keyof typeof plan, label: string, step = 1) =>
    <label>{label}<input type="number" step={step} value={plan[k]} onChange={e => update(k, Number(e.target.value))} /></label>;

  return <>
    <h2>Decision check: your plan</h2>
    <div className="panel">
      <div className="tiles">{field('bet', 'Bet per round (₹)')}{field('target', 'Cash out at (×)', 0.01)}{field('rounds', 'Rounds to play')}{field('budget', 'Session budget (₹)')}</div>
      <button disabled={!valid} onClick={() => setResult(AviatorStats.simulatePlan(plan))}>Check this plan</button>
      {!valid && <div className="sub">Enter a bet, a target above 1×, 1–2000 rounds and a budget of at least one bet.</div>}
      {result && <div className="lines" style={{marginTop: 12}}>
        <div><span>Total you would bet</span><b>{money(result.totalWagered)}</b></div>
        <div><span>Expected cost of this plan</span><b className="bad">−{money(result.expectedLoss)}</b></div>
        <div><span>Chance you finish ahead</span><b>{pct(result.profitChance)}</b></div>
        <div><span>Chance you lose the whole budget</span><b>{pct(result.bustChance)}</b></div>
        <div><span>Typical budget left at the end</span><b>{money(result.medianEnd)}</b></div>
        <div><span>Bad session (1 in 10) leaves you with</span><b>{money(result.worst10)}</b></div>
      </div>}
      <p className="sub">Simulates 5,000 sessions with the game&apos;s built-in odds (97% return).</p>
    </div>
  </>;
}

const PRESETS = [
  {label: 'Flat bet', text: 'Flat bet ₹100 at 2x for 100 rounds'},
  {label: 'Martingale', text: 'Martingale: bet ₹10 at 2x, budget 2000'},
  {label: 'Paroli', text: 'Reverse martingale: bet ₹20 at 2x'},
  {label: 'D\'Alembert', text: 'D\'Alembert at 2x, bet ₹20'},
  {label: 'After lows', text: 'Wait for 3 rounds under 2x, then bet ₹100 at 2x'},
  {label: 'Low cash-out', text: 'Bet ₹100 at 1.2x, stop when up 300, stop loss 1000'},
];

function StrategyPanel({values, gaps}: {values: number[]; gaps: number[]}) {
  const [text, setText] = useState('Bet ₹100 at 2x after 3 rounds under 2x, double after a loss, stop loss 1000');
  const [parsed, setParsed] = useState<ParsedStrategy | null>(null);
  const [sim, setSim] = useState<StrategySummary | null>(null);
  const [backtest, setBacktest] = useState<StrategySummary | null>(null);
  const [verdict, setVerdict] = useState<string[]>([]);

  const runTest = (inputStrategy = text) => {
    if (!inputStrategy.trim()) return;
    const p = AviatorStrategy.parse(inputStrategy);
    setParsed(p);
    if (p.errors.length) {
      setSim(null);
      setBacktest(null);
      setVerdict([]);
      return;
    }
    const s = AviatorStrategy.simulate(p.strategy);
    setSim(s);
    setVerdict(AviatorStrategy.verdict(s));
    if (values.length >= 50) {
      const bt = AviatorStrategy.backtest(p.strategy, values, gaps);
      setBacktest(bt);
    } else {
      setBacktest(null);
    }
  };

  const signed = (n: number) => `${n < 0 ? '−' : '+'}${money(Math.abs(n))}`;

  return <>
    <h2>Strategy tester</h2>
    <div className="panel">
      <label htmlFor="strategyText">Describe a betting strategy in plain words</label>
      <textarea
        id="strategyText"
        rows={3}
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="e.g. Bet ₹100 at 2x after 3 rounds under 2x, double after a loss, stop loss 1000"
      />
      <div className="presets" style={{marginTop: 8}}>
        {PRESETS.map(p => (
          <button
            key={p.label}
            type="button"
            className="secondary"
            style={{padding: '5px 10px', fontSize: 13}}
            onClick={() => { setText(p.text); runTest(p.text); }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <button type="button" onClick={() => runTest()} style={{marginTop: 4}}>Test this strategy</button>

      {parsed && (
        <div style={{marginTop: 16}}>
          <h3 style={{marginTop: 0}}>How the strategy was read</h3>
          <ul className="sub" style={{margin: '6px 0 10px 18px', padding: 0}}>
            {AviatorStrategy.describe(parsed.strategy).map((d, i) => <li key={i}>{d}</li>)}
          </ul>
          {parsed.ignored.length > 0 && (
            <div className="warn">Not understood, so ignored: {parsed.ignored.join(', ')}. Rephrase if relevant.</div>
          )}
          {parsed.errors.map((err, i) => (
            <div key={i} className="warn bad">{err}</div>
          ))}

          {sim && (
            <>
              <h3 style={{marginTop: 14}}>2,000 simulated sessions (game&apos;s real odds)</h3>
              <div className="lines">
                <div><span>Rounds bet that won</span><b>{pct(sim.hitRate)}</b></div>
                <div><span>Sessions that finished ahead</span><b>{pct(sim.aheadChance)}</b></div>
                <div><span>Average net per session</span><b>{signed(sim.avgNet)}</b></div>
                <div><span>Return per ₹100 bet</span><b>₹{sim.returnPer100.toFixed(1)}</b></div>
                <div><span>Ran out of money for next bet</span><b>{pct(sim.bustChance)}</b></div>
                {parsed.strategy.stopLoss > 0 && <div><span>Hit stop-loss</span><b>{pct(sim.stopLossChance)}</b></div>}
                {parsed.strategy.takeProfit > 0 && <div><span>Hit take-profit</span><b>{pct(sim.takeProfitChance)}</b></div>}
                <div><span>Typical session</span><b>{signed(sim.medianNet)}</b></div>
                <div><span>Bad session (1 in 10)</span><b>{signed(sim.worst10)}</b></div>
                <div><span>Biggest single bet</span><b>{money(sim.biggestBet)}</b></div>
              </div>

              {values.length >= 50 && backtest ? (
                <>
                  <h3 style={{marginTop: 14}}>On your {values.length} recorded rounds</h3>
                  {backtest.bets > 0 ? (
                    <div className="lines">
                      <div><span>Sessions played</span><b>{backtest.sessions}</b></div>
                      <div><span>Bets placed</span><b>{backtest.bets} (won {pct(backtest.hitRate)})</b></div>
                      <div><span>Total bet</span><b>{money(backtest.wagered)}</b></div>
                      <div><span>Net result</span><b>{signed(backtest.net)}</b></div>
                      <div><span>Sessions ahead / busted</span><b>{pct(backtest.aheadChance)} / {pct(backtest.bustChance)}</b></div>
                      <div><span>Longest losing streak</span><b>{backtest.longestLossRun} bets</b></div>
                    </div>
                  ) : (
                    <div className="sub">The strategy trigger never placed a bet on this history.</div>
                  )}
                </>
              ) : (
                <p className="sub" style={{marginTop: 10}}>Record or import at least 50 rounds to replay this strategy on your real history ({values.length} so far).</p>
              )}

              {verdict.map((v, i) => (
                <div key={i} className={`warn ${i ? 'bad' : ''}`} style={{marginTop: 8}}>{v}</div>
              ))}
            </>
          )}
        </div>
      )}
      <p className="sub" style={{marginTop: 12}}>Understands bets, cashout targets, budgets, rounds, stop-loss, take-profit, Martingale, Paroli, D&apos;Alembert, and streak triggers.</p>
    </div>
  </>;
}

type BetEntry = {bet: number; won: number};

function BetLogPanel({budget}: {budget: number}) {
  const [log, setLog] = useState<BetEntry[]>([]);
  const [betAmt, setBetAmt] = useState(100);
  const [cashout, setCashout] = useState('');

  // Load / persist in localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('aviator_bet_log');
      if (stored) setLog(JSON.parse(stored));
    } catch {}
  }, []);

  const saveLog = (newLog: BetEntry[]) => {
    setLog(newLog);
    try { localStorage.setItem('aviator_bet_log', JSON.stringify(newLog)); } catch {}
  };

  const addBet = () => {
    if (betAmt <= 0) return;
    const mult = cashout ? Number(cashout) : 0;
    const won = mult > 0 ? Math.round(betAmt * mult * 100) / 100 : 0;
    const next = [...log, {bet: betAmt, won}];
    saveLog(next);
  };

  const resetSession = () => {
    if (confirm('Start a new betting session? This resets your session log.')) {
      saveLog([]);
    }
  };

  const review = useMemo(() => AviatorStats.reviewLog(log, budget), [log, budget]);

  return <>
    <h2>Bet log: this session</h2>
    <div className="panel">
      <div className="tiles" style={{gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 12}}>
        <label>Bet amount (₹)
          <input type="number" min="1" value={betAmt} onChange={e => setBetAmt(Number(e.target.value))} />
        </label>
        <label>Cashed out at (×, blank = lost)
          <input type="number" min="1" step="0.01" placeholder="e.g. 2.10 (or blank)" value={cashout} onChange={e => setCashout(e.target.value)} />
        </label>
      </div>
      <div style={{display: 'flex', gap: 10, marginBottom: 14}}>
        <button type="button" onClick={addBet}>Log round</button>
        <button type="button" className="secondary" onClick={resetSession}>New session</button>
      </div>

      {review.warnings.map((w, i) => (
        <div key={i} className="warn bad">{w}</div>
      ))}

      <div className="tiles" style={{marginTop: 12}}>
        <div className="tile"><span>Rounds</span><strong>{review.rounds}</strong></div>
        <div className="tile"><span>Wagered</span><strong>{money(review.wagered)}</strong></div>
        <div className="tile"><span>Net P/L</span><strong className={review.net >= 0 ? 'good' : 'bad'}>{review.net >= 0 ? '+' : '−'}{money(Math.abs(review.net))}</strong></div>
        <div className="tile"><span>Chases</span><strong>{review.chases}</strong></div>
      </div>

      {log.length > 0 && (
        <div className="chips" style={{marginTop: 12}}>
          {log.slice(-30).reverse().map((e, i) => (
            <span key={i} className={`chip ${e.won > 0 ? 'win' : 'loss'}`}>
              ₹{e.bet} {e.won > 0 ? `→ ₹${Math.round(e.won)}` : 'lost'}
            </span>
          ))}
        </div>
      )}
    </div>
  </>;
}
