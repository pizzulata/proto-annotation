#!/usr/bin/env node

/**
 * proto-annotation CLI
 *
 * Usage:
 *   npx proto-annotation                                  → demo mode (built-in test page)
 *   npx proto-annotation http://localhost:3000             → proxy that URL in the review UI
 *   npx proto-annotation --port 4747                      → custom server port
 *   npx proto-annotation --no-open                        → don't auto-open browser
 *   npx proto-annotation --demo                           → explicitly use built-in demo page
 *   npx proto-annotation --collab                         → enable collaborative review session (LAN only)
 *   npx proto-annotation --collab --tunnel                → collab with public URL (works outside your network)
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
let tunnel = false;
let anthropicKey = null;
let srcDir = null;

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
  } else if (args[i] === '--tunnel') {
    tunnel = true;
    collab = true; // tunnel implies collab
  } else if (args[i] === '--anthropic-key' && args[i + 1]) {
    anthropicKey = args[i + 1];
    i++;
  } else if (args[i] === '--src' && args[i + 1]) {
    srcDir = resolve(args[i + 1]);
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

// Source directory for Fix with AI (default: CWD, not used in demo mode)
if (!srcDir && !demo) srcDir = process.cwd();

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
const warn  = (s) => c(214, s);  // orange — warnings

// Read version from package.json
let version = '';
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  version = pkg.version;
} catch {}

const { server, inviteCode, hostToken } = createServer({ port, targetUrl, demo, collab, dataPath, srcDir });

async function start() {
  // Start the server
  await new Promise((resolve) => server.listen(port, resolve));

  // Start tunnel if requested
  let shareUrl = null;
  let tunnelInstance = null;

  if (collab && tunnel) {
    process.stdout.write(`  ${muted('Tunnel')}   ${faint('starting...')}\r`);
    try {
      const lt = await import('localtunnel');
      tunnelInstance = await lt.default({ port });
      shareUrl = `${tunnelInstance.url}/join?code=${inviteCode}`;

      tunnelInstance.on('error', (err) => {
        console.error(`\n  ${warn('Tunnel error:')} ${err.message}`);
      });
      tunnelInstance.on('close', () => {
        // tunnel closed silently
      });
    } catch (err) {
      console.error(`  ${warn('Tunnel failed:')} ${err.message} — falling back to LAN IP`);
      tunnel = false;
    }
  }

  if (collab && !tunnel) {
    const lanIP = getLanIP();
    shareUrl = `http://${lanIP}:${port}/join?code=${inviteCode}`;
  }

  // ── Print startup banner ──
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

  const badges = [faint('v' + version)];
  if (collab) badges.push(muted('·'), muted('collab'));
  if (tunnel) badges.push(muted('·'), muted('tunnel'));
  console.log(`  ${badges.join('  ')}`);
  console.log('');
  console.log(`  ${faint('─────────────────────────────────────')}`);
  console.log('');
  console.log(`  ${muted('Target')}   ${target}`);
  console.log(`  ${muted('Local')}    ${link(`http://localhost:${port}`)}`);

  if (collab) {
    console.log('');
    console.log(`  ${muted('Code')}     ${code(inviteCode)}`);
    console.log(`  ${muted('Share')}    ${share(shareUrl)}`);
    console.log('');
    if (tunnel) {
      console.log(`  ${faint('Works anywhere — not just your WiFi.')}`);
    } else {
      console.log(`  ${faint('Share the link above with teammates on the same WiFi.')}`);
      console.log(`  ${faint('Add --tunnel to share outside your network.')}`);
    }
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

  // Clean up tunnel on exit
  process.on('SIGINT', () => {
    if (tunnelInstance) tunnelInstance.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    if (tunnelInstance) tunnelInstance.close();
    process.exit(0);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
