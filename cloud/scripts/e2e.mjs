// End-to-end run against a real Postgres and the production build:
//   creates and migrates a test database, starts `next start`, runs tests/e2e, stops the server.
// TEST_DATABASE_URL defaults to postgres://localhost:5432/aviator_cloud_test (created if missing).
import {spawn} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import postgres from 'postgres';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/aviator_cloud_test';
const PORT = Number(process.env.E2E_PORT ?? 3211);
const name = new URL(url).pathname.slice(1);

const admin = postgres(Object.assign(new URL(url), {pathname: '/postgres'}).toString(), {max: 1, onnotice: () => {}});
const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
if (!exists) await admin.unsafe(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
await admin.end();

const sql = postgres(url, {max: 1, onnotice: () => {}});
await sql.unsafe(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
await sql`TRUNCATE trackers, rounds, rate_limits CASCADE`;
await sql.end();

if (!existsSync(new URL('../.next/BUILD_ID', import.meta.url))) {
  console.error('No production build. Run `npm run build` first.'); process.exit(1);
}
const env = {...process.env, DATABASE_URL: url, PORT: String(PORT), RATE_SIGNIN_PER_10MIN: '5', NODE_ENV: 'production'};
const server = spawn('npx', ['next', 'start', '-p', String(PORT)], {env, stdio: ['ignore', 'pipe', 'inherit'], detached: true});
let log = '';
server.stdout.on('data', d => { log += d; });
const base = `http://localhost:${PORT}`;
for (let i = 0; ; i++) {
  try { if ((await fetch(base)).status < 500) break; } catch {}
  if (i > 60) { console.error('server did not start\n' + log); process.kill(-server.pid); process.exit(1); }
  await new Promise(r => setTimeout(r, 500));
}

const tests = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/e2e/'.concat('*.test.ts')], {
  env: {...process.env, BASE_URL: base, DATABASE_URL: url}, stdio: 'inherit', shell: true,
});
const code = await new Promise(r => tests.on('exit', r));
process.kill(-server.pid);
process.exit(code ?? 1);
