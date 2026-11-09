import {db} from './db.ts';
import {APP_SOURCES, type AppSource} from './app-sources.ts';

export type Round = {id: number; seq: number; value: number; gap: boolean; at: number};
export type Stream = {stream: string; site: string | null; rounds: number; lastAt: number};

export const HISTORY_LIMIT = 5000;

type Row = {id: string; seq: number; value: string; gap_before: boolean; captured_at: Date};
const toRound = (r: Row): Round => ({id: Number(r.id), seq: r.seq, value: Number(r.value), gap: r.gap_before, at: r.captured_at.getTime()});

export async function listStreams(trackerId: string): Promise<Stream[]> {
  const rows = await db()<{stream: string; site: string | null; rounds: string; last_at: Date}[]>`
    SELECT stream, max(site) AS site, count(*) AS rounds, max(captured_at) AS last_at
    FROM rounds WHERE tracker_id = ${trackerId}
    GROUP BY stream ORDER BY last_at DESC`;
  return rows.map(r => ({stream: r.stream, site: r.site, rounds: Number(r.rounds), lastAt: r.last_at ? r.last_at.getTime() : 0}));
}

// Newest HISTORY_LIMIT rounds of a stream, oldest first.
export async function recentRounds(trackerId: string, stream: string): Promise<Round[]> {
  const rows = await db()<Row[]>`
    SELECT * FROM (
      SELECT id, seq, value, gap_before, captured_at FROM rounds
      WHERE tracker_id = ${trackerId} AND stream = ${stream}
      ORDER BY seq DESC LIMIT ${HISTORY_LIMIT}
    ) t ORDER BY seq`;
  return rows.map(toRound);
}

// Rounds stored after row id `after` (any stream order is by arrival).
export async function roundsAfter(trackerId: string, stream: string, after: number): Promise<Round[]> {
  const rows = await db()<Row[]>`
    SELECT id, seq, value, gap_before, captured_at FROM rounds
    WHERE tracker_id = ${trackerId} AND stream = ${stream} AND id > ${after}
    ORDER BY id LIMIT 500`;
  return rows.map(toRound);
}

// Next sequence number for appending to an existing stream.
export async function getNextSeq(trackerId: string, stream: string): Promise<number> {
  const rows = await db()<{max_seq: number | null}[]>`
    SELECT max(seq) AS max_seq FROM rounds WHERE tracker_id = ${trackerId} AND stream = ${stream}`;
  return rows[0]?.max_seq != null ? rows[0].max_seq + 1 : 0;
}

// Inserts rounds in batches with duplicate prevention.
export async function insertRounds(
  trackerId: string,
  stream: string,
  rounds: {seq: number; value: number; gap: boolean; at?: number}[],
  site: string | null = null
): Promise<{inserted: number}> {
  if (!rounds.length) return {inserted: 0};
  const sql = db();
  const rows = rounds.map(r => ({
    tracker_id: trackerId,
    stream,
    seq: r.seq,
    value: Math.round(r.value * 100) / 100,
    gap_before: r.gap,
    site,
    captured_at: new Date(r.at ?? Date.now()),
  }));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const stored = await sql`
      INSERT INTO rounds ${sql(chunk, 'tracker_id', 'stream', 'seq', 'value', 'gap_before', 'site', 'captured_at')}
      ON CONFLICT (tracker_id, stream, seq) DO NOTHING RETURNING seq`;
    inserted += stored.length;
  }
  return {inserted};
}

export {APP_SOURCES};

// The app may only write (append, replace) into a stream that is empty or holds rounds from the
// same app source. Live streams number their own rounds, so an extra round there would take a
// sequence number the capture client sends next, and the real round would be dropped as a duplicate.
// Returns an error message, or null when the write is allowed.
export async function checkStreamWrite(trackerId: string, stream: string, source: AppSource): Promise<string | null> {
  const rows = await db()<{site: string | null}[]>`
    SELECT DISTINCT site FROM rounds WHERE tracker_id = ${trackerId} AND stream = ${stream} LIMIT 5`;
  if (rows.every(r => r.site === source)) return null;
  return `"${stream}" holds rounds from live capture or another tool, so it can't be changed here. Pick a new stream name.`;
}

// Deletes a stream and all its rounds.
export async function deleteStream(trackerId: string, stream: string): Promise<void> {
  await db()`DELETE FROM rounds WHERE tracker_id = ${trackerId} AND stream = ${stream}`;
}

// Indexes where rounds were missed: marked by the client, or a jump in the sequence number.
export function gapIndexes(rounds: {seq: number; gap: boolean}[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < rounds.length; i++) if (rounds[i].gap || rounds[i].seq !== rounds[i - 1].seq + 1) out.push(i);
  return out;
}

// Parses raw multiplier string, CSV, or formatted numbers into an array of {value, gap}.
export function parseMultipliersText(text: string, order: 'newest-first' | 'oldest-first' = 'newest-first'): {value: number; gap: boolean}[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  // Check if first line looks like a CSV header (contains 'value', 'multiplier', 'seq', etc.)
  let startIndex = 0;
  let valueColIndex = -1;
  let gapColIndex = -1;
  const firstCols = lines[0].split(/[,\t;]/).map(c => c.trim().toLowerCase().replace(/['"]/g, ''));
  if (firstCols.some(c => ['value', 'multiplier', 'mult', 'odds', 'crash', 'payout'].includes(c))) {
    startIndex = 1;
    valueColIndex = firstCols.findIndex(c => ['value', 'multiplier', 'mult', 'odds', 'crash', 'payout'].includes(c));
    gapColIndex = firstCols.findIndex(c => ['gap', 'gap_before', 'break', 'missed'].includes(c));
  }

  const rawEntries: {value: number; gap: boolean}[] = [];
  let nextIsGap = false;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (valueColIndex >= 0) {
      // CSV row
      const cols = line.split(/[,\t;]/).map(c => c.trim().replace(/['"]/g, ''));
      const valStr = cols[valueColIndex];
      const num = parseSingleMultiplier(valStr);
      if (num !== null) {
        const isGap = gapColIndex >= 0 ? ['true', '1', 'yes'].includes((cols[gapColIndex] || '').toLowerCase()) : nextIsGap;
        rawEntries.push({value: num, gap: isGap});
        nextIsGap = false;
      }
    } else {
      // Freeform line or list of tokens
      // Check for gap/break line
      if (/^(?:gap|break|missed|---)$/i.test(line)) {
        nextIsGap = true;
        continue;
      }
      // Split line by commas, spaces, tabs or semicolons
      const tokens = line.split(/[,;\s]+/).map(t => t.trim()).filter(Boolean);
      for (const tok of tokens) {
        if (/^(?:gap|break|missed|---)$/i.test(tok)) {
          nextIsGap = true;
          continue;
        }
        const num = parseSingleMultiplier(tok);
        if (num !== null) {
          rawEntries.push({value: num, gap: nextIsGap});
          nextIsGap = false;
        }
      }
    }
  }

  // If user pasted newest-first (like the in-game result ribbon), reverse to store chronologically.
  if (order === 'newest-first') {
    return rawEntries.reverse();
  }
  return rawEntries;
}

function parseSingleMultiplier(text: string): number | null {
  if (!text) return null;
  const t = text.trim();
  // Support forms like 2.15x, x2.15, 2.15×, 2,15 (comma decimal), or plain 2.15
  const match = t.match(/^(?:[x×@]\s*)?(\d{1,3}(?:[,\s]\d{3})+|\d{1,7})(?:[.,](\d{1,4}))?\s*([x×])?$/i);
  if (!match) return null;
  const intPart = match[1].replace(/[,\s]/g, '');
  const fracPart = match[2] ? '.' + match[2] : '';
  const num = Number(intPart + fracPart);
  return Number.isFinite(num) && num >= 1 && num <= 1_000_000 ? Math.round(num * 100) / 100 : null;
}
