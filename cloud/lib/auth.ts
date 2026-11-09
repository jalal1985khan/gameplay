import {createHash, randomBytes} from 'node:crypto';
import {cookies} from 'next/headers';
import {db} from './db.ts';

export const COOKIE = 'aviator_tracker';
export type Tracker = {id: string; name: string};

// Keys look like "avk_<43 base64url chars>" (256 bits). Only the SHA-256 hash is stored.
export const newKey = () => `avk_${randomBytes(32).toString('base64url')}`;
export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
export const looksLikeKey = (key: unknown): key is string => typeof key === 'string' && /^avk_[A-Za-z0-9_-]{43}$/.test(key);

export async function trackerForKey(key: unknown): Promise<Tracker | null> {
  if (!looksLikeKey(key)) return null;
  const [row] = await db()<Tracker[]>`SELECT id, name FROM trackers WHERE key_hash = ${hashKey(key)}`;
  return row ?? null;
}

// The extension sends "Authorization: Bearer <key>".
export function trackerForRequest(req: Request) {
  const m = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '');
  return trackerForKey(m?.[1]);
}

// The dashboard is signed in with an httpOnly cookie holding the key.
export async function trackerForCookie() {
  return trackerForKey((await cookies()).get(COOKIE)?.value);
}
