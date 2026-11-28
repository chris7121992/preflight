#!/usr/bin/env node
'use strict';
// Keeps the site's weather fresh from your own computer instead of GitHub.
// Every 10 minutes: fetch the weather snapshot, then publish it to Firebase Hosting.
// Run with:  npm run refresh     (leave the window open; Ctrl+C stops it)
// Sign-in is your own Google account through the Firebase tool; no key file is stored.
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROJECT = 'preflight-29da3';
const FIREBASE = 'npx -y firebase-tools@15.37.0';
const EVERY_MIN = Math.max(5, Number(process.env.REFRESH_MINUTES) || 10);
const DRY = process.argv.includes('--dry-run'); // fetch only, publish nothing
const ONCE = process.argv.includes('--once');

const run = (cmd, quiet) => spawnSync(cmd, { cwd: ROOT, shell: true, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
const stamp = () => new Date().toLocaleTimeString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 18) { console.error('Node 18 or newer is needed (nodejs.org).'); process.exit(1); }
  console.log('Building the briefing engine...');
  if (run('npm run build').status !== 0) { console.error('Build failed; nothing was published.'); process.exit(1); }
  if (!DRY) {
    console.log('Checking the Firebase sign-in (a browser window opens the first time)...');
    if (run(`${FIREBASE} login`).status !== 0) { console.error('Firebase sign-in did not finish.'); process.exit(1); }
  }
  console.log(`Refreshing every ${EVERY_MIN} minutes. Leave this window open. Ctrl+C stops it.`);
  let fails = 0;
  for (;;) {
    const start = Date.now();
    let ok = run('node scripts/snapshot.js').status === 0;
    if (!ok) console.error(`[${stamp()}] Could not fetch the weather; will try again.`);
    else if (!DRY) {
      const d = run(`${FIREBASE} deploy --only hosting --project ${PROJECT} --non-interactive --message "weather refresh from computer"`, true);
      ok = d.status === 0;
      if (ok) console.log(`[${stamp()}] Published.`);
      else console.error(`[${stamp()}] Publish failed; will try again.\n${String(d.stderr || d.stdout || '').split('\n').slice(-6).join('\n')}`);
    }
    if (ONCE) process.exit(ok ? 0 : 1);
    fails = ok ? 0 : fails + 1;
    // after a failure retry sooner, so one bad fetch does not leave the data stale
    const wait = ok ? EVERY_MIN * 60e3 - (Date.now() - start) : Math.min(fails, 3) * 60e3;
    await sleep(Math.max(30e3, wait));
  }
}
main();
