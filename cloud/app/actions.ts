'use server';
import {cookies, headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {COOKIE, hashKey, newKey, trackerForCookie, trackerForKey} from '@/lib/auth.ts';
import {db} from '@/lib/db.ts';
import {clientIp, LIMITS, rateLimit} from '@/lib/ratelimit.ts';
import {APP_SOURCES, checkStreamWrite, deleteStream, getNextSeq, insertRounds, parseMultipliersText} from '@/lib/rounds.ts';

async function setSession(key: string) {
  (await cookies()).set(COOKIE, key, {
    httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 24 * 365,
  });
}

const ip = async () => clientIp(await headers());
const wait = (s: number) => `Too many attempts. Try again in ${Math.ceil(s / 60)} min.`;

export async function createTracker(_: unknown, form: FormData) {
  const rl = await rateLimit(`create:${await ip()}`, LIMITS.create.limit, LIMITS.create.windowSec);
  if (!rl.ok) return {error: wait(rl.retryAfter)};
  const name = String(form.get('name') ?? '').trim().slice(0, 80) || 'My tracker';
  const key = newKey();
  await db()`INSERT INTO trackers (name, key_hash) VALUES (${name}, ${hashKey(key)})`;
  await setSession(key);
  redirect('/dashboard?welcome=1');
}

export async function signIn(_: unknown, form: FormData) {
  const rl = await rateLimit(`signin:${await ip()}`, LIMITS.signIn.limit, LIMITS.signIn.windowSec);
  if (!rl.ok) return {error: wait(rl.retryAfter)};
  const key = String(form.get('key') ?? '').trim();
  if (!await trackerForKey(key)) return {error: 'That key was not found. Check it and try again.'};
  await setSession(key);
  redirect('/dashboard');
}

export async function signOut() {
  (await cookies()).delete(COOKIE);
  redirect('/');
}

// Replaces the key. The old one stops working at once, for any external client and every signed-in browser.
export async function rotateKey() {
  const tracker = await trackerForCookie();
  if (!tracker) redirect('/');
  const key = newKey();
  await db()`UPDATE trackers SET key_hash = ${hashKey(key)} WHERE id = ${tracker.id}`;
  await setSession(key);
  redirect('/dashboard?welcome=1&rotated=1');
}

// Deletes the tracker and every round in it. The form must contain the word DELETE.
export async function deleteTracker(_: unknown, form: FormData) {
  const tracker = await trackerForCookie();
  if (!tracker) redirect('/');
  if (String(form.get('confirm') ?? '').trim() !== 'DELETE') return {error: 'Type DELETE to confirm.'};
  await db()`DELETE FROM trackers WHERE id = ${tracker.id}`;
  (await cookies()).delete(COOKIE);
  redirect('/?deleted=1');
}

// Adds a single round manually from the web UI.
export async function addManualRound(_: unknown, form: FormData) {
  const tracker = await trackerForCookie();
  if (!tracker) redirect('/');

  const valRaw = String(form.get('value') ?? '').trim();
  const num = Number(valRaw.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(num) || num < 1 || num > 1_000_000) {
    return {error: 'Enter a valid multiplier of 1.00 or higher.'};
  }

  let stream = String(form.get('stream') ?? '').trim() || 'manual';
  stream = stream.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 64) || 'manual';
  const gap = form.get('gap') === 'on' || form.get('gap') === 'true';

  const blocked = await checkStreamWrite(tracker.id, stream, APP_SOURCES.manual);
  if (blocked) return {error: blocked};
  const nextSeq = await getNextSeq(tracker.id, stream);
  await insertRounds(tracker.id, stream, [{
    seq: nextSeq,
    value: Math.round(num * 100) / 100,
    gap,
    at: Date.now(),
  }], APP_SOURCES.manual);

  redirect(`/dashboard?stream=${encodeURIComponent(stream)}`);
}

// Imports rounds in bulk from pasted text or CSV.
export async function importRounds(_: unknown, form: FormData) {
  const tracker = await trackerForCookie();
  if (!tracker) redirect('/');

  const text = String(form.get('text') ?? '').trim();
  if (!text) return {error: 'Paste or enter multipliers to import.'};

  const order = form.get('order') === 'oldest-first' ? 'oldest-first' : 'newest-first';
  const entries = parseMultipliersText(text, order);

  if (!entries.length) {
    return {error: 'No valid round multipliers found. Multipliers must be numbers >= 1.00 (e.g. 1.50, 2.10x).'};
  }

  let stream = String(form.get('stream') ?? '').trim() || 'imported';
  stream = stream.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 64) || 'imported';

  const blocked = await checkStreamWrite(tracker.id, stream, APP_SOURCES.import);
  if (blocked) return {error: blocked};

  const append = form.get('append') === 'on' || form.get('append') === 'true';
  let startSeq = 0;
  if (append) {
    startSeq = await getNextSeq(tracker.id, stream);
  } else {
    // If not appending, replace existing stream
    await deleteStream(tracker.id, stream);
  }

  const now = Date.now();
  const stepMs = 30000; // simulate 30s per round backwards
  const rounds = entries.map((e, idx) => ({
    seq: startSeq + idx,
    value: e.value,
    gap: e.gap,
    at: now - (entries.length - idx) * stepMs,
  }));

  await insertRounds(tracker.id, stream, rounds, APP_SOURCES.import);
  redirect(`/dashboard?stream=${encodeURIComponent(stream)}`);
}

// Generates sample rounds for instant testing without needing external capture.
export async function generateSampleRounds(_: unknown, form: FormData): Promise<{error?: string} | void> {
  const tracker = await trackerForCookie();
  if (!tracker) redirect('/');

  const countRaw = Number(form.get('count') ?? 100);
  const count = Math.min(2000, Math.max(10, Number.isFinite(countRaw) ? countRaw : 100));
  const mode = String(form.get('mode') ?? 'fair');

  let stream = String(form.get('stream') ?? '').trim() || 'simulation';
  stream = stream.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 64) || 'simulation';

  const blocked = await checkStreamWrite(tracker.id, stream, APP_SOURCES.sample);
  if (blocked) return {error: blocked};

  try {
    await deleteStream(tracker.id, stream);

    const now = Date.now();
    const stepMs = 25000;
    const rounds: {seq: number; value: number; gap: boolean; at: number}[] = [];

    for (let i = 0; i < count; i++) {
      const r = Math.random();
      let val: number;
      if (mode === 'skewed-low') {
        val = r < 0.65 ? 1 + Math.random() * 0.49 : Math.max(1, Math.floor(0.97 / (1 - r) * 100) / 100);
      } else if (mode === 'skewed-high') {
        val = r < 0.4 ? 2 + Math.random() * 8 : Math.max(1, Math.floor(0.97 / (1 - r) * 100) / 100);
      } else {
        val = Math.max(1, Math.floor(0.97 / (1 - r) * 100) / 100);
      }

      const isGap = i > 0 && i % 80 === 0;

      rounds.push({
        seq: i,
        value: Math.round(val * 100) / 100,
        gap: isGap,
        at: now - (count - i) * stepMs,
      });
    }

    await insertRounds(tracker.id, stream, rounds, APP_SOURCES.sample);
  } catch (e) {
    return {error: 'Failed to generate rounds: ' + String(e)};
  }
  redirect(`/dashboard?stream=${encodeURIComponent(stream)}`);
}

// Clears all rounds from a specific stream.
export async function deleteStreamAction(_: unknown, form: FormData): Promise<{error?: string} | void> {
  const tracker = await trackerForCookie();
  if (!tracker) redirect('/');

  const stream = String(form.get('stream') ?? '').trim();
  if (!stream) return {error: 'No stream specified'};
  try {
    await deleteStream(tracker.id, stream);
  } catch (e) {
    return {error: 'Failed to clear stream: ' + String(e)};
  }
  redirect('/dashboard');
}
