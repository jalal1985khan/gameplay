#!/usr/bin/env node
// Accounts for the monitor page:
//   node users.js add <name> <admin|viewer>   (asks for the password; also changes an account)
//   node users.js remove <name>
//   node users.js list
const path = require('path');
const readline = require('readline');
const {createAuth} = require('./lib/auth.js');

const auth = createAuth(process.env.MONITOR_DATA_DIR || path.join(__dirname, 'data'));
const [cmd, name, role] = process.argv.slice(2);

// Reads a line without showing it on a terminal; piped input is read as it is.
function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY});
    if (process.stdin.isTTY) rl._writeToOutput = s => { if (s.includes(question)) process.stdout.write(question); };
    rl.question(question, answer => { rl.close(); if (process.stdin.isTTY) process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  if (cmd === 'list') {
    const list = auth.list();
    console.log(list.length ? list.map(u => `${u.name}\t${u.role}`).join('\n') : 'No accounts yet: the monitor is open to this computer only.');
  } else if (cmd === 'remove') {
    const r = auth.removeUser(name);
    console.log(r.ok ? `Removed ${name}.` : r.error);
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === 'add') {
    const password = process.env.MONITOR_USER_PASSWORD || await ask(`Password for ${name} (at least 8 characters): `);
    const r = auth.addUser(name, role, password);
    console.log(r.ok ? `Saved ${r.name} as ${r.role}. They can sign in now; no restart needed.` : r.error);
    process.exitCode = r.ok ? 0 : 1;
  } else {
    console.log('Usage:\n  node users.js add <name> <admin|viewer>\n  node users.js remove <name>\n  node users.js list');
    process.exitCode = 1;
  }
})();
