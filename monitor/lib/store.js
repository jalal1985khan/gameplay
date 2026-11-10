// Files the monitor keeps in data/. Rounds go to an append-only log per game site, so a crash or
// a power cut can lose at most the line being written, and switching sites never erases anything.
const fs = require('fs');
const path = require('path');

// Replaces a file in one step: a crash mid-write leaves the old file, never an empty one.
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function createStore(dataDir, maxRounds) {
  const roundsDir = path.join(dataDir, 'rounds');
  const metaFile = path.join(dataDir, 'meta.json');
  const daysFile = path.join(dataDir, 'days.ndjson');
  const logFile = origin => path.join(roundsDir, `${String(origin).replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]+/gi, '_') || 'unknown'}.ndjson`);
  const lines = file => {
    try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  };

  // The newest maxRounds rounds of one site: {origin, values, times, gaps}, oldest first.
  function load(origin) {
    const history = {origin, values: [], times: [], gaps: []};
    if (!origin) return history;
    for (const line of lines(logFile(origin)).slice(-maxRounds)) {
      let r;
      try { r = JSON.parse(line); } catch { continue; } // A half-written last line.
      if (!(typeof r.v === 'number' && r.v >= 1)) continue;
      if (r.g && history.values.length) history.gaps.push(history.values.length);
      history.values.push(r.v);
      history.times.push(r.t || 0);
    }
    return history;
  }

  // fresh: new rounds, oldest first. gap: rounds were missed before the first of them.
  function append(origin, fresh, now, gap) {
    if (!origin || !fresh.length) return;
    try {
      fs.mkdirSync(roundsDir, {recursive: true});
      fs.appendFileSync(logFile(origin), fresh.map((v, i) => JSON.stringify(gap && i === 0 ? {t: now, v, g: 1} : {t: now, v})).join('\n') + '\n');
    } catch {}
  }
  function clear(origin) {
    try { fs.rmSync(logFile(origin), {force: true}); } catch {}
  }

  // The site captured last, so its rounds are shown again when the monitor starts.
  function lastOrigin() {
    const origin = readJson(metaFile, {}).origin || null;
    if (origin) return origin;
    // Rounds saved by earlier versions (one history.json, rewritten whole) move into the log.
    const legacyFile = path.join(dataDir, 'history.json');
    const legacy = readJson(legacyFile, null);
    if (!legacy || !legacy.origin || !Array.isArray(legacy.values) || !legacy.values.length) return null;
    const gaps = new Set(legacy.gaps || []);
    try {
      fs.mkdirSync(roundsDir, {recursive: true});
      fs.appendFileSync(logFile(legacy.origin), legacy.values.map((v, i) => JSON.stringify({t: (legacy.times || [])[i] || 0, v, ...(gaps.has(i) ? {g: 1} : {})})).join('\n') + '\n');
      fs.renameSync(legacyFile, `${legacyFile}.migrated`);
      setOrigin(legacy.origin);
    } catch {}
    return legacy.origin;
  }
  function setOrigin(origin) {
    try { atomicWrite(metaFile, JSON.stringify({origin})); } catch {}
  }

  // Finished days, one summary per line, kept for the "Past days" table.
  function addDay(day) {
    try { fs.mkdirSync(dataDir, {recursive: true}); fs.appendFileSync(daysFile, JSON.stringify(day) + '\n'); } catch {}
  }
  function days(limit = 60) {
    const out = [];
    for (const line of lines(daysFile).slice(-limit)) { try { out.push(JSON.parse(line)); } catch {} }
    return out.reverse();
  }

  return {load, append, clear, lastOrigin, setOrigin, addDay, days, logFile};
}

module.exports = {createStore, atomicWrite, readJson};
