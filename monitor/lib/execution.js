// Execution readiness only: game results are not used to predict the next round.
function engagementState(slots, legs) {
  for (const leg of legs) {
    const slot = slots[leg.slot];
    if (!slot) return {ok: false, error: `Bet ${leg.slot + 1} is not on screen in the game.`};
    if (slot.autoPlay === true) {
      if (slot.bet !== leg.stake || slot.target !== leg.target || slot.autoCashOut !== true) return {ok: false, error: `Bet ${leg.slot + 1} Auto Play settings do not match the requested bet and cash-out.`};
    } else if (slot.button !== 'bet' || slot.buttonDisabled || slot.autoPlayDisabled) {
      return {ok: true, deferred: true};
    }
  }
  return {ok: true};
}
module.exports = {engagementState};
