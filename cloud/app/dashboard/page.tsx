import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {COOKIE, trackerForCookie} from '@/lib/auth.ts';
import {listStreams, recentRounds} from '@/lib/rounds.ts';
import {rotateKey, signOut} from '../actions.ts';
import {DangerZone} from '../forms.tsx';
import {Dashboard} from './dashboard.tsx';

export const dynamic = 'force-dynamic';

export default async function DashboardPage({searchParams}: {searchParams: Promise<{stream?: string; welcome?: string; rotated?: string}>}) {
  const tracker = await trackerForCookie();
  if (!tracker) redirect('/');
  const params = await searchParams;
  const streams = await listStreams(tracker.id);
  const stream = streams.find(s => s.stream === params.stream)?.stream ?? streams[0]?.stream ?? null;
  const rounds = stream ? await recentRounds(tracker.id, stream) : [];
  const key = (await cookies()).get(COOKIE)!.value;
  return (
    <main>
      <header className="top">
        <h1>✈ {tracker.name}</h1>
        <nav><a href="/verify">Fair-play verifier</a><form action={signOut}><button className="secondary">Sign out</button></form></nav>
      </header>
      <div className="notice"><strong>Live monitoring shows what happened, not what happens next.</strong> Every round is independent, so no pattern in this history changes the next round&apos;s odds. The checks below test that claim on your own data.</div>
      {params.rotated === '1' && <div className="warn" style={{marginBottom: 16}}>Key replaced. Update any connected bookmarklet, userscript, API client, or extension with your new key.</div>}
      <Dashboard key={stream ?? 'none'} streams={streams} stream={stream} initial={rounds} apiKey={key} welcome={params.welcome === '1'} />
      <h2>Tracker settings</h2>
      <DangerZone rotate={rotateKey} stream={stream} />
    </main>
  );
}
