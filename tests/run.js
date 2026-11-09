// Runs every test file: node tests/run.js
const fs = require('fs'), path = require('path');
const {run} = require('./harness');

for (const file of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort()) require(path.join(__dirname, file));
run().then(failed => { process.exitCode = failed ? 1 : 0; });
