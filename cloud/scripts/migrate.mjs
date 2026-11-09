// Applies db/schema.sql to DATABASE_URL. Safe to run more than once.
import {readFileSync} from 'node:fs';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL first (see .env.example).'); process.exit(1); }
const sql = postgres(url, {max: 1, onnotice: () => {}});
await sql.unsafe(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
await sql.end();
console.log('schema applied');
