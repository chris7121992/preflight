// Stops a publish when a page script does not parse: one syntax error stops the whole page.
const { execFileSync } = require('node:child_process'), path = require('node:path'), fs = require('node:fs');
const dir = path.join(__dirname, '..', 'public');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'engine.js')) execFileSync(process.execPath, ['--check', path.join(dir, f)], { stdio: 'inherit' });
