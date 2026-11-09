// Works out which rounds in a snapshot of the game's results list are new.
// history: stored rounds, oldest first. snapshot: the list as the page shows it, newest first.
// newCount: how many leading entries are new page elements, when the page script could tell.
const AviatorMatch = (() => {
  const MIN_OVERLAP = 3; // Fewer matching rounds than this could line up by chance.

  // True when the snapshot from index i onwards repeats the newest stored rounds exactly.
  function overlapsAt(snapshot, recent, i, min) {
    const len = Math.min(snapshot.length - i, recent.length);
    if (len < min) return false;
    for (let j = 0; j < len; j++) if (snapshot[i + j] !== recent[j]) return false;
    return true;
  }

  // Returns {fresh, gap}: fresh = new rounds oldest first; gap = rounds were missed before them.
  function newRounds(history, snapshot, newCount = null) {
    if (!snapshot.length) return {fresh: [], gap: false};
    if (!history.length) return {fresh: [...snapshot].reverse(), gap: false};
    const recent = history.slice(-snapshot.length).reverse();
    // New page elements are the strongest evidence (they catch a round that repeats the
    // previous values), but only when the rest of the list still matches what is stored.
    if (Number.isInteger(newCount) && newCount > 0 && newCount < snapshot.length && overlapsAt(snapshot, recent, newCount, 1)) {
      return {fresh: snapshot.slice(0, newCount).reverse(), gap: false};
    }
    const min = Math.min(MIN_OVERLAP, history.length);
    for (let i = 0; i < snapshot.length; i++) {
      if (overlapsAt(snapshot, recent, i, min)) return {fresh: snapshot.slice(0, i).reverse(), gap: false};
    }
    // Nothing lines up: more rounds passed than the list shows. Keep what is visible, marked.
    return {fresh: [...snapshot].reverse(), gap: true};
  }

  // Appends fresh rounds, records a break before them when needed, and keeps the newest max.
  function append(history, gaps, fresh, gap, max = 5000) {
    const next = [...gaps];
    if (gap && history.length && fresh.length) next.push(history.length);
    const all = [...history, ...fresh], drop = Math.max(0, all.length - max);
    return {captured: all.slice(drop), gaps: next.map(g => g - drop).filter(g => g > 0)};
  }

  return {newRounds, append, MIN_OVERLAP};
})();
if (typeof module !== 'undefined') module.exports = AviatorMatch;
