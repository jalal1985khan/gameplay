// Sign-in for the monitor page, used when it is shared beyond this computer. Accounts live in
// data/users.json (name, role, salted scrypt hash; never the password). Two roles: an admin can
// do everything, a viewer can only look. With no accounts the monitor works as before, for this
// computer only.
const crypto = require('crypto');
const path = require('path');
const {atomicWrite, readJson} = require('./store.js');

const ROLES = ['admin', 'viewer'];
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_FAILS = 5, LOCK_MS = 10 * 60 * 1000;

function createAuth(dataDir) {
  const file = path.join(dataDir, 'users.json');
  const users = () => {
    const list = readJson(file, []);
    return Array.isArray(list) ? list.filter(u => u && typeof u.name === 'string' && ROLES.includes(u.role) && u.salt && u.hash) : [];
  };
  const hash = (password, salt) => crypto.scryptSync(String(password), salt, 32).toString('hex');
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  function addUser(name, role, password) {
    name = String(name || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{2,32}$/.test(name)) return {ok: false, error: 'Use 2 to 32 letters, digits, dots, dashes or underscores for the name.'};
    if (!ROLES.includes(role)) return {ok: false, error: 'The role is admin or viewer.'};
    if (String(password || '').length < 8) return {ok: false, error: 'Use a password of at least 8 characters.'};
    const salt = crypto.randomBytes(16).toString('hex');
    atomicWrite(file, JSON.stringify([...users().filter(u => u.name !== name), {name, role, salt, hash: hash(password, salt)}], null, 1));
    return {ok: true, name, role};
  }
  function removeUser(name) {
    name = String(name || '').trim().toLowerCase();
    const list = users();
    if (!list.some(u => u.name === name)) return {ok: false, error: `There is no account named ${name}.`};
    atomicWrite(file, JSON.stringify(list.filter(u => u.name !== name), null, 1));
    return {ok: true};
  }

  const sessions = new Map(); // token -> {name, until}
  const fails = new Map(); // address -> {n, until}

  function login(name, password, address = '') {
    const now = Date.now();
    const f = fails.get(address);
    if (f && f.n >= MAX_FAILS && f.until > now) return {ok: false, locked: true, error: `Too many wrong tries. Wait ${Math.ceil((f.until - now) / 60000)} minutes.`};
    name = String(name || '').trim().toLowerCase();
    const user = users().find(u => u.name === name);
    // The same work is done for an unknown name, so the answer takes equally long either way.
    const good = same(hash(password, user ? user.salt : '00'), user ? user.hash : hash('', '01')) && !!user;
    if (!good) {
      const n = f && f.until > now ? f.n + 1 : 1;
      fails.set(address, {n, until: now + LOCK_MS});
      return {ok: false, error: 'Wrong name or password.'};
    }
    fails.delete(address);
    for (const [t, s] of sessions) if (s.until < now) sessions.delete(t);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, {name, until: now + SESSION_MS});
    return {ok: true, token, name, role: user.role, maxAge: SESSION_MS / 1000};
  }
  // Who a session token belongs to. The account is looked up each time, so removing an account
  // or changing its role takes effect at once.
  function who(token) {
    const s = token && sessions.get(token);
    if (!s) return null;
    if (s.until < Date.now()) { sessions.delete(token); return null; }
    const user = users().find(u => u.name === s.name);
    return user ? {name: user.name, role: user.role} : null;
  }
  const logout = token => { sessions.delete(token); };

  return {enabled: () => users().length > 0, list: () => users().map(u => ({name: u.name, role: u.role})), addUser, removeUser, login, who, logout};
}

module.exports = {createAuth, ROLES};
