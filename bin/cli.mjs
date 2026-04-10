#!/usr/bin/env node

/**
 * proto-annotation CLI
 *
 * Usage:
 *   npx proto-annotation                        → demo mode (built-in test page)
 *   npx proto-annotation http://localhost:3000   → proxy that URL in the review UI
 *   npx proto-annotation --port 4747            → custom server port
 *   npx proto-annotation --no-open              → don't auto-open browser
 *   npx proto-annotation --demo                 → explicitly use built-in demo page
 *   npx proto-annotation --collab               → enable collaborative review session
 */

import { createServer } from '../src/server/index.mjs';
import open from 'open';
import { networkInterfaces } from 'os';

const args = process.argv.slice(2);

let targetUrl = null;
let port = 4747;
let shouldOpen = true;
let demo = false;
let collab = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1]);
    i++;
  } else if (args[i] === '--no-open') {
    shouldOpen = false;
  } else if (args[i] === '--demo') {
    demo = true;
  } else if (args[i] === '--collab') {
    collab = true;
  } else if (args[i].startsWith('http')) {
    targetUrl = args[i];
  } else if (!args[i].startsWith('-')) {
    targetUrl = args[i].includes('://') ? args[i] : `http://${args[i]}`;
  }
}

// If no URL provided, use demo mode
if (!targetUrl) demo = true;

// Get LAN IP for collab sharing
function getLanIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// ANSI helpers
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const { server, inviteCode, hostToken } = createServer({ port, targetUrl, demo, collab });

server.listen(port, () => {
  const target = demo ? dim('built-in demo') : cyan(targetUrl);

  console.log('');
  console.log(`  ${bold('proto-annotation')}${collab ? '  ' + dim('collab') : ''}`);
  console.log(dim('  ───────────────────────────────────'));
  console.log('');
  console.log(`  ${dim('Target')}   ${target}`);
  console.log(`  ${dim('Server')}   ${cyan(`http://localhost:${port}`)}`);

  if (collab) {
    const lanIP = getLanIP();
    const shareUrl = `http://${lanIP}:${port}/join?code=${inviteCode}`;
    console.log('');
    console.log(`  ${dim('Session')}  ${yellow(inviteCode)}`);
    console.log(`  ${dim('Share')}    ${green(shareUrl)}`);
    console.log('');
    console.log(`  ${dim('Share the link above with your team.')}`);
  }

  console.log('');
  console.log(dim('  Ctrl+C to stop'));
  console.log('');

  if (shouldOpen) {
    const hostUrl = collab
      ? `http://localhost:${port}/?hostToken=${hostToken}`
      : `http://localhost:${port}`;
    open(hostUrl);
  }
});
