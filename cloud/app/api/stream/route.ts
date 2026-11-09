import {trackerForCookie} from '@/lib/auth.ts';
import {roundsAfter} from '@/lib/rounds.ts';
import {LIMITS, rateLimit} from '@/lib/ratelimit.ts';

// Server-Sent Events: pushes newly stored rounds to the dashboard. Each connection lives up
// to ~50 s (inside serverless time limits); the browser's EventSource reconnects by itself and
// sends Last-Event-ID, so nothing is missed between connections.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const POLL_MS = 1500, LIFETIME_MS = 50000;

export async function GET(req: Request) {
  const tracker = await trackerForCookie();
  if (!tracker) return new Response('sign in first', {status: 401});
  const rl = await rateLimit(`stream:${tracker.id}`, LIMITS.stream.limit, LIMITS.stream.windowSec);
  if (!rl.ok) return new Response('too many connections', {status: 429, headers: {'Retry-After': String(rl.retryAfter)}});
  const url = new URL(req.url);
  const stream = url.searchParams.get('stream') ?? '';
  let after = Number(req.headers.get('last-event-id') ?? url.searchParams.get('after') ?? 0);
  if (!stream || !Number.isSafeInteger(after) || after < 0) return new Response('bad request', {status: 400});

  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const end = Date.now() + LIFETIME_MS;
      const send = (s: string) => controller.enqueue(enc.encode(s));
      send('retry: 2000\n\n');
      try {
        while (!req.signal.aborted && Date.now() < end) {
          const rounds = await roundsAfter(tracker.id, stream, after);
          if (rounds.length) {
            after = rounds.at(-1)!.id;
            send(`id: ${after}\nevent: rounds\ndata: ${JSON.stringify(rounds)}\n\n`);
          } else {
            send(': keep-alive\n\n');
          }
          await new Promise(r => setTimeout(r, POLL_MS));
        }
      } catch {
        // Database hiccup or client gone: close; the browser reconnects.
      }
      controller.close();
    },
  });
  return new Response(body, {headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  }});
}
