import {redirect} from 'next/navigation';
import {trackerForCookie} from '@/lib/auth.ts';
import {Forms} from './forms.tsx';

export const dynamic = 'force-dynamic';

export default async function Home({searchParams}: {searchParams: Promise<{deleted?: string}>}) {
  if (await trackerForCookie()) redirect('/dashboard');
  const {deleted} = await searchParams;
  return (
    <main>
      <header className="top"><h1>✈ Aviator History Analyzer</h1><nav><a href="/verify">Fair-play verifier</a></nav></header>
      <div className="notice"><strong>No tool can predict the next round.</strong> Each round&apos;s result is fixed by a hash of seeds before it starts and does not depend on earlier rounds. Over time the game keeps about 3% of every bet whatever you do. This app tracks rounds, calculates honest odds, monitors statistical drift, tests strategies, and checks that your data matches the game&apos;s true probabilities.</div>
      {deleted === '1' && <div className="panel" style={{marginBottom: 16}}>The tracker and its rounds were deleted.</div>}
      <Forms />
      <h2>How it works</h2>
      <div className="panel sub">
        <p style={{margin: '0 0 8px 0'}}>
          <strong>Multiple ways to ingest &amp; analyze rounds — no Chrome extension required:</strong>
        </p>
        <ul style={{margin: '0 0 12px 18px', padding: 0, lineHeight: 1.6}}>
          <li><strong>Universal Browser Bookmarklet:</strong> 1-click live capture that runs in <em>any</em> browser (Chrome, Safari, Firefox, Edge, or mobile) without installing extensions.</li>
          <li><strong>Userscript (Tampermonkey):</strong> Automatic background capture on your betting site.</li>
          <li><strong>CSV &amp; History Import:</strong> Paste past multiplier lists or upload CSV files directly.</li>
          <li><strong>Manual Round Entry:</strong> Log rounds live on your phone or second screen as you play.</li>
          <li><strong>Built-in Simulation:</strong> Generate fair sample rounds to test strategies and drift metrics instantly.</li>
          <li><strong>Optional Chrome Extension:</strong> If you already use the extension, it syncs seamlessly via your tracker key.</li>
        </ul>
        This app never asks for or stores betting-site logins, passwords, OTPs, or wallet credentials.
      </div>
    </main>
  );
}
