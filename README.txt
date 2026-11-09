AVIATOR LIVE HISTORY ANALYZER — CHROME EXTENSION (v1.5.0)

WHAT IT DOES
- Records completed Aviator rounds from the game's results list on a betting site you choose.
- Shows the real odds at a cash-out target, trend checks, randomness checks, a plan check, a strategy tester and a bet log with a loss limit.
- Exports the captured history as CSV.
- Does not predict rounds. Every round is independent; over time the game keeps about 3% of every bet whatever you do.
- Does not ask for or collect login credentials, OTPs, wallet data, or payment information.
- Makes no network requests unless you turn on Cloud sync (see below).

STRATEGY TESTER
- Describe a betting strategy in plain words, e.g. "Bet 100 at 2x after 3 rounds under 2x, double after a loss, stop loss 1000".
- It shows how it read your words (and any words it ignored), then plays the strategy on 2,000 simulated sessions with the game's real odds and, with 50+ captured rounds, on your captured history.
- Understands: bet, cash-out target, budget, rounds, stop-loss, take-profit, max bet, double/triple/raise by an amount or % after a loss or win, Martingale, Paroli (reverse Martingale), D'Alembert, and betting only after low or high rounds.
- The reading is done by local rules in strategy.js, not an online AI, so nothing leaves your browser.
- Every strategy comes out near a 3% loss per bet. Some (like Martingale) win most sessions but lose more in the sessions they lose.

HOW CAPTURE WORKS
- The page script runs in every frame of the game tab (including the game iframe), finds the results list and sends a snapshot of it whenever it changes.
- The background script compares each snapshot with the stored history and stores only new rounds, once and in order.
- If more rounds passed than the list shows (e.g. the tab was paused), the visible rounds are stored after a "missed rounds" marker. Checks never look across a marker.
- If the game page or game iframe reloads, capture re-attaches by itself. Stop works from any tab.

LIMITATIONS
- Games drawn only on a canvas, with no text results list, cannot be read.
- If the game rebuilds its whole list and a new round repeats the previous values exactly, that round can be missed.
- After a missed-rounds break, up to 2 rounds may be stored twice.

INSTALL
1. Extract the ZIP.
2. Open chrome://extensions in Chrome.
3. Enable Developer mode.
4. Click Load unpacked and select the folder containing manifest.json.
5. Open your game website in a tab. Open the extension, enter the website URL, and click Start live capture.
6. Allow site access when asked (needed to read the game iframe).

CLOUD SYNC (OPTIONAL)
- Sends captured rounds to your own Aviator Cloud Tracker (the Next.js app in cloud/) so you can watch them live from any device.
- Each upload holds only: multiplier, capture time, a sequence number, a missed-rounds flag, and the game site's address.
- Off until you enter a server address (https://, or http://localhost) and a tracker key in the popup's Cloud sync section.
- Rounds wait in a local outbox until the server confirms them, so a dropped connection loses nothing (up to 5000 rounds).
- Only rounds captured after you turn it on are sent. "Turn off" discards rounds still waiting.

PERMISSIONS
- storage: save rounds, settings, plan and bet log locally.
- tabs: check the active tab's address, and notice reloads and closed tabs so capture can resume or stop.
- scripting: attach the page script when you press Start, and when capture resumes.
- Site access (optional, asked at Start): read the game iframe on the game provider's domain.

TESTS
- node tests/run.js   (Node 18+, no dependencies)
