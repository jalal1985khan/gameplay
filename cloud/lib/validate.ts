// Checks an upload from the extension. Rejects the whole batch on any bad entry, so a broken
// client never stores half a batch.
export const MAX_BATCH = 500;

export type IncomingRound = {seq: number; value: number; gap: boolean; at: number};
export type Batch = {stream: string; site: string | null; rounds: IncomingRound[]};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseBatch(body: unknown, now = Date.now()): {ok: true; batch: Batch} | {ok: false; error: string} {
  if (!isObj(body)) return {ok: false, error: 'body must be a JSON object'};
  const {stream, site, rounds} = body;
  if (typeof stream !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(stream)) return {ok: false, error: 'stream must be 8-64 letters, digits or dashes'};
  let origin: string | null = null;
  if (site != null) {
    try { const u = new URL(String(site)); if (!['http:', 'https:'].includes(u.protocol)) throw 0; origin = u.origin; }
    catch { return {ok: false, error: 'site must be an http(s) URL'}; }
  }
  if (!Array.isArray(rounds) || !rounds.length) return {ok: false, error: 'rounds must be a non-empty array'};
  if (rounds.length > MAX_BATCH) return {ok: false, error: `at most ${MAX_BATCH} rounds per request`};
  const out: IncomingRound[] = [];
  for (const [i, r] of rounds.entries()) {
    if (!isObj(r)) return {ok: false, error: `rounds[${i}] must be an object`};
    const {seq, value, gap, at} = r;
    if (!Number.isInteger(seq) || (seq as number) < 0 || (seq as number) > 2_000_000_000) return {ok: false, error: `rounds[${i}].seq must be a non-negative integer`};
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 1e9) return {ok: false, error: `rounds[${i}].value must be a number of at least 1`};
    if (gap !== undefined && typeof gap !== 'boolean') return {ok: false, error: `rounds[${i}].gap must be true or false`};
    // Capture times from the future (beyond clock skew) or before 2020 are refused.
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 1577836800000 || at > now + 600000) return {ok: false, error: `rounds[${i}].at must be a recent epoch-ms time`};
    out.push({seq: seq as number, value: Math.round(value * 100) / 100, gap: gap === true, at});
  }
  return {ok: true, batch: {stream, site: origin, rounds: out}};
}
