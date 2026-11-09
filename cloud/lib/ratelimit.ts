import {db} from './db.ts';

// Fixed-window limiter in Postgres, so it holds across serverless instances.
// Returns whether this request is allowed and how long until the window resets.
export async function rateLimit(bucket: string, limit: number, windowSec: number): Promise<{ok: boolean; retryAfter: number}> {
  const sql = db();
  const nowSec = Math.floor(Date.now() / 1000);
  const start = new Date((nowSec - nowSec % windowSec) * 1000);
  const [row] = await sql<{count: number}[]>`
    INSERT INTO rate_limits (bucket, window_start, count) VALUES (${bucket}, ${start}, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
    RETURNING count`;
  // Now and then, drop windows that ended over a day ago.
  if (Math.random() < 0.01) await sql`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`;
  return {ok: row.count <= limit, retryAfter: windowSec - nowSec % windowSec};
}

// Client address for per-IP limits. Behind Vercel or another proxy the first X-Forwarded-For entry is the client.
export function clientIp(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0].trim() || headers.get('x-real-ip') || 'unknown';
}

export const LIMITS = {
  ingest: {limit: Number(process.env.RATE_INGEST_PER_MIN ?? 120), windowSec: 60},
  signIn: {limit: Number(process.env.RATE_SIGNIN_PER_10MIN ?? 20), windowSec: 600},
  create: {limit: Number(process.env.RATE_CREATE_PER_HOUR ?? 10), windowSec: 3600},
  stream: {limit: Number(process.env.RATE_STREAM_PER_MIN ?? 30), windowSec: 60},
};
