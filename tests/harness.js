// Minimal test harness and fakes for the Chrome extension APIs and the page DOM. No dependencies.
const fs = require('fs'), path = require('path'), vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const wait = (ms = 0) => new Promise(r => setTimeout(r, ms));
// Lets queued background work (storage calls take a few random milliseconds) finish.
const settle = () => wait(120);

const tests = [];
const test = (name, fn) => tests.push({name, fn});
async function run() {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok   ${t.name}`); }
    catch (e) { failed++; console.log(`  FAIL ${t.name}\n       ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n       ')}`); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  return failed;
}

// Deterministic random numbers (mulberry32), so statistical tests never flake.
function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// Fair crash points: P(X >= x) = 0.97 / x, shown with two decimals, never below 1.00.
const fairRounds = (n, seed = 1) => {
  const r = rng(seed);
  return Array.from({length: n}, () => Math.max(1, Math.floor(0.97 / (1 - r()) * 100) / 100));
};

function event() {
  const listeners = [];
  return {
    listeners,
    addListener: f => listeners.push(f),
    removeListener: f => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
    hasListener: f => listeners.includes(f),
    fire: (...args) => listeners.map(f => f(...args)),
  };
}

// chrome.storage area with async calls in random order of a few ms, like the real one.
function storageArea(name, onChanged) {
  const data = {};
  const tick = () => wait(Math.random() * 3);
  const pick = keys => {
    const out = {};
    for (const k of keys == null ? Object.keys(data) : [].concat(keys)) if (k in data) out[k] = clone(data[k]);
    return out;
  };
  const notify = changes => { if (Object.keys(changes).length) onChanged.fire(changes, name); };
  return {
    data,
    get(keys, cb) { const p = tick().then(() => pick(keys)); if (cb) p.then(cb); return p; },
    async set(obj) {
      await tick();
      const changes = {};
      for (const [k, v] of Object.entries(obj)) { changes[k] = {oldValue: clone(data[k]), newValue: clone(v)}; data[k] = clone(v); }
      notify(changes);
    },
    async remove(keys) {
      await tick();
      const changes = {};
      for (const k of [].concat(keys)) if (k in data) { changes[k] = {oldValue: clone(data[k])}; delete data[k]; }
      notify(changes);
    },
  };
}

function makeChrome() {
  const onChanged = event();
  const calls = {executeScript: [], tabMessages: [], runtimeMessages: []};
  const tabs = new Map();
  const chrome = {
    storage: {local: storageArea('local', onChanged), session: storageArea('session', onChanged), onChanged},
    runtime: {
      onMessage: event(), onInstalled: event(), onStartup: event(),
      reply: {ok: true},
      sendMessage: async m => { calls.runtimeMessages.push(clone(m)); return chrome.runtime.reply; },
    },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      sendMessage: async (tabId, message) => { calls.tabMessages.push({tabId, message: clone(message)}); },
      get: async id => { if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`); return {...tabs.get(id)}; },
      query: async () => [...tabs.values()].filter(t => t.active).map(t => ({...t})),
    },
    scripting: {
      fail: null,
      executeScript: async options => { calls.executeScript.push(clone(options)); if (chrome.scripting.fail) throw new Error(chrome.scripting.fail); return []; },
    },
    permissions: {granted: true, contains: async () => chrome.permissions.granted, request: async () => chrome.permissions.granted},
  };
  return {chrome, calls, tabs};
}

// Loads background.js (and the match.js it imports) into a fresh context with fake APIs.
function loadBackground({fetch: realFetch} = {}) {
  const {chrome, calls, tabs} = makeChrome();
  // Fake network for cloud sync: records requests and answers with net.reply(request).
  const net = {requests: [], reply: () => ({status: 200, body: {ok: true}})};
  const fetch = async (url, init) => {
    const req = {url, ...init, body: JSON.parse(init.body)};
    net.requests.push(req);
    const r = net.reply(req);
    if (r instanceof Error) throw r;
    return {ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body};
  };
  const ctx = vm.createContext({chrome, console, URL, fetch: realFetch || fetch, crypto: require('crypto').webcrypto, setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 10)), clearTimeout});
  ctx.importScripts = (...files) => files.forEach(f => vm.runInContext(read(f), ctx, {filename: f}));
  vm.runInContext(read('background.js'), ctx, {filename: 'background.js'});
  // Delivers a runtime message the way Chrome does, resolving with a serialized copy of the response.
  const send = (message, sender = {}) => new Promise(resolve => {
    let pending = false;
    const respond = r => resolve(clone(r));
    for (const f of chrome.runtime.onMessage.listeners) if (f(message, sender, respond) === true) pending = true;
    if (!pending) resolve(undefined);
  });
  return {chrome, calls, tabs, send, net, local: chrome.storage.local.data, session: chrome.storage.session.data};
}

// A tiny DOM: enough of Element, document and MutationObserver for content.js.
class El {
  constructor(tagName, text = '', children = []) {
    Object.assign(this, {tagName, text, children, isConnected: true, hidden: false});
  }
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join(' ') : this.text; }
  getClientRects() { return this.hidden ? [] : [{}]; }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
}
const chipsOf = values => values.map(v => new El('DIV', String(v)));

function loadPage(body) {
  const sent = [], timers = new Map(), observers = [], docListeners = [];
  let timerId = 0, broken = false;
  const chrome = {runtime: {
    onMessage: event(),
    sendMessage: m => { if (broken) throw new Error('Extension context invalidated.'); sent.push(clone(m)); return Promise.resolve(); },
  }};
  const document = {
    body, documentElement: {},
    addEventListener: (type, f, capture) => docListeners.push({type, f, capture}),
    removeEventListener: (type, f, capture) => { const i = docListeners.findIndex(l => l.type === type && l.f === f && l.capture === capture); if (i >= 0) docListeners.splice(i, 1); },
  };
  body.querySelectorAll = () => [...body.walk()];
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.active = false; observers.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  }
  const ctx = vm.createContext({
    window: {}, document, chrome, MutationObserver,
    getComputedStyle: el => ({display: el.hidden ? 'none' : 'block', visibility: 'visible'}),
    setTimeout: f => { timers.set(++timerId, f); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  const page = {
    sent, observers, docListeners, chrome, ctx,
    inject: () => vm.runInContext(read('content.js'), ctx, {filename: 'content.js'}),
    // A DOM change followed by the 500 ms scan timer firing.
    mutate: () => {
      observers.filter(o => o.active).forEach(o => o.cb([]));
      const due = [...timers.values()]; timers.clear(); due.forEach(f => f());
    },
    fireLoad: tagName => docListeners.filter(l => l.type === 'load' && l.capture).forEach(l => l.f({target: {tagName}})),
    breakRuntime: () => { broken = true; },
  };
  return page;
}

module.exports = {test, run, read, clone, wait, settle, rng, fairRounds, loadBackground, loadPage, El, chipsOf, makeChrome, ROOT};
