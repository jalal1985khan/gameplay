# Aviator History Analyzer & Live Cloud Tracker

Next.js web application that records, monitors, and analyzes Aviator game rounds. It shows live round feeds, real odds at cash-out targets, pattern and randomness checks, a live CUSUM drift monitor, a decision plan simulator, a plain-English betting strategy tester, a session bet log with loss-limit alerts, CSV import/export, and a provably-fair verifier.

**Completely independent of the Chrome extension:** rounds can be captured and ingested using multiple methods without installing any browser extensions:
1. **Universal Browser Bookmarklet** — 1-click live capture that runs in *any* browser (Chrome, Safari, Firefox, Edge, Brave, or mobile).
2. **Tampermonkey / Violentmonkey Userscript** (`/api/userscript`) — Automatic background capture on betting sites.
3. **CSV & History Import** — Direct copy-paste of past multipliers or CSV file upload.
4. **Manual Round Entry** — Quick one-by-one round input directly on the dashboard.
5. **Sample Simulator** — 1-click generation of 50–1,000 realistic rounds with the true 97% RTP distribution for instant testing.
6. **HTTP REST API** — Simple `POST /api/rounds` with Bearer auth for custom scrapers, bots, or Python scripts.
7. **Optional Chrome Extension** — Backwards-compatible integration for users running the companion extension.

It does not predict rounds. Each round's result is fixed by a SHA-512 hash of seeds before it starts, so history carries no information about the next round. The checks here test exactly that on your own data.

## How it fits together

```
Ingestion Sources:
  ├─ Universal Bookmarklet (runs in any browser via JS snippet)
  ├─ Userscript (Tampermonkey / Violentmonkey)
  ├─ CSV / Text Import & Manual Round Entry
  ├─ Built-in Simulation Generator
  └─ Optional Chrome Extension
        │
        └─ POST /api/rounds (or Server Actions) Bearer <tracker key>
              │
              └─ Postgres: rounds UNIQUE(tracker, stream, seq) → idempotent deduplication
                    │
                    └─ GET /api/stream (Server-Sent Events)
                          │
                          └─ /dashboard (Live odds, Drift CUSUM, Strategy Tester, Bet Log)
```

- **Tracker**: one workspace with a secret key (`avk_…`). Only its SHA-256 hash is stored. The key signs into the dashboard (httpOnly cookie) and authorises uploads.
- **Stream**: an ingest stream (e.g. `web-...`, `manual`, `import-1`, or extension uuid). Sequence numbers increment chronologically; gaps or breaks are preserved.
- **Strategy Tester**: understands plain English rules ("Bet 100 at 2x after 3 rounds under 2x, double after a loss, stop loss 1000"), runs 2,000 Monte Carlo sessions, and backtests against your actual recorded history.
- **Bet Log**: tracks real session stakes, net profit/loss, and alerts if you hit your loss limit or start chasing losses.
- **Drift monitor** (`lib/drift.ts`): two-sided Bernoulli CUSUM on "reached the target" against the game's odds (0.97 / target).
- **Verifier** (`/verify`): recomputes the SHA-512 hash of the seeds in the browser and compares it to the game's provably-fair data.

## Run locally

Needs Node 22.18+ and Postgres.

```bash
cp .env.example .env.local        # set DATABASE_URL
npm install
DATABASE_URL=postgres://localhost:5432/aviator_cloud npm run db:migrate
npm run dev                       # http://localhost:3000
npm test                          # library tests
npm run build && npm run test:e2e # real server + Postgres + e2e suite
```

Create a tracker on the home page. You can immediately:
- Click **🎲 Simulate Sample Data** to populate 100 fair rounds and explore all features immediately.
- Drag the **⚡ Universal Bookmarklet** to your bookmarks bar to stream live rounds from any browser.
- Paste past multipliers in **📋 Paste / CSV Import**.

## Deploy (Vercel, Railway, Supabase, or Docker)

1. Create a Postgres database and run `npm run db:migrate` against its connection string.
2. Deploy the `cloud` folder as a standard Next.js application.
3. Add `DATABASE_URL` as an environment variable.
4. The build script (`scripts/sync-shared.mjs`) automatically checks for parent modules and preserves bundled modules when deployed standalone.

## Security

- Rate limits are kept in Postgres (`rate_limits`), so they hold across serverless instances.
- Tracker keys are stored only as SHA-256 hashes.
- Ingest endpoint enforces CORS, body size limits, input schema validation, and per-tracker rate limits.
