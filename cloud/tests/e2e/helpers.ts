import {createHash, randomBytes} from 'node:crypto';
import postgres from 'postgres';

export const BASE = process.env.BASE_URL!;
export const sql = postgres(process.env.DATABASE_URL!, {max: 2, onnotice: () => {}});

export async function makeTracker(name = 'e2e') {
  const key = `avk_${randomBytes(32).toString('base64url')}`;
  const [row] = await sql<{id: string}[]>`INSERT INTO trackers (name, key_hash) VALUES (${name}, ${createHash('sha256').update(key).digest('hex')}) RETURNING id`;
  return {id: row.id, key};
}

export const post = (key: string, body: unknown, ip = '10.0.0.1') => fetch(`${BASE}/api/rounds`, {
  method: 'POST', body: JSON.stringify(body),
  headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Forwarded-For': ip},
});

export const rounds = (from: number, n: number, value = 2) =>
  Array.from({length: n}, (_, i) => ({seq: from + i, value: value + i / 100, at: Date.now() - (n - i) * 1000}));

export async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise(r => setTimeout(r, 100));
  }
}
