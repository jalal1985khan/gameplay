# MonitorPlay / MoniterPlay: critical fixes and verification handoff

Project: `/Users/jalal/Downloads/aviator-history-analyzer/monitor`

## Scope and operating rule

Improve correctness, observability, and execution timing. Do not claim that a pattern in past multipliers predicts the next result or guarantees maximum winnings. The current game controls can place real-money bets. Use the fake-game tests and a demo account for further investigation; do not activate a real-money session as part of verification.

## Changes already implemented

- `server.js`: JSON-body shape/size validation and a request-level error boundary. Invalid input returns 400/413; an unavailable account database returns 503.
- `lib/auth.js`: invalid account records and a missing/corrupt configured database fail closed. A persistent `data/auth-required` marker retains this requirement across restarts. Password changes invalidate existing tokens. An explicitly empty valid account list retains the existing local-only setup behavior.
- `server.js`: logout closes authenticated live streams immediately; account/session validity is checked every second for SSE, previews, and VNC connections. Admin demotion closes VNC access.
- `server.js`: encrypted remembered game logins include the approved origin. Credentials are not filled into unrelated frames, and saved credentials cannot be used at another origin. Old saved credentials without an origin must be entered and saved again. Third-party identity-provider forms require manual login through the game window.
- `server.js`, `lib/execution.js`, `lib/capture.js`: autopilot is driven by control updates with a 250 ms fallback. Occupied or disabled slots defer engagement with a visible Waiting state. Concurrent engagement is prevented. Amount and Auto Cash Out are checked before starting. Already-active mismatched settings are refused. A successful setting update refreshes the server's panel immediately.
- `server.js`: stale capture stops autopilot and attempts to turn off Auto Play; direct new-bet actions are blocked while stale. Stop/cash-out remain available. Unverifiable Auto Play state is not reported as successful cutoff.
- `lib/store.js`: interrupted log tails are separated from later writes; history/day loads read the tail instead of the whole lifetime file. Appends report failures and flush round/day logs. Important persistence failures latch a visible betting lock until repair and restart.
- `server.js`: video frames are dropped for backpressured viewers; slow event streams are disconnected. Commands and autopilot transitions are journaled in `data/actions.ndjson` without request bodies or credentials.
- `lib/pilot.js`: replay uses supplied capture timestamps for the time limit and refuses to bridge missing-round gaps. UI/README explain that it is approximate and includes pause time; actual game acceptance and placement delays are not simulated.
- `README.md`, `public/index.html`: corrected automation descriptions, waiting/storage status, and probability-model labeling.

## Verification

Run `npm test` from `monitor/`. New regression files are `tests/hardening.test.js` and `tests/browser-hardening.test.js`. They cover invalid request bodies, account corruption/deletion/password replacement, interrupted logs, unavailable controls/mismatched active settings, stream logout, replay gaps/time limits, failed persistence, stale-capture shutdown, one start after readiness, and credential destination restrictions. Existing end-to-end tests cover cross-origin capture, real-balance tracking, cutoff, autopilot plans, login, roles, and VNC proxying.

The code was tested with fake games and temporary profiles, not the user's actual game account. Preserve the user's `data/`, `browser-profile/`, credentials, and history. Do not reset days, raise limits, enable loss recovery, or start autopilot just to make a test pass.

## Next critical investigation: actual provider timing

1. In a demo game, observe the actual waiting/countdown, in-flight, result, and next-round states. Current selectors describe bet-slot controls; they do not establish a universal global round ID or countdown deadline.
2. Record control-state transitions and timestamps around an attempted start. Distinguish requested, accepted/queued, actually debited, settled, canceled, rejected, and unknown states. Never count a queued Auto Play request as proof that a wager was accepted.
3. If the provider exposes an authoritative round ID and betting-open state, create a provider adapter. Re-check that state immediately before an action and skip an expired window. Preserve one engagement at a time and never retry a Bet toggle blindly.
4. Add fake-game tests for very short betting windows, delayed acknowledgements, disabled-to-ready transitions, frame navigation, split-leg partial starts, stop during engagement, reconnection, and active bets while settings change.
5. Reconcile wager acceptance and results against the actual balance/receipt, especially deposits, withdrawals, and external/manual bets. A DOM multiplier alone cannot prove a particular stake was accepted.
6. Verify stopping on stale capture against the real provider. A browser closing is not universal proof that server-side Auto Play stopped. If stop acknowledgement is missing, show that explicit uncertainty and require checking the game.

## Remaining design work (not represented as completed)

- Extract provider adapters, command execution, session accounting, auth transport, and persistence out of the large `server.js` incrementally. `lib/execution.js` is only the first separation.
- Make the probability model provider-specific. The current 97% RTP is labeled as an assumption; it has not been verified for arbitrary sites.
- Add audit-log retention/rotation and broader durability/reconciliation work. Atomic JSON replacement is not a transactional financial ledger.
- Add a dedicated supervisor/watchdog if operation must survive process failure. Software cannot guarantee a cutoff when the provider or browser is unreachable.
- Capture timestamps are not authoritative game-round times, so historical replay remains approximate.

## Applying the changes

Source updates do not replace a running Node process. Review the diff, turn off game Auto Play, stop the current monitor, then start it normally. Re-save a remembered game login if requested after the origin-protection upgrade. Confirm the page shows the expected readiness/stop states in a demo session before trusting provider timing.
