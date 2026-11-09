// Page script: finds the game's results list in this frame and reports it (newest first) to the
// background script whenever it changes; the background decides which rounds are new.
// Injected into every frame of the capture tab. Injecting again replaces the previous copy.
(() => {
  window.__aviatorObserver?.teardown();

  let observer = null;
  let scanTimer = 0;
  // Results list found by the last full-page search, reused while it still qualifies.
  let strip = null;
  // Last snapshot sent, and the list entries already reported (to count the new ones).
  let lastKey = null;
  const seen = new WeakSet();

  // A multiplier label such as "2.15x", "x1,204.50" or "1.00". It needs the x/× marker or exactly
  // two decimals, so page numbers and counters are not mistaken for rounds.
  const parse = text => {
    const t = String(text || '').trim();
    const match = t.match(/^(?:[x×]\s*)?(\d{1,3}(?:,\d{3})+|\d{1,7})(\.\d{1,4})?\s*([x×])?$/i);
    if (!match) return null;
    const marked = /^[x×]/i.test(t) || Boolean(match[3]);
    if (!marked && (match[2] || '').length !== 3) return null;
    const n = Number(match[1].replace(/,/g, '') + (match[2] || ''));
    return Number.isFinite(n) && n >= 1 && n <= 1000000 ? n : null;
  };
  const visible = el => {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  };

  // The results list is the container with the most direct children whose whole text is a
  // multiplier (e.g. "x4.19 x5.72 x1.48 ..."). The live in-flight multiplier is a single element.
  function stripCount(el) {
    if (el.children.length < 5) return 0;
    let count = 0;
    for (const child of el.children) if (parse(child.textContent) !== null) count++;
    return count >= 5 && count >= el.children.length * 0.6 ? count : 0;
  }
  function findStrip() {
    let best = null, bestCount = 0;
    for (const el of document.body.querySelectorAll('body *')) {
      const count = stripCount(el);
      if (count > bestCount && visible(el)) { best = el; bestCount = count; }
    }
    return best;
  }
  // Searching the whole page on every scan is costly while the plane flies, so keep the last list.
  function currentStrip() {
    if (strip && strip.isConnected && stripCount(strip) && visible(strip)) return strip;
    return strip = findStrip();
  }

  function scan() {
    scanTimer = 0;
    if (!document.body) return;
    const el = currentStrip();
    if (!el) return;
    const entries = [], values = [];
    for (const child of el.children) {
      const v = parse(child.textContent);
      if (v !== null) { entries.push(child); values.push(v); }
    }
    // Leading entries that are new elements, counted only when every later entry was seen before
    // (a list rebuilt from scratch has no old elements, so it gives no count).
    let fresh = 0;
    while (fresh < entries.length && !seen.has(entries[fresh])) fresh++;
    const newCount = lastKey !== null && fresh < entries.length && entries.slice(fresh).every(e => seen.has(e)) ? fresh : null;
    entries.forEach(e => seen.add(e));
    const key = values.join();
    if (key === lastKey && !newCount) return;
    lastKey = key;
    send({type: 'AVIATOR_SNAPSHOT', values, newCount});
  }
  // Mutations fire constantly while the plane flies; batch them into at most one scan per 500ms.
  const queueScan = () => { if (!scanTimer) scanTimer = setTimeout(scan, 500); };

  function send(message) {
    try { chrome.runtime.sendMessage(message).catch(() => {}); }
    catch { teardown(); } // The extension was reloaded; this copy can no longer report.
  }
  // A child frame (such as the game iframe) loaded a new document, which has no page script yet.
  const onFrameLoad = e => { if (['IFRAME', 'FRAME'].includes(e.target?.tagName)) send({type: 'AVIATOR_FRAME_LOADED'}); };
  const onMessage = message => { if (message?.type === 'AVIATOR_STOP') teardown(); };

  const api = {teardown};
  function teardown() {
    if (observer) observer.disconnect();
    clearTimeout(scanTimer);
    scanTimer = 0;
    document.removeEventListener('load', onFrameLoad, true);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
    if (window.__aviatorObserver === api) delete window.__aviatorObserver;
  }

  window.__aviatorObserver = api;
  chrome.runtime.onMessage.addListener(onMessage);
  document.addEventListener('load', onFrameLoad, true);
  observer = new MutationObserver(queueScan);
  observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true});
  scan();
})();
