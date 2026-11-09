import {cookies} from 'next/headers';
import {COOKIE, trackerForCookie} from '@/lib/auth.ts';
import {generateUserscript} from '@/lib/client-streamer.ts';

export const dynamic = 'force-dynamic';

// Serves a userscript with the signed-in tracker's key built in. Auth is the session cookie only:
// a key in the URL would end up in browser history and server logs.
export async function GET(req: Request) {
  if (!await trackerForCookie()) return new Response('Sign in to the tracker first, then install the userscript from the dashboard.', {status: 401});
  const key = (await cookies()).get(COOKIE)!.value;
  return new Response(generateUserscript(new URL(req.url).origin, key), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Disposition': 'inline; filename="aviator-streamer.user.js"',
      'Cache-Control': 'no-store, private',
    },
  });
}
