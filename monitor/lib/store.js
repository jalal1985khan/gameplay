// Files the monitor keeps in data/. Rounds go to an append-only log per game site, so a crash or
// a power cut can lose at most the line being written, and switching sites never erases anything.
const fs = require('fs');
const path = require('path');

// Replaces a file in one step: a crash mid-write leaves the old file, never an empty one.
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, {mode: 0o600});
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
  // Read only the tail; lifetime log size must not determine startup memory use.
  const lines = (file, limit) => {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      let pos = fs.fstatSync(fd).size, text = '', count = 0;
      while (pos > 0 && count <= limit) {
        const size = Math.min(65536, pos), buf = Buffer.alloc(size);
        pos -= size;
        fs.readSync(fd, buf, 0, size, pos);
        const chunk = buf.toString('utf8');
        count += (chunk.match(/\n/g) || []).length;
        text = chunk + text;
      }
      if (pos > 0) text = text.slice(text.indexOf('\n') + 1);
      return text.split('\n').filter(Boolean).slice(-limit);
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  function appendLog(file, text) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    // Separate an interrupted final line from the next record. Preserve it for diagnostics.
    const fd = fs.openSync(file, 'a+', 0o600);
    try {
      const size = fs.fstatSync(fd).size, last = Buffer.alloc(1);
      if (size) fs.readSync(fd, last, 0, 1, size - 1);
      fs.writeSync(fd, (size && last[0] !== 10 ? '\n' : '') + text);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }


  // The newest maxRounds rounds of one site: {origin, values, times, gaps}, oldest first.
  function load(origin) {
    const history = {origin, values: [], times: [], gaps: []};
    if (!origin) return history;
    for (const line of lines(logFile(origin), maxRounds)) {
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
    appendLog(logFile(origin), fresh.map((v, i) => JSON.stringify(gap && i === 0 ? {t: now, v, g: 1} : {t: now, v})).join('\n') + '\n');
  }
  // The log is set aside under a dated name rather than deleted, so a mistaken Clear can be undone
  // by renaming the file back.
  function clear(origin) {
    const file = logFile(origin);
    try { if (fs.statSync(file).size) fs.renameSync(file, file.replace(/\.ndjson$/, `.cleared-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
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
    atomicWrite(metaFile, JSON.stringify({origin}));
  }

  // Finished days, one summary per line, kept for the "Past days" table.
  function addDay(day) {
    appendLog(daysFile, JSON.stringify(day) + '\n');
  }
  function days(limit = 60) {
    const out = [];
    for (const line of lines(daysFile, limit)) { try { out.push(JSON.parse(line)); } catch {} }
    return out.reverse();
  }

  return {load, append, clear, lastOrigin, setOrigin, addDay, days, logFile};
}

module.exports = {createStore, atomicWrite, readJson};
