# Aviator Live Monitor

One screen: enter the game's address, click **Start live capture**, and watch every finished round appear live.

## Start it

Needs Node.js 18+ and Google Chrome (or Microsoft Edge).

```bash
cd monitor
npm install      # first time only
npm start        # opens http://localhost:4321
```

## Use it

1. Paste your game's address (for example `https://your-site.example/aviator`) and click **Start live capture**.
2. A separate Chrome window opens on that address. Log in there as usual and open the Aviator game.
3. Finished rounds appear on the monitor page as they happen: count, latest, median, share that reached 2×, and the newest 200 rounds.
4. **Stop capture** closes the game window. Rounds are kept (and saved in `data/`) until you click **Clear**. **Download CSV** exports them.

The right side of the monitor shows a live view of the game window, so you can watch the game there.
The game keeps running when you switch tabs or put other windows on top of it (the game page is
told it is always visible and focused). Don't minimise the game window: macOS stops drawing
minimised windows.

Only results shown with an "x" (like `1.23x`) are recorded. Plain numbers, such as sports odds
on the site's home page, are ignored.

Under the fixed cash-out buttons, **From your last N rounds** offers targets read from the
captured rounds (the multiplier that 80%, 70%, 50% and 30% of them reached), updating live.
They describe what already happened; the win chance shown is still the game's real odds.

The bet helper shows the real chance of reaching your cash-out target (0.97 ÷ target, the same
every round), a suggested bet of 1% of the money you are ready to lose, and a stop-loss.

**Bet check.** Choose your bet amount and target; the risk meter shows how risky that amount
is (share of your money, losses in a row to your stop-loss, chance of hitting the stop-loss
over 50 bets). Pick how you exit:
- **Auto cash-out:** turn on Auto Cash Out in the game at your target. The next round decides
  the bet: a win if the plane reaches the target.
- **Manual cash-out:** press Cash Out in the game yourself. After the round the monitor asks
  where you cashed out (it refuses a value above where the plane crashed), or press
  "Didn't cash out" for a loss.

- **Game Auto Bet:** let the game do everything. In its Auto tab, set your bet, turn on
  Auto Cash Out at your target, and turn on Auto Bet. Then press **Game Auto Bet is on – track
  every round**: the monitor records every finished round as a bet. When your stop-loss is
  reached it sounds an alarm, flashes a red banner and the tab title, and shows a desktop
  notification, until you turn off Auto Bet in the game and press **I turned off Auto Bet**.
  (Click anywhere on the monitor page once so the browser allows the sound; the alarm sound can
  be switched off in Settings.)

Place the bet yourself in the game window, then press the button before the plane takes off. After a loss the button hides for 3 rounds;
once you are down a quarter of your money it hides for the rest of the day. Both can be changed
with the gear icon (⚙ Settings, top right): pause 0–10 rounds, stop-loss 10%, 25%, 50% or all. The monitor never
places bets itself.

**My results** (right side, under the live view): today's bets, wins, losses, net result, win
rate, how much of the stop-loss is used, and a row per bet (time, bet, exit, where the plane
went, result). **Download** saves them as a CSV.

**Analysis of your captured rounds** (bottom of the page; choose the last 200, 1,000, 5,000 or all rounds):
- the latest 60 rounds as a chart, against your cash-out target;
- where rounds ended, next to the share the game's odds give (0.97 ÷ target);
- a table per cash-out target: how many rounds reached it, the likely range, and whether that matches the game's odds;
- ten checks for patterns (streaks, a high round after a high round, "after 3 low rounds", …), each
  judged against chance. A difference usually means missed rounds, and never predicts the next round;
- your bet and target replayed on exactly these rounds: result, biggest drop, most losses in a row.

The risk numbers in the bet helper are exact calculations, not simulated sessions.

**Past days.** Starting a new day stores the finished day (bets, win rate, total bet, biggest drop, net).
My results also charts today's running result and warns when you raise your bet after losses.

**If the game goes quiet.** When a live capture gets no update for 3 minutes (game frozen, logged
out, connection lost) the status turns yellow and says so. **Why no rounds?** shows what the
monitor finds in each frame of the game window. A break reminder (Settings: off, 30 min, 1 h, 2 h)
appears once the game has been open that long.

**Where rounds are kept.** Every round is added to `data/rounds/<site>.ndjson` the moment it is
captured (one line per round, never trimmed). Each game site has its own file, so switching sites
does not erase anything. The page works with the newest 50,000 rounds.

The game window uses its own browser profile (`browser-profile/`), so you stay logged in next time.
If the game window is closed, click Start live capture again.

## What it does and doesn't do

- Reads the game's results list from the page, including the game frame. It never clicks, types, places bets, or reads your password.
- Runs only on your computer: the page is served on 127.0.0.1 and refuses requests from other websites.
- Does not predict rounds. Every round is random and independent; over time the game keeps about 3% of every bet.
- Games drawn only on a canvas, with no text results list, can't be read.
- If rounds pass while the list can't be read (page reloading, game hidden), a "missed rounds" marker is shown instead of guessing.

## Tests

```bash
npm test   # runs a fake game in a cross-origin frame and captures it in headless Chrome
```
