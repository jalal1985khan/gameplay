'use client';
import {useState} from 'react';
import {checkRound, type FairCheck} from '@/lib/fair.ts';

export function Verifier() {
  const [res, setRes] = useState<FairCheck | null>(null);
  const [err, setErr] = useState('');
  async function run(form: FormData) {
    const serverSeed = String(form.get('server') ?? '');
    const clientSeeds = [1, 2, 3].map(i => String(form.get(`client${i}`) ?? ''));
    if (!serverSeed.trim()) { setErr('Enter the server seed.'); setRes(null); return; }
    setErr('');
    const shown = String(form.get('result') ?? '').trim();
    setRes(await checkRound({serverSeed, clientSeeds, shownHash: String(form.get('hash') ?? ''), shownResult: shown ? Number(shown) : null}));
  }
  return <div className="grid" style={{marginTop: 16}}>
    <form action={run} className="panel">
      <label>Server seed<input name="server" autoComplete="off" /></label>
      <label>Client seed 1<input name="client1" autoComplete="off" /></label>
      <label>Client seed 2<input name="client2" autoComplete="off" /></label>
      <label>Client seed 3<input name="client3" autoComplete="off" /></label>
      <label>Combined SHA-512 hash shown by the game<textarea name="hash" rows={3} /></label>
      <label>Round result shown by the game (×, optional)<input name="result" type="number" step="0.01" min="1" /></label>
      <button>Verify round</button>
      {err && <div className="warn">{err}</div>}
    </form>
    <div className="panel">
      {!res ? <p className="sub">Results appear here.</p> : <>
        <h3 style={{marginTop: 0}}>Hash check (exact)</h3>
        <p className={res.hashMatches === false ? 'bad' : res.hashMatches ? 'good' : 'sub'}>
          {res.hashMatches == null ? 'Paste the game’s hash to compare.' : res.hashMatches ? '✓ The hash matches: these seeds produced this round.' : '✗ The hash does not match. Check that every seed was copied exactly, in the order shown.'}
        </p>
        <div className="mono">{res.hash}</div>
        <h3>Result from the hash (unofficial formula)</h3>
        <p><b>{res.candidate.toFixed(2)}×</b>{res.resultMatches != null && <span className={res.resultMatches ? 'good' : 'sub'}> · {res.resultMatches ? 'matches the shown result' : 'differs from the shown result'}</span>}</p>
        <p className="sub">The game provider does not publish how the hash becomes a multiplier. This uses the most widely cited version (first 13 hex digits, 97% return). If it differs but the hash matches, the round is still the one committed to before it started.</p>
      </>}
    </div>
  </div>;
}
