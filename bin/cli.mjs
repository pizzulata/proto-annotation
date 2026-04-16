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
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Load .env file from current working directory (no extra dependencies)
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

const args = process.argv.slice(2);

let targetUrl = null;
let port = 4747;
let shouldOpen = true;
let demo = false;
let collab = false;
let anthropicKey = null;

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
  } else if (args[i] === '--anthropic-key' && args[i + 1]) {
    anthropicKey = args[i + 1];
    i++;
  } else if (args[i].startsWith('http')) {
    targetUrl = args[i];
  } else if (!args[i].startsWith('-')) {
    targetUrl = args[i].includes('://') ? args[i] : `http://${args[i]}`;
  }
}

// Resolve API key: flag > .env / env var
if (anthropicKey) process.env.ANTHROPIC_API_KEY = anthropicKey;

// Annotations data file — persists across restarts in the current working directory
const dataPath = resolve(process.cwd(), '.proto-annotation-data.json');

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

// ANSI helpers — 256-color palette, no fluorescents
const reset = '\x1b[0m';
const c     = (n, s) => `\x1b[38;5;${n}m${s}${reset}`;
const bold  = (s) => `\x1b[1m${s}${reset}`;
const muted = (s) => c(242, s);  // medium gray  — labels, dividers
const faint = (s) => c(238, s);  // dark gray     — footer, hints
const link  = (s) => c(110, s);  // slate blue    — URLs
const code  = (s) => c(179, s);  // warm amber    — invite code
const share = (s) => c(108, s);  // sage green    — share URL
const bx    = (s) => c(103, s);  // muted blue-gray — logo box

// Read version from package.json
let version = '';
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  version = pkg.version;
} catch {}

const { server, inviteCode, hostToken } = createServer({ port, targetUrl, demo, collab, dataPath });

server.listen(port, () => {
  const target = demo ? muted('built-in demo') : link(targetUrl);

  const logoLines = [
    `    ____             __           ___                      __        __  _`,
    `   / __ \\_________  / /_____     /   |  ____  ____  ____  / /_____ _/ /_(_)___  ____`,
    `  / /_/ / ___/ __ \\/ __/ __ \\   / /| | / __ \\/ __ \\/ __ \\/ __/ __ \`/ __/ / __ \\/ __ \\`,
    ` / ____/ /  / /_/ / /_/ /_/ /  / ___ |/ / / / / / / /_/ / /_/ /_/ / /_/ / /_/ / / / /`,
    `/_/   /_/   \\____/\\__/\\____/  /_/  |_/_/ /_/_/ /_/\\____/\\__/\\__,_/\\__/_/\\____/_/ /_/`,
  ];

  console.log('');
  logoLines.forEach(line => console.log(bx(line)));
  console.log('');
  console.log(`  ${faint('v' + version)}${collab ? `  ${muted('·')}  ${muted('collab')}` : ''}`);
  console.log('');
  console.log(`  ${faint('─────────────────────────────────────')}`);
  console.log('');
  console.log(`  ${muted('Target')}   ${target}`);
  console.log(`  ${muted('Local')}    ${link(`http://localhost:${port}`)}`);

  if (collab) {
    const lanIP = getLanIP();
    const shareUrl = `http://${lanIP}:${port}/join?code=${inviteCode}`;
    console.log('');
    console.log(`  ${muted('Code')}     ${code(inviteCode)}`);
    console.log(`  ${muted('Share')}    ${share(shareUrl)}`);
    console.log('');
    console.log(`  ${faint('Share the link above with your team.')}`);
  }

  console.log('');
  console.log(`  ${faint('Ctrl+C to stop')}`);
  console.log('');

  if (shouldOpen) {
    const hostUrl = collab
      ? `http://localhost:${port}/?hostToken=${hostToken}`
      : `http://localhost:${port}`;
    open(hostUrl);
  }
});
