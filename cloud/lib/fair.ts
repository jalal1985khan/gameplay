// Provably-fair round check. Before a round the game commits to a server seed; the first three
// players' client seeds are added; the round's result comes from the SHA-512 hash of all of them.
// The game's "Provably fair" window shows the seeds and the combined hash for each round.
//
// The hash check below is exact: if your recomputed hash differs from the one the game shows,
// the seeds you copied are not the ones that were used.
// The hash-to-multiplier step is NOT published by the game provider. crashFromHash uses the
// formula most often cited for this game (first 13 hex digits, 97% return). It is shown as
// "unofficial" in the app, and a mismatch there does not by itself mean the round was unfair.

export async function sha512Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-512', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function crashFromHash(hex: string, rtp = 0.97): number {
  const h = parseInt(hex.slice(0, 13), 16) / 2 ** 52; // Uniform in [0, 1).
  return Math.max(1, Math.floor(rtp * 100 / (1 - h)) / 100);
}

export type FairCheck = {
  combined: string;
  hash: string;
  hashMatches: boolean | null;
  candidate: number;
  resultMatches: boolean | null;
};

export async function checkRound({serverSeed, clientSeeds, shownHash = '', shownResult = null}: {
  serverSeed: string; clientSeeds: string[]; shownHash?: string; shownResult?: number | null;
}): Promise<FairCheck> {
  const combined = serverSeed.trim() + clientSeeds.map(s => s.trim()).filter(Boolean).join('');
  const hash = await sha512Hex(combined);
  const candidate = crashFromHash(hash);
  const cleanShown = shownHash.trim().toLowerCase();
  return {
    combined, hash, candidate,
    hashMatches: cleanShown ? cleanShown === hash : null,
    resultMatches: shownResult != null && Number.isFinite(shownResult) ? Math.abs(shownResult - candidate) < 0.005 : null,
  };
}
