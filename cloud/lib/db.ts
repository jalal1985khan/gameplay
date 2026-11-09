import postgres from 'postgres';

// One pool per server instance. Serverless hosts reuse it across warm invocations.
const g = globalThis as unknown as {__sql?: postgres.Sql};

export function db(): postgres.Sql {
  if (!g.__sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    g.__sql = postgres(url, {max: 5, idle_timeout: 20, onnotice: () => {}});
  }
  return g.__sql;
}
