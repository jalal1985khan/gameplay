import {trackerForRequest} from '@/lib/auth.ts';
import {db} from '@/lib/db.ts';
import {parseBatch} from '@/lib/validate.ts';
import {clientIp, LIMITS, rateLimit} from '@/lib/ratelimit.ts';

// The extension posts from its service worker. It may also be called from the extension's
// origin, so the endpoint answers CORS preflights. Auth is the bearer key, never cookies.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
const json = (body: unknown, status = 200) => Response.json(body, {status, headers: CORS});
const MAX_BYTES = 256 * 1024;
const tooMany = (retryAfter: number) =>
  Response.json({error: 'too many requests, try again shortly'}, {status: 429, headers: {...CORS, 'Retry-After': String(retryAfter)}});

export function OPTIONS() {
  return new Response(null, {status: 204, headers: CORS});
}

export async function POST(req: Request) {
  const tracker = await trackerForRequest(req);
  if (!tracker) {
    // Wrong keys count against the sender's address, so keys can't be guessed quickly.
    const rl = await rateLimit(`badkey:${clientIp(req.headers)}`, LIMITS.signIn.limit, LIMITS.signIn.windowSec);
    if (!rl.ok) return tooMany(rl.retryAfter);
    return json({error: 'invalid or missing key'}, 401);
  }
  const rl = await rateLimit(`ingest:${tracker.id}`, LIMITS.ingest.limit, LIMITS.ingest.windowSec);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const text = await req.text();
  if (text.length > MAX_BYTES) return json({error: 'request too large'}, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json({error: 'body is not valid JSON'}, 400); }
  const parsed = parseBatch(body);
  if (!parsed.ok) return json({error: parsed.error}, 400);
  const {stream, site, rounds} = parsed.batch;
  const sql = db();
  const rows = rounds.map(r => ({
    tracker_id: tracker.id, stream, seq: r.seq, value: r.value, gap_before: r.gap, site, captured_at: new Date(r.at),
  }));
  // Retries resend rounds already stored; the unique key drops them.
  const stored = await sql`
    INSERT INTO rounds ${sql(rows, 'tracker_id', 'stream', 'seq', 'value', 'gap_before', 'site', 'captured_at')}
    ON CONFLICT (tracker_id, stream, seq) DO NOTHING RETURNING seq`;
  return json({ok: true, stored: stored.length, duplicates: rows.length - stored.length, upTo: Math.max(...rounds.map(r => r.seq))});
}
