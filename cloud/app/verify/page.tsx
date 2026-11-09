import {Verifier} from './verifier.tsx';

export const metadata = {title: 'Fair-play verifier'};

export default function VerifyPage() {
  return (
    <main>
      <header className="top"><h1>✈ Fair-play verifier</h1><nav><a href="/">Tracker</a></nav></header>
      <div className="panel sub">
        In the game, open a finished round&apos;s <b>Provably fair</b> details and copy the server seed, the client seeds and the combined hash.
        This page recomputes the SHA-512 hash in your browser. Nothing is sent to the server.
      </div>
      <Verifier />
    </main>
  );
}
