// Runs inside every frame of the game window (the game usually sits in an iframe from another
// site). Finds the game's results list and reports it, newest first, whenever it changes.
// The monitor server decides which rounds are new. Reads the page only; never clicks or types.
(() => {
  if (window.__aviatorCapture) return;
  window.__aviatorCapture = true;

  let scanTimer = 0, strip = null, lastKey = null, multiplierTimer = 0, liveNode = null;
  let liveMutations = [];
  const seen = new WeakSet();

  // A multiplier label such as "2.15x", "x1,204.50" or "1.00". It needs the x/× marker or exactly
  // two decimals, so page numbers and counters are not mistaken for rounds. Returns {n, marked}.
  const read = text => {
    const t = String(text || '').trim();
    const m = t.match(/^(?:[x×]\s*)?(\d{1,3}(?:,\d{3})+|\d{1,7})(\.\d{1,4})?\s*([x×])?$/i);
    if (!m) return null;
    const marked = /^[x×]/i.test(t) || Boolean(m[3]);
    if (!marked && (m[2] || '').length !== 3) return null;
    const n = Number(m[1].replace(/,/g, '') + (m[2] || ''));
    return Number.isFinite(n) && n >= 1 && n <= 1000000 ? {n, marked} : null;
  };
  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  // A results list is a container whose direct children are mostly multipliers. Lists whose
  // entries carry the "x" marker (Aviator shows "1.23x") always beat plain numbers, which on
  // betting sites are usually sports odds.
  function rate(el) {
    if (el.children.length < 5) return null;
    let count = 0, marked = 0;
    for (const child of el.children) {
      const r = read(child.textContent);
      if (r) { count++; if (r.marked) marked++; }
    }
    if (count < 5 || count < el.children.length * 0.6) return null;
    return {count, marked: marked >= count * 0.6};
  }
  const better = (a, b) => !b || (a.marked !== b.marked ? a.marked : a.count > b.count);
  function findStrip() {
    let best = null, bestRate = null;
    for (const el of document.body.querySelectorAll('body *')) {
      const r = rate(el);
      if (r && better(r, bestRate) && visible(el)) { best = el; bestRate = r; }
    }
    return best;
  }
  function currentStrip() {
    const r = strip && strip.isConnected && visible(strip) ? rate(strip) : null;
    // Keep an x-marked list; keep re-searching while only plain numbers have been found.
    if (r && r.marked) return strip;
    return strip = findStrip();
  }

  // Read a text-rendered live multiplier when the provider exposes it in the DOM. Canvas-only
  // games need provider-specific OCR and cannot be read reliably from page text.
  function liveCandidate(el) {
    if (!el || el.children.length || (strip && strip.contains(el)) || !visible(el)) return null;
    const text = el.textContent.trim();
    if (!text || text.length > 18) return null;
    const r = read(text);
    if (!r || !r.marked) return null;
    const style = getComputedStyle(el), size = parseFloat(style.fontSize) || 0;
    if (size < 20) return null;
    const box = el.getBoundingClientRect();
    const cx = (box.left + box.right) / 2 / Math.max(1, innerWidth);
    const cy = (box.top + box.bottom) / 2 / Math.max(1, innerHeight);
    if (cx < 0.2 || cx > 0.85 || cy < 0.15 || cy > 0.9) return null;
    return {el, value: r.n, score: size + (1 - Math.abs(cx - 0.55)) * 8 + (1 - Math.abs(cy - 0.55)) * 5};
  }
  function scanLiveMultiplier(mutations = []) {
    multiplierTimer = 0;
    if (!document.body || typeof window.__aviatorLive !== 'function') return;
    const candidates = new Set();
    const addText = node => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.parentElement) candidates.add(node.parentElement);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) if (text.parentElement) candidates.add(text.parentElement);
    };
    if (!mutations.length && !liveNode) {
      // One initial discovery scan. After this, inspect only nodes the game mutates.
      addText(document.body);
    } else {
      if (liveNode && !liveNode.isConnected) liveNode = null;
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') addText(mutation.target);
        else for (const node of mutation.addedNodes) addText(node);
        if (liveNode && (mutation.target === liveNode || liveNode.contains(mutation.target))) candidates.add(liveNode);
      }
    }
    if (!candidates.size) return;
    let best = null;
    for (const el of candidates) {
      const candidate = liveCandidate(el);
      if (candidate && (!best || candidate.score > best.score)) best = candidate;
    }
    const changedLiveNode = liveNode && candidates.has(liveNode);
    if (best) liveNode = best.el;
    else if (changedLiveNode || (liveNode && !liveNode.isConnected)) liveNode = null;
    if (best || changedLiveNode) window.__aviatorLive({value: best ? best.value : null}).catch(() => {});
  }
  const queueLiveMultiplier = () => {
    if (!multiplierTimer) multiplierTimer = setTimeout(() => {
      const pending = liveMutations;
      liveMutations = [];
      scanLiveMultiplier(pending);
    }, 50);
  };
  // For the monitor's diagnostics: every list in this frame that looks like results.
  window.__aviatorCandidates = () => {
    const out = [];
    for (const el of document.body ? document.body.querySelectorAll('body *') : []) {
      const r = rate(el);
      if (r) out.push({tag: el.tagName, cls: String(el.className || '').slice(0, 80), ...r, visible: visible(el),
        sample: [...el.children].slice(0, 8).map(c => c.textContent.trim().slice(0, 12))});
    }
    return {title: document.title, canvases: document.querySelectorAll('canvas').length, candidates: out.slice(0, 10)};
  };

  function scan() {
    scanTimer = 0;
    if (!document.body || typeof window.__aviatorReport !== 'function') return;
    const el = currentStrip();
    if (!el) return;
    const entries = [], values = [];
    let marked = 0;
    for (const child of el.children) {
      const r = read(child.textContent);
      if (r) { entries.push(child); values.push(r.n); if (r.marked) marked++; }
    }
    // Leading entries that are new elements, counted only when every later entry was seen before.
    let fresh = 0;
    while (fresh < entries.length && !seen.has(entries[fresh])) fresh++;
    const newCount = lastKey !== null && fresh < entries.length && entries.slice(fresh).every(e => seen.has(e)) ? fresh : null;
    entries.forEach(e => seen.add(e));
    const key = values.join();
    if (key === lastKey && !newCount) return;
    lastKey = key;
    window.__aviatorReport({values, newCount, marked: marked >= values.length * 0.6}).catch(() => {});
  }
  // The game's own bet panel, read only: balance, and per bet slot the amount, Auto Cash Out
  // (on/off and target) and Auto Play. Class names are those of Broplay's Aviator (pokgaming).
  const money = t => { const n = Number(String(t || '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) && /\d/.test(String(t)) ? n : null; };
  const isOn = el => !!el && /(^|[\s-])(active|on|checked|enabled|selected)([\s-]|$)/i.test(typeof el.className === 'string' ? el.className : '');
  let lastPanel = '', lastPanelAt = 0, panelTimer = 0;
  function readPanel() {
    if (!document.body || typeof window.__aviatorPanel !== 'function') return;
    const balanceEl = document.querySelector('.userBalanceMoney');
    const blocks = [...document.querySelectorAll('.betSectionBlock')];
    if (!balanceEl && !blocks.length) return;
    const slots = blocks.map(b => {
      const input = b.querySelector('.betSectionInput');
      const button = b.querySelector('.betButton');
      const tag = b.querySelector('.autoPlayTagInput');
      const sw = b.querySelector('.autoCashOut .switcher, .autoCashOut [class*=switch]');
      const play = b.querySelector('.autoPlayButton');
      const buttonCls = button && typeof button.className === 'string' ? button.className.replace('betButton', '').trim() : '';
      return {
        bet: input ? money(input.value) : null,
        // Auto Cash Out: its target box is greyed out (disabled) while the switch is off.
        autoCashOut: tag ? !tag.disabled || isOn(sw) : null,
        target: tag ? money(tag.value) : null,
        autoPlay: play ? isOn(play) || /stop/i.test(play.textContent) : null,
        // What the main button shows: bet, cancel (bet placed, waiting), or cash out (in flight).
        button: buttonCls || null,
        buttonText: button ? button.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) : null,
      };
    });
    const panel = {balance: balanceEl ? money(balanceEl.textContent) : null, slots};
    const key = JSON.stringify(panel);
    if (key === lastPanel && Date.now() - lastPanelAt < 900) return;
    lastPanel = key;
    lastPanelAt = Date.now();
    window.__aviatorPanel(panel).catch(() => {});
  }
  setInterval(readPanel, 1000);

  // Mutations fire constantly while the plane flies; at most one scan per 500 ms.
  const queueScan = () => { if (!scanTimer) scanTimer = setTimeout(scan, 500); };

  const start = () => {
    new MutationObserver(mutations => {
      queueScan();
      liveMutations.push(...mutations);
      queueLiveMultiplier();
      if (!panelTimer) panelTimer = setTimeout(() => { panelTimer = 0; readPanel(); }, 75);
    }).observe(document.documentElement, {subtree: true, childList: true, characterData: true});
    queueScan();
    queueLiveMultiplier();
  };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
})();
