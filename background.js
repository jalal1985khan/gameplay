// Owns capture: starts and stops it, re-attaches the page script after reloads, and turns
// snapshots of the game's results list into stored rounds. Every state change runs through one
// queue, so bursts and overlapping events never interleave their storage reads and writes.
importScripts('match.js');

const LOCK_EXPIRY = 120000; // A reporting frame silent this long can be replaced by another one.
const OUTBOX_MAX = 5000; // Rounds waiting for upload; older ones are dropped (and marked) beyond this.
const UPLOAD_BATCH = 500;
const local = chrome.storage.local, session = chrome.storage.session;
let queue = Promise.resolve();
let reattachTimer = 0;

const enqueue = task => { const run = queue.then(task); queue = run.catch(() => {}); return run; };
const originOf = url => {
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) ? u.origin : null; } catch { return null; }
};

async function setCapture(patch) {
  const {capture} = await local.get('capture');
  if (!capture) return;
  await local.set({capture: {...capture, ...patch}});
}

async function attach(tabId) {
  // Frame ids change when the page reloads, so the reporting frame is picked again.
  await session.remove('captureFrame');
  await chrome.scripting.executeScript({target: {tabId, allFrames: true}, files: ['content.js']});
}

async function sendStop(tabId) {
  try { await chrome.tabs.sendMessage(tabId, {type: 'AVIATOR_STOP'}); } catch {}
}

async function startCapture(tabId, origin) {
  if (!Number.isInteger(tabId) || !originOf(origin)) return {ok: false, error: 'invalid tab or site'};
  const {capture} = await local.get('capture');
  if (capture && capture.tabId !== tabId && capture.state !== 'stopped') await sendStop(capture.tabId);
  await local.set({capture: {tabId, origin, state: 'running', startedAt: Date.now(), lastSnapshotAt: null, lastRoundAt: null, note: ''}});
  try {
    await attach(tabId);
    return {ok: true};
  } catch (e) {
    const error = e?.message || 'unknown error';
    await setCapture({state: 'stopped', note: `Could not attach: ${error}`});
    return {ok: false, error};
  }
}

async function stopCapture() {
  const {capture} = await local.get('capture');
  if (!capture) return;
  await sendStop(capture.tabId);
  await setCapture({state: 'stopped', note: ''});
}

async function onSnapshot(sender, values, newCount) {
  const {capture} = await local.get('capture');
  if (capture?.state !== 'running' || capture.tabId !== sender.tab.id) return;
  // The page script runs in every frame; one frame reports at a time.
  const id = String(sender.frameId ?? 0), now = Date.now();
  const {captureFrame: lock} = await session.get('captureFrame');
  if (lock && lock.id !== id && now - lock.at < LOCK_EXPIRY) return;
  await session.set({captureFrame: {id, at: now}});
  const data = await local.get(['captured', 'gaps']);
  const history = Array.isArray(data.captured) ? data.captured.filter(Number.isFinite) : [];
  const gaps = Array.isArray(data.gaps) ? data.gaps.filter(Number.isInteger) : [];
  const {fresh, gap} = AviatorMatch.newRounds(history, values, newCount);
  const patch = {capture: {...capture, lastSnapshotAt: now, lastRoundAt: fresh.length ? now : capture.lastRoundAt,
    lastGapAt: gap && history.length && fresh.length ? now : capture.lastGapAt ?? null}};
  if (fresh.length) {
    Object.assign(patch, AviatorMatch.append(history, gaps, fresh, gap), {lastCaptureAt: now});
    Object.assign(patch, await queueUpload(fresh, gap && history.length > 0, now, capture.origin));
  }
  await local.set(patch);
  if (fresh.length) flushSoon();
}

// ---- Cloud sync (off unless the user saves a server address and key in the popup) ----
// Every captured round gets a sequence number that only ever grows, so the server can drop
// rounds that a retry sends twice. Rounds wait in an outbox until the server confirms them.
async function queueUpload(fresh, gap, now, origin) {
  const {cloud, cloudSeq = 0, outbox = []} = await local.get(['cloud', 'cloudSeq', 'outbox']);
  if (!cloud?.url) return {};
  const items = fresh.map((value, i) => ({seq: cloudSeq + i, value, gap: gap && i === 0, at: now, site: origin}));
  const all = [...outbox, ...items], drop = Math.max(0, all.length - OUTBOX_MAX);
  const kept = all.slice(drop);
  if (drop && kept.length) kept[0] = {...kept[0], gap: true}; // The server also sees the jump in seq.
  return {cloudSeq: cloudSeq + fresh.length, outbox: kept};
}

let flushing = false, flushTimer = 0;
const flushSoon = () => { clearTimeout(flushTimer); flushTimer = setTimeout(flushOutbox, 300); };

// Uploads waiting rounds in batches. Runs outside the queue so a slow network never holds up
// capture; only reading and trimming the outbox go through the queue.
async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const {cloud, outbox = []} = await enqueue(() => local.get(['cloud', 'outbox']));
      if (!cloud?.url || !cloud.key || !outbox.length) return;
      // One site per batch, so each round keeps the site it was captured on.
      const site = outbox[0].site ?? null;
      const batch = [];
      for (const r of outbox) { if (batch.length >= UPLOAD_BATCH || (r.site ?? null) !== site) break; batch.push(r); }
      let status;
      try {
        const res = await fetch(`${cloud.url}/api/rounds`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', Authorization: `Bearer ${cloud.key}`},
          body: JSON.stringify({stream: cloud.stream, site, rounds: batch.map(({seq, value, gap, at}) => ({seq, value, gap, at}))}),
        });
        const body = await res.json().catch(() => ({}));
        status = res.ok ? null : res.status === 401 ? 'The server did not accept the key. Check it in Cloud sync.' : `Server error ${res.status}: ${body.error || 'unknown'}`;
      } catch (e) {
        status = 'Could not reach the server. Rounds are kept and sent when it is back.';
      }
      const sent = new Set(batch.map(r => r.seq));
      await enqueue(async () => {
        const {outbox: now = [], cloudStatus = {}} = await local.get(['outbox', 'cloudStatus']);
        const left = status ? now : now.filter(r => !sent.has(r.seq));
        await local.set({outbox: left, cloudStatus: status
          ? {...cloudStatus, error: status, errorAt: Date.now(), pending: left.length}
          : {okAt: Date.now(), error: '', pending: left.length}});
      });
      if (status) return;
    }
  } finally {
    flushing = false;
  }
}

async function setCloud(url, key) {
  const {cloud} = await local.get('cloud');
  if (!url) { await local.set({cloud: null, outbox: [], cloudStatus: {}}); return {ok: true}; }
  const origin = originOf(url);
  const secure = origin && (origin.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  if (!secure) return {ok: false, error: 'Use an https:// server address (http:// only for localhost).'};
  if (typeof key !== 'string' || !/^avk_[A-Za-z0-9_-]{43}$/.test(key)) return {ok: false, error: 'The key should start with avk_ and be 47 characters long.'};
  // A new server or key starts a new stream; the same one keeps numbering where it was.
  const same = cloud && cloud.url === origin && cloud.key === key;
  await local.set({cloud: {url: origin, key, stream: same ? cloud.stream : crypto.randomUUID()}, ...same ? {} : {outbox: [], cloudStatus: {}}});
  return {ok: true};
}

// A frame inside the capture tab loaded a new document (e.g. the game iframe reloaded) and lost
// its page script. Re-attach once things settle; re-injection replaces the copies still running.
function scheduleReattach(tabId) {
  clearTimeout(reattachTimer);
  reattachTimer = setTimeout(() => enqueue(async () => {
    const {capture} = await local.get('capture');
    if (capture?.state === 'running' && capture.tabId === tabId) await attach(tabId).catch(() => {});
  }), 1000);
}

// The capture tab finished loading a page: resume on the game site, pause anywhere else.
async function onTabLoaded(tabId, url) {
  const {capture} = await local.get('capture');
  if (!capture || capture.tabId !== tabId || capture.state === 'stopped') return;
  if (originOf(url) !== capture.origin) {
    await setCapture({state: 'interrupted', note: 'The capture tab left the game site. Capture resumes when it returns.'});
    return;
  }
  if (!await chrome.permissions.contains({origins: ['<all_urls>']})) {
    await setCapture({state: 'interrupted', note: 'Site access was removed. Press Start to allow it again.'});
    return;
  }
  try {
    await attach(tabId);
    await setCapture({state: 'running', note: 'Resumed after the page reloaded.'});
  } catch (e) {
    await setCapture({state: 'interrupted', note: `Could not re-attach: ${e?.message || 'unknown error'}`});
  }
}

// After an extension update the old page scripts can no longer report, so attach fresh ones.
async function resumeAfterUpdate() {
  await local.remove('captureTabId'); // Replaced by capture.tabId in 1.3.0.
  const {capture} = await local.get('capture');
  if (capture?.state !== 'running') return;
  try {
    const tab = await chrome.tabs.get(capture.tabId);
    if (originOf(tab.url) === capture.origin) { await attach(tab.id); return; }
  } catch {}
  await setCapture({state: 'interrupted', note: 'The extension was updated and the game tab was not found. Press Start again.'});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case 'AVIATOR_SNAPSHOT': {
      const {values, newCount} = message;
      // A snapshot is used whole or not at all, so newCount stays aligned with its values.
      if (!sender.tab || !Array.isArray(values) || !values.length || !values.every(v => Number.isFinite(v) && v >= 1)) return;
      enqueue(() => onSnapshot(sender, values, Number.isInteger(newCount) ? newCount : null));
      return;
    }
    case 'AVIATOR_FRAME_LOADED':
      if (sender.tab) scheduleReattach(sender.tab.id);
      return;
    case 'AVIATOR_CAPTURE_START':
      if (sender.tab) return; // Only the popup starts or stops capture.
      enqueue(() => startCapture(message.tabId, message.origin)).then(sendResponse, e => sendResponse({ok: false, error: e?.message || 'unknown error'}));
      return true;
    case 'AVIATOR_CAPTURE_STOP':
      if (sender.tab) return;
      enqueue(stopCapture).then(() => sendResponse({ok: true}), () => sendResponse({ok: false}));
      return true;
    case 'AVIATOR_CLOUD_SET':
      if (sender.tab) return; // Only the popup changes where rounds are sent.
      enqueue(() => setCloud(message.url, message.key)).then(r => { sendResponse(r); if (r.ok) flushSoon(); },
        e => sendResponse({ok: false, error: e?.message || 'unknown error'}));
      return true;
    case 'AVIATOR_CLOUD_FLUSH':
      if (sender.tab) return;
      flushSoon();
      return;
  }
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete') enqueue(() => onTabLoaded(tabId, tab.url));
});
chrome.tabs.onRemoved.addListener(tabId => enqueue(async () => {
  const {capture} = await local.get('capture');
  if (capture?.tabId === tabId && capture.state !== 'stopped') await setCapture({state: 'stopped', note: 'The capture tab was closed.'});
}));
chrome.runtime.onInstalled.addListener(() => { enqueue(resumeAfterUpdate); flushSoon(); });
chrome.runtime.onStartup.addListener(() => enqueue(async () => {
  const {capture} = await local.get('capture');
  if (capture && capture.state !== 'stopped') await setCapture({state: 'stopped', note: 'The browser restarted. Press Start to capture again.'});
}).then(flushSoon));
