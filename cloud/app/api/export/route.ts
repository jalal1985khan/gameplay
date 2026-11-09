import {trackerForCookie} from '@/lib/auth.ts';
import {gapIndexes, recentRounds} from '@/lib/rounds.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const tracker = await trackerForCookie();
  if (!tracker) return new Response('sign in first', {status: 401});
  const stream = new URL(req.url).searchParams.get('stream') ?? '';
  const rounds = await recentRounds(tracker.id, stream);
  const gaps = new Set(gapIndexes(rounds));
  const csv = 'sequence,multiplier,missed_rounds_before,captured_at\n' +
    rounds.map((r, i) => `${r.seq},${r.value},${gaps.has(i) ? 1 : 0},${new Date(r.at).toISOString()}`).join('\n');
  return new Response(csv, {headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="aviator-cloud-history.csv"',
  }});
}
