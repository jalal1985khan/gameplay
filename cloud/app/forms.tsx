'use client';
import {useActionState, useState} from 'react';
import {
  addManualRound,
  createTracker,
  deleteStreamAction,
  deleteTracker,
  generateSampleRounds,
  importRounds,
  signIn,
} from './actions.ts';

export function Forms() {
  const [createState, create, creating] = useActionState(createTracker, null);
  const [signInState, login, signingIn] = useActionState(signIn, null);
  return (
    <div className="grid">
      <form action={create} className="panel">
        <h2 style={{marginTop: 0}}>New tracker</h2>
        <label>Name<input name="name" placeholder="My tracker" maxLength={80} /></label>
        <button disabled={creating}>{creating ? 'Creating…' : 'Create tracker'}</button>
        {createState?.error && <div className="warn">{createState.error}</div>}
        <p className="sub">You get a secret key. Use it to sign in here or to authorize live uploads from the bookmarklet, userscript, API, or extension.</p>
      </form>
      <form action={login} className="panel">
        <h2 style={{marginTop: 0}}>Sign in</h2>
        <label>Tracker key<input name="key" placeholder="avk_…" autoComplete="off" required /></label>
        <button disabled={signingIn}>{signingIn ? 'Checking…' : 'Sign in'}</button>
        {signInState?.error && <div className="warn">{signInState.error}</div>}
      </form>
    </div>
  );
}

export function DangerZone({rotate, stream}: {rotate: () => Promise<void>; stream?: string | null}) {
  const [state, remove, removing] = useActionState(deleteTracker, null);
  const [streamState, removeStream, removingStream] = useActionState(deleteStreamAction, null);
  return (
    <div className="grid">
      <form action={rotate} className="panel" onSubmit={e => { if (!confirm('Replace the key? Any connected streamer or extension stops uploading until you update it.')) e.preventDefault(); }}>
        <h3 style={{marginTop: 0}}>Replace key</h3>
        <p className="sub">Use this if your key leaked. The old key stops working at once.</p>
        <button className="secondary">Replace key</button>
      </form>
      {stream && (
        <form action={removeStream} className="panel" onSubmit={e => { if (!confirm(`Delete all rounds in "${stream}"?`)) e.preventDefault(); }}>
          <h3 style={{marginTop: 0}}>Clear current stream</h3>
          <p className="sub">Deletes all rounds stored in &quot;{stream}&quot;.</p>
          <input type="hidden" name="stream" value={stream} />
          <button className="secondary" disabled={removingStream}>{removingStream ? 'Clearing…' : `Clear "${stream}"`}</button>
          {streamState?.error && <div className="warn">{streamState.error}</div>}
        </form>
      )}
      <form action={remove} className="panel">
        <h3 style={{marginTop: 0}}>Delete tracker</h3>
        <p className="sub">Deletes this entire tracker and every stored stream and round. This cannot be undone.</p>
        <label>Type DELETE to confirm<input name="confirm" autoComplete="off" /></label>
        <button disabled={removing}>Delete tracker</button>
        {state?.error && <div className="warn">{state.error}</div>}
      </form>
    </div>
  );
}

export function ManualEntryForm({stream}: {stream: string | null}) {
  const [state, action, pending] = useActionState(addManualRound, null);
  const [val, setVal] = useState('');
  const [gap, setGap] = useState(false);

  return (
    <form action={action} className="inline" style={{alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
      <input type="hidden" name="stream" value={stream || 'manual'} />
      <div style={{minWidth: 120, flex: '1 1 120px'}}>
        <label style={{margin: 0}}>Multiplier
          <input
            name="value"
            placeholder="e.g. 2.15"
            step="0.01"
            min="1"
            required
            value={val}
            onChange={e => setVal(e.target.value)}
            style={{padding: '7px 10px'}}
          />
        </label>
      </div>
      <label style={{display: 'flex', alignItems: 'center', gap: 6, margin: 0, cursor: 'pointer', fontSize: 13}}>
        <input
          type="checkbox"
          name="gap"
          checked={gap}
          onChange={e => setGap(e.target.checked)}
          style={{width: 'auto', margin: 0}}
        />
        <span>Missed rounds break</span>
      </label>
      <button disabled={pending} style={{padding: '7px 14px', alignSelf: 'flex-end'}}>
        {pending ? 'Adding…' : '+ Add round'}
      </button>
      {state?.error && <div className="warn" style={{width: '100%', margin: '4px 0 0'}}>{state.error}</div>}
    </form>
  );
}

// Asks before a form replaces a stream that already has rounds.
const confirmReplace = (name: string, existing: string[]) => (e: React.FormEvent) => {
  if (existing.includes(name.trim()) && !confirm(`Replace all rounds in "${name.trim()}"?`)) e.preventDefault();
};

export function ImportHistoryForm({stream, existing = []}: {stream: string | null; existing?: string[]}) {
  const [state, action, pending] = useActionState(importRounds, null);
  const [streamName, setStreamName] = useState(stream || 'import-1');
  const [text, setText] = useState('');
  const [order, setOrder] = useState<'newest-first' | 'oldest-first'>('newest-first');
  const [append, setAppend] = useState(false);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const content = String(ev.target?.result ?? '');
      setText(content);
    };
    reader.readAsText(file);
  };

  return (
    <form action={action} className="panel" onSubmit={append ? undefined : confirmReplace(streamName, existing)}>
      <h3 style={{marginTop: 0}}>Import round history (CSV / paste)</h3>
      <p className="sub">
        Paste multipliers (e.g. <code className="mono">2.15, 1.05, 14.80, 1.00</code>) or upload a CSV file.
        Lines with <code className="mono">gap</code> or <code className="mono">break</code> mark missed rounds.
      </p>

      <div className="grid" style={{marginBottom: 10}}>
        <label>Stream name
          <input
            name="stream"
            value={streamName}
            onChange={e => setStreamName(e.target.value)}
            placeholder="imported-data"
            pattern="[A-Za-z0-9-]+"
            maxLength={64}
            required
          />
        </label>
        <label>Upload CSV file (optional)
          <input type="file" accept=".csv,.txt" onChange={handleFileUpload} style={{padding: '5px'}} />
        </label>
      </div>

      <label>Multipliers list / CSV content
        <textarea
          name="text"
          rows={5}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Paste multipliers here (e.g. 1.84, 2.05, 1.02x, 5.12, 1.00...)"
          required
        />
      </label>

      <div className="row" style={{marginTop: 10, alignItems: 'center'}}>
        <label style={{margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 13}}>
          Order:
          <select
            name="order"
            value={order}
            onChange={e => setOrder(e.target.value as 'newest-first' | 'oldest-first')}
            style={{display: 'inline-block', width: 'auto', margin: 0, padding: '4px 8px'}}
          >
            <option value="newest-first">Newest first (like game history bar)</option>
            <option value="oldest-first">Oldest first (chronological order)</option>
          </select>
        </label>

        <label style={{margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 13}}>
          <input
            type="checkbox"
            name="append"
            checked={append}
            onChange={e => setAppend(e.target.checked)}
            style={{width: 'auto', margin: 0}}
          />
          Append to existing stream
        </label>

        <button disabled={pending || !text.trim()}>
          {pending ? 'Importing…' : 'Import rounds'}
        </button>
      </div>

      {state?.error && <div className="warn">{state.error}</div>}
    </form>
  );
}

export function GenerateSampleForm({stream, existing = []}: {stream: string | null; existing?: string[]}) {
  const [state, action, pending] = useActionState(generateSampleRounds, null);
  const [streamName, setStreamName] = useState(stream || 'sample-simulation');
  const [count, setCount] = useState(100);
  const [mode, setMode] = useState('fair');

  return (
    <form action={action} className="panel" onSubmit={confirmReplace(streamName, existing)}>
      <h3 style={{marginTop: 0}}>Generate sample rounds (simulation)</h3>
      <p className="sub">
        Generate realistic Aviator rounds based on the game&apos;s true 97% RTP formula (<code className="mono">P(X ≥ x) = 0.97 / x</code>) to test the odds, drift monitor, and strategy backtester immediately without waiting for a live game.
      </p>

      <div className="tiles" style={{marginBottom: 12}}>
        <label>Stream name
          <input
            name="stream"
            value={streamName}
            onChange={e => setStreamName(e.target.value)}
            required
            maxLength={64}
          />
        </label>
        <label>Number of rounds
          <select name="count" value={count} onChange={e => setCount(Number(e.target.value))}>
            <option value={50}>50 rounds</option>
            <option value={100}>100 rounds</option>
            <option value={200}>200 rounds</option>
            <option value={500}>500 rounds</option>
            <option value={1000}>1000 rounds</option>
          </select>
        </label>
        <label>Distribution
          <select name="mode" value={mode} onChange={e => setMode(e.target.value)}>
            <option value="fair">Fair (Game&apos;s built-in 97% RTP)</option>
            <option value="skewed-low">Skewed Low (test CUSUM drift alarm)</option>
            <option value="skewed-high">Skewed High (lucky stretch)</option>
          </select>
        </label>
      </div>

      <button disabled={pending}>
        {pending ? 'Generating…' : `Generate ${count} rounds`}
      </button>
      {state?.error && <div className="warn">{state.error}</div>}
    </form>
  );
}
