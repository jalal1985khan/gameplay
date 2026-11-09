// Standalone universal browser capture code (Bookmarklet & Tampermonkey Userscript).
// Works directly in any browser (Chrome, Safari, Firefox, Edge, Mobile) without extensions.

export function generateBookmarkletCode(serverOrigin: string, apiKey: string): string {
  const scriptBody = `(function() {
  if (window.__aviatorStreamer) {
    window.__aviatorStreamer.toggle();
    return;
  }

  const SERVER = ${JSON.stringify(serverOrigin)};
  const KEY = ${JSON.stringify(apiKey)};
  const STREAM = 'web-' + Math.random().toString(36).slice(2, 10);

  let seq = 0;
  let sentCount = 0;
  let running = true;
  let scanTimer = 0;
  let strip = null;
  let lastKey = null;
  let outbox = [];
  let sending = false;
  const seen = new WeakSet();

  // Multiplier parser: matches forms like 2.15x, x2.15, 2.15
  function parse(text) {
    const t = String(text || '').trim();
    const match = t.match(/^(?:[x×]\\s*)?(\\d{1,3}(?:,\\d{3})+|\\d{1,7})(\\.\\d{1,4})?\\s*([x×])?$/i);
    if (!match) return null;
    const marked = /^[x×]/i.test(t) || Boolean(match[3]);
    if (!marked && (match[2] || '').length !== 3) return null;
    const n = Number(match[1].replace(/,/g, '') + (match[2] || ''));
    return Number.isFinite(n) && n >= 1 && n <= 1000000 ? n : null;
  }

  function visible(el) {
    try {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
    } catch (e) { return false; }
  }

  function stripCount(el) {
    if (!el || el.children.length < 5) return 0;
    let count = 0;
    for (const child of el.children) if (parse(child.textContent) !== null) count++;
    return count >= 5 && count >= el.children.length * 0.6 ? count : 0;
  }

  function findStripInDoc(doc) {
    try {
      let best = null, bestCount = 0;
      for (const el of doc.querySelectorAll('body *')) {
        const count = stripCount(el);
        if (count > bestCount && visible(el)) { best = el; bestCount = count; }
      }
      return best;
    } catch (e) { return null; }
  }

  function findStrip() {
    let s = findStripInDoc(document);
    if (s) return s;
    const iframes = document.querySelectorAll('iframe, frame');
    for (const f of iframes) {
      try {
        if (f.contentDocument) {
          s = findStripInDoc(f.contentDocument);
          if (s) return s;
        }
      } catch (e) {}
    }
    return null;
  }

  function currentStrip() {
    if (strip && strip.isConnected && stripCount(strip) && visible(strip)) return strip;
    return strip = findStrip();
  }

  // Floating HUD
  const hud = document.createElement('div');
  hud.id = '__aviator_hud';
  Object.assign(hud.style, {
    position: 'fixed', bottom: '16px', right: '16px', zIndex: '999999',
    background: '#181b21', color: '#eceef2', padding: '12px 14px', borderRadius: '10px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.5)', fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '13px', lineHeight: '1.4', maxWidth: '300px', border: '1px solid #2a2f38'
  });

  hud.innerHTML = \`
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:6px;">
      <strong style="color:#ff4d5e; font-size:14px;">✈ Aviator Live Stream</strong>
      <button id="__av_close" style="background:transparent; border:0; color:#9aa3b2; cursor:pointer; font-size:16px;">✕</button>
    </div>
    <div id="__av_status" style="margin-bottom:8px; color:#9aa3b2;">Scanning for game ribbon...</div>
    <div style="display:flex; gap:6px;">
      <button id="__av_pause" style="background:#232730; color:#eceef2; border:1px solid #3a3f4b; border-radius:6px; padding:4px 8px; cursor:pointer; font-size:12px;">Pause</button>
      <a href="\${SERVER}/dashboard?stream=\${STREAM}" target="_blank" style="background:#ff4d5e; color:#181b21; border-radius:6px; padding:4px 8px; text-decoration:none; font-weight:600; font-size:12px;">Open Tracker</a>
    </div>
  \`;

  document.body.appendChild(hud);

  const statusEl = hud.querySelector('#__av_status');
  hud.querySelector('#__av_close').onclick = () => teardown();
  hud.querySelector('#__av_pause').onclick = function() {
    running = !running;
    this.textContent = running ? 'Pause' : 'Resume';
    statusEl.textContent = running ? \`Streaming: \${sentCount} rounds\` : 'Paused';
  };

  async function flushOutbox() {
    if (sending || !outbox.length) return;
    sending = true;
    const batch = outbox.slice(0, 100);
    try {
      const res = await fetch(SERVER + '/api/rounds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + KEY
        },
        body: JSON.stringify({
          stream: STREAM,
          site: window.location.origin,
          rounds: batch
        })
      });
      if (res.ok) {
        outbox = outbox.slice(batch.length);
        sentCount += batch.length;
        if (statusEl) statusEl.innerHTML = \`<span style="color:#4fd18b;">● Live</span> · \${sentCount} rounds sent\`;
      } else {
        const err = await res.json().catch(() => ({}));
        if (statusEl) statusEl.textContent = 'Server: ' + (err.error || res.statusText);
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Network offline, retrying...';
    } finally {
      sending = false;
      if (outbox.length) setTimeout(flushOutbox, 2000);
    }
  }

  function sendRounds(values, isGap) {
    const now = Date.now();
    for (let i = 0; i < values.length; i++) {
      outbox.push({
        seq: seq++,
        value: values[i],
        gap: isGap && i === 0,
        at: now
      });
    }
    flushOutbox();
  }

  function scan() {
    scanTimer = 0;
    if (!running) return;
    const el = currentStrip();
    if (!el) {
      if (!sentCount && statusEl) statusEl.textContent = 'Looking for game ribbon...';
      return;
    }
    const entries = [], values = [];
    for (const child of el.children) {
      const v = parse(child.textContent);
      if (v !== null) { entries.push(child); values.push(v); }
    }
    if (!values.length) return;

    let fresh = 0;
    while (fresh < entries.length && !seen.has(entries[fresh])) fresh++;
    const isInitial = lastKey === null;
    entries.forEach(e => seen.add(e));
    const key = values.join();
    if (key === lastKey && !fresh) return;
    lastKey = key;

    if (isInitial) {
      // Ingest existing visible history (newest first, so reverse to store chronologically)
      sendRounds(values.slice().reverse(), false);
    } else if (fresh > 0) {
      // New rounds prepended to ribbon
      sendRounds(values.slice(0, fresh).reverse(), false);
    }
  }

  function queueScan() {
    if (!scanTimer) scanTimer = setTimeout(scan, 500);
  }

  const observer = new MutationObserver(queueScan);
  observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true});
  queueScan();

  function teardown() {
    observer.disconnect();
    clearTimeout(scanTimer);
    if (hud.parentNode) hud.parentNode.removeChild(hud);
    delete window.__aviatorStreamer;
  }

  window.__aviatorStreamer = {
    teardown,
    toggle: () => {
      hud.style.display = hud.style.display === 'none' ? 'block' : 'none';
    }
  };
})();`;

  return `javascript:${encodeURIComponent(scriptBody)}`;
}

export function generateUserscript(serverOrigin: string, apiKey: string): string {
  return `// ==UserScript==
// @name         Aviator Live Cloud Streamer
// @namespace    https://aviator-cloud.local
// @version      1.0
// @description  Streams Aviator rounds to your personal Aviator Cloud Tracker
// @match        *://*/*
// @allFrames    true
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
  'use strict';
  const SERVER = ${JSON.stringify(serverOrigin)};
  const KEY = ${JSON.stringify(apiKey)};
  const STREAM = 'userscript-' + Math.random().toString(36).slice(2, 10);

  let seq = 0;
  let sentCount = 0;
  let scanTimer = 0;
  let strip = null;
  let lastKey = null;
  let outbox = [];
  let sending = false;
  const seen = new WeakSet();

  function parse(text) {
    const t = String(text || '').trim();
    const match = t.match(/^(?:[x×]\\s*)?(\\d{1,3}(?:,\\d{3})+|\\d{1,7})(\\.\\d{1,4})?\\s*([x×])?$/i);
    if (!match) return null;
    const marked = /^[x×]/i.test(t) || Boolean(match[3]);
    if (!marked && (match[2] || '').length !== 3) return null;
    const n = Number(match[1].replace(/,/g, '') + (match[2] || ''));
    return Number.isFinite(n) && n >= 1 && n <= 1000000 ? n : null;
  }

  function stripCount(el) {
    if (!el || el.children.length < 5) return 0;
    let count = 0;
    for (const child of el.children) if (parse(child.textContent) !== null) count++;
    return count >= 5 && count >= el.children.length * 0.6 ? count : 0;
  }

  function findStrip() {
    let best = null, bestCount = 0;
    for (const el of document.body.querySelectorAll('body *')) {
      const count = stripCount(el);
      if (count > bestCount) { best = el; bestCount = count; }
    }
    return best;
  }

  function currentStrip() {
    if (strip && strip.isConnected && stripCount(strip)) return strip;
    return strip = findStrip();
  }

  function flushOutbox() {
    if (sending || !outbox.length) return;
    sending = true;
    const batch = outbox.slice(0, 100);
    GM_xmlhttpRequest({
      method: 'POST',
      url: SERVER + '/api/rounds',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + KEY
      },
      data: JSON.stringify({
        stream: STREAM,
        site: window.location.origin,
        rounds: batch
      }),
      onload: function(r) {
        sending = false;
        if (r.status >= 200 && r.status < 300) {
          outbox = outbox.slice(batch.length);
          sentCount += batch.length;
          console.log('[AviatorStreamer] sent', batch.length, 'rounds, total:', sentCount);
        }
        if (outbox.length) setTimeout(flushOutbox, 1500);
      },
      onerror: function() {
        sending = false;
        setTimeout(flushOutbox, 3000);
      }
    });
  }

  function sendRounds(values) {
    const now = Date.now();
    for (let i = 0; i < values.length; i++) {
      outbox.push({ seq: seq++, value: values[i], gap: false, at: now });
    }
    flushOutbox();
  }

  function scan() {
    scanTimer = 0;
    const el = currentStrip();
    if (!el) return;
    const entries = [], values = [];
    for (const child of el.children) {
      const v = parse(child.textContent);
      if (v !== null) { entries.push(child); values.push(v); }
    }
    if (!values.length) return;
    let fresh = 0;
    while (fresh < entries.length && !seen.has(entries[fresh])) fresh++;
    const isInitial = lastKey === null;
    entries.forEach(e => seen.add(e));
    const key = values.join();
    if (key === lastKey && !fresh) return;
    lastKey = key;

    if (isInitial) {
      sendRounds(values.slice().reverse());
    } else if (fresh > 0) {
      sendRounds(values.slice(0, fresh).reverse());
    }
  }

  const observer = new MutationObserver(() => {
    if (!scanTimer) scanTimer = setTimeout(scan, 500);
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true});
    scanTimer = setTimeout(scan, 1000);
  }
})();`;
}

