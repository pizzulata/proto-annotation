/**
 * Canva Annotate server
 *
 * Serves:
 *   GET  /                         → Review UI (injects prototype in iframe)
 *   GET  /inject.js                → Script injected into iframe for DOM inspection
 *   GET  /api/annotations          → List all annotations (with filters)
 *   POST /api/annotations          → Create annotation
 *   PATCH /api/annotations/:id     → Update annotation (status, type, note)
 *   DELETE /api/annotations/:id    → Delete annotation
 *   DELETE /api/annotations        → Clear all annotations
 *   GET  /api/stats                → Review stats
 *   GET  /api/prompt               → Generate agent prompt
 *   WS   /ws                       → WebSocket for live annotation sync
 */

import express from 'express';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer } from 'ws';
import { createStore } from '../lib/store.mjs';

export function createServer({ port, targetUrl, demo, collab }) {
  const app = express();
  const server = createHttpServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const store = createStore();

  let inviteCode = null;
  let hostToken = null;
  if (collab) {
    const collabInfo = store.initCollab();
    inviteCode = collabInfo.inviteCode;
    hostToken = collabInfo.hostToken;
  }

  app.use(express.json());

  // ── Collab auth middleware ──
  function collabAuth(req, res, next) {
    if (!collab) return next();
    const token = req.headers['x-collab-token'];
    const participant = store.getParticipant(token);
    if (!participant) return res.status(401).json({ error: 'Unauthorized' });
    req.participant = participant;
    next();
  }

  // ── Serve the review UI ──
  app.get('/', (req, res) => {
    res.send(buildReviewUI(targetUrl || 'demo', port, demo, collab));
  });

  // ── Collab: join page ──
  app.get('/join', (req, res) => {
    res.send(buildJoinPage());
  });

  // ── Collab: join session ──
  app.post('/api/collab/join', (req, res) => {
    const { code, name } = req.body;
    const result = store.joinSession(code, name);
    if (!result) return res.status(401).json({ error: 'Invalid invite code' });
    res.json({ token: result.token, participant: result.participant });
  });

  // ── Collab: get participants ──
  app.get('/api/collab/participants', collabAuth, (req, res) => {
    res.json(store.getParticipants());
  });

  // ── Collab: get current participant ──
  app.get('/api/collab/me', collabAuth, (req, res) => {
    res.json(req.participant);
  });

  // ── Serve the injection script (runs inside the iframe) ──
  app.get('/inject.js', (req, res) => {
    res.type('application/javascript');
    res.send(buildInjectScript(port));
  });

  // ── Demo page: built-in test UI with the inject script already included ──
  app.get('/demo', (req, res) => {
    res.type('text/html').send(buildDemoPage());
  });

  // ── Proxy: serve the target app through our server so iframe is same-origin ──
  // This lets us inject the annotation script into the page
  app.get('/proxy/*', async (req, res) => {
    try {
      const targetPath = req.params[0] || '';
      const url = new URL(targetPath, targetUrl).href;
      const response = await fetch(url, {
        headers: {
          'Accept': req.headers.accept || '*/*',
          'Accept-Encoding': 'identity',
        },
      });

      const contentType = response.headers.get('content-type') || '';

      // For HTML responses, inject our annotation script before </head>
      if (contentType.includes('text/html')) {
        let html = await response.text();
        const injectTag = '<script src="/inject.js"></' + 'script>';

        if (html.includes('</head>')) {
          html = html.replace('</head>', injectTag + '</head>');
        } else if (html.includes('</body>')) {
          html = html.replace('</body>', injectTag + '</body>');
        } else {
          html += injectTag;
        }

        // Rewrite asset URLs to go through proxy
        // Handle relative paths that would otherwise break
        const baseTag = `<base href="/proxy/">`;
        if (html.includes('<head>')) {
          html = html.replace('<head>', '<head>' + baseTag);
        } else if (html.includes('<head ')) {
          html = html.replace(/<head\s[^>]*>/, (match) => match + baseTag);
        } else {
          html = baseTag + html;
        }

        res.type('text/html').send(html);
      } else {
        // For non-HTML (CSS, JS, images, etc.), pipe through directly
        res.set('Content-Type', contentType);
        const buffer = Buffer.from(await response.arrayBuffer());
        res.send(buffer);
      }
    } catch (err) {
      res.status(502).send(`Proxy error: ${err.message}`);
    }
  });

  // ── API: Annotations ──
  app.get('/api/annotations', (req, res) => {
    const { session, status, type } = req.query;
    const annotations = store.getAnnotations({ session, status, type });
    res.json(annotations);
  });

  app.post('/api/annotations', collabAuth, (req, res) => {
    const data = req.body;
    if (collab && req.participant) {
      data.author = { id: req.participant.id, name: req.participant.name, color: req.participant.color };
    }
    const annotation = store.createAnnotation(data);
    broadcast({ type: 'annotation.created', payload: annotation });
    res.status(201).json(annotation);
  });

  app.patch('/api/annotations/:id', collabAuth, (req, res) => {
    if (collab && req.participant) {
      const existing = store.getAnnotations({}).find(a => a.id === req.params.id);
      if (existing && req.body.comment !== undefined && existing.author?.id !== req.participant.id) {
        return res.status(403).json({ error: 'Only the author can edit the comment' });
      }
    }
    const updated = store.updateAnnotation(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    broadcast({ type: 'annotation.updated', payload: updated });
    res.json(updated);
  });

  app.delete('/api/annotations/:id', collabAuth, (req, res) => {
    if (collab && req.participant) {
      const token = req.headers['x-collab-token'];
      const annotation = store.getAnnotations({}).find(a => a.id === req.params.id);
      if (annotation && annotation.author?.id !== req.participant.id && !store.isHost(token)) {
        return res.status(403).json({ error: 'Only the author or host can delete' });
      }
    }
    const deleted = store.deleteAnnotation(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    broadcast({ type: 'annotation.deleted', payload: { id: req.params.id } });
    res.json({ ok: true });
  });

  app.delete('/api/annotations', collabAuth, (req, res) => {
    store.clearAll();
    broadcast({ type: 'annotations.cleared' });
    res.json({ ok: true });
  });

  // ── API: Stats ──
  app.get('/api/stats', (req, res) => {
    res.json(store.getStats());
  });

  // ── API: Generate agent prompt ──
  app.get('/api/prompt', (req, res) => {
    const { session } = req.query;
    const annotations = store.getAnnotations({ session, status: 'pending' });
    const prompt = buildAgentPrompt(annotations, targetUrl);
    res.type('text/plain').send(prompt);
  });

  // ── API: Generate prompt for a single annotation ──
  app.get('/api/prompt/:id', (req, res) => {
    const all = store.getAnnotations({});
    const annotation = all.find(a => a.id === req.params.id);
    if (!annotation) return res.status(404).json({ error: 'Not found' });
    const prompt = buildAgentPrompt([annotation], targetUrl);
    res.type('text/plain').send(prompt);
  });

  // ── WebSocket broadcast ──
  function broadcast(message, excludeWs) {
    const data = JSON.stringify(message);
    wss.clients.forEach(client => {
      if (client.readyState === 1 && client !== excludeWs) client.send(data);
    });
  }

  wss.on('connection', (ws, req) => {
    const wsUrl = new URL(req.url, 'http://x');
    const token = wsUrl.searchParams.get('token');

    if (collab) {
      const participant = store.getParticipant(token);
      if (!participant) {
        ws.close(4001, 'Unauthorized');
        return;
      }
      ws.participantToken = token;
      ws.participant = participant;

      // Notify others
      broadcast({ type: 'participant.joined', payload: participant }, ws);

      // On close
      ws.on('close', () => {
        broadcast({ type: 'participant.left', payload: { id: participant.id } });
      });
    }

    ws.send(JSON.stringify({
      type: 'sync',
      payload: {
        annotations: store.getAnnotations({}),
        stats: store.getStats(),
        ...(collab ? { participants: store.getParticipants() } : {}),
      }
    }));

    // Handle incoming messages
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'presence.selecting' && collab && ws.participant) {
          broadcast({
            type: 'presence.selecting',
            payload: {
              participantId: ws.participant.id,
              name: ws.participant.name,
              color: ws.participant.color,
              ...msg.payload,
            }
          }, ws);
        }
      } catch (e) {}
    });
  });

  return { server, inviteCode: inviteCode || null, hostToken: hostToken || null };
}


// ═══════════════════════════════════════════════════════════════
// AGENT PROMPT BUILDER — smart context from the HTML prototype
// ═══════════════════════════════════════════════════════════════

// ── Label-to-focus mapping: tells the LLM what aspect to pay attention to ──
const LABEL_FOCUS = {
  spacing: 'padding, margin, gap, dimensions',
  branding: 'colors, fonts, brand consistency',
  typography: 'font-size, font-weight, line-height, font-family',
  color: 'color, background-color, border-color, opacity',
  layout: 'display, flex, grid, positioning, alignment',
  accessibility: 'aria attributes, contrast, focus states, semantic HTML',
  animation: 'transitions, transforms, keyframes',
  responsive: 'breakpoints, media queries, fluid sizing',
  interaction: 'hover states, click handlers, cursor, focus',
  content: 'text content, copy, labels, placeholder text',
};

// ── Infer what metadata is relevant based on feedback text + labels ──
function inferRelevantStyles(comment, labels, styles, box) {
  if (!styles) return '';
  const text = (comment || '').toLowerCase();
  const allLabels = (labels || []).map(l => l.toLowerCase());
  const parts = [];

  const isSizing = /big|small|large|tight|cramp|wide|narrow|tall|short|size|padding|margin|spacing|gap|height|width|grow|shrink|overflow|truncat|cut.?off/i.test(text)
    || allLabels.some(l => ['spacing', 'layout', 'responsive'].includes(l));
  const isAppearance = /color|theme|dark|light|bright|contrast|brand|opacity|shadow|border|round|background|bg/i.test(text)
    || allLabels.some(l => ['branding', 'color'].includes(l));
  const isTypography = /font|text|bold|weight|size|letter|line.?height|read|typo/i.test(text)
    || allLabels.some(l => ['typography', 'content'].includes(l));

  // Sizing context
  if (isSizing || (!isAppearance && !isTypography)) {
    if (box) parts.push(`${box.width || box.w || 0}×${box.height || box.h || 0}px`);
    if (styles.padding && styles.padding !== '0px') parts.push(`padding: ${styles.padding}`);
    if (styles.margin && styles.margin !== '0px') parts.push(`margin: ${styles.margin}`);
    if (styles.gap && styles.gap !== 'normal') parts.push(`gap: ${styles.gap}`);
  }

  // Appearance context
  if (isAppearance) {
    if (styles.color) parts.push(`color: ${styles.color}`);
    if (styles.bg && styles.bg !== 'rgba(0, 0, 0, 0)') parts.push(`bg: ${styles.bg}`);
    if (styles.borderRadius && styles.borderRadius !== '0px') parts.push(`radius: ${styles.borderRadius}`);
    if (styles.border && !styles.border.startsWith('0px')) parts.push(`border: ${styles.border}`);
    if (styles.opacity && styles.opacity !== '1') parts.push(`opacity: ${styles.opacity}`);
  }

  // Typography context
  if (isTypography) {
    if (styles.fontSize) parts.push(`font-size: ${styles.fontSize}`);
    if (styles.fontWeight) parts.push(`font-weight: ${styles.fontWeight}`);
    if (styles.lineHeight && styles.lineHeight !== 'normal') parts.push(`line-height: ${styles.lineHeight}`);
  }

  // Fallback: if nothing matched, include the basics
  if (parts.length === 0) {
    if (box) parts.push(`${box.width || box.w || 0}×${box.height || box.h || 0}px`);
    if (styles.fontSize) parts.push(`font-size: ${styles.fontSize}`);
    if (styles.padding && styles.padding !== '0px') parts.push(`padding: ${styles.padding}`);
  }

  return parts.join(' | ');
}

function formatParentCompact(p) {
  if (!p) return '';
  let s = `${p.tag}`;
  if (p.classes) s += `.${p.classes.split(' ')[0]}`;
  if (p.display === 'flex' || p.display === 'inline-flex') {
    s += ` (flex ${p.flexDirection || 'row'}`;
    if (p.gap && p.gap !== 'normal') s += `, gap: ${p.gap}`;
    s += ')';
  } else if (p.display === 'grid' || p.display === 'inline-grid') {
    s += ` (grid`;
    if (p.gap && p.gap !== 'normal') s += `, gap: ${p.gap}`;
    s += ')';
  }
  return s;
}

function buildAgentPrompt(annotations, pageUrl) {
  const n = annotations.length;
  if (n === 0) return 'No pending annotations.';

  const bugs = annotations.filter(a => a.type === 'bug').length;
  const questions = annotations.filter(a => a.type === 'question').length;
  const changes = n - bugs - questions;

  // ── System prompt: concise ──
  let prompt = `# Design Review — ${pageUrl || 'prototype'}\n\n`;
  prompt += `A designer reviewed this prototype and annotated ${n} element${n !== 1 ? 's' : ''}. `;
  prompt += `For each: find the element in the codebase, make the change, state the file and what you did.\n\n`;

  // ── Sort: bugs first, then changes, then questions ──
  const sorted = [...annotations].sort((a, b) => {
    const order = { bug: 0, feedback: 1, question: 2 };
    return (order[a.type] ?? 1) - (order[b.type] ?? 1);
  });

  // ── Classify intent ──
  function classifyIntent(a) {
    if (a.type === 'bug') return 'FIX';
    if (a.type === 'question') return 'QUESTION';
    const note = (a.comment || '').toLowerCase();
    if (/^(this is great|looks good|love this|nice|perfect|awesome|well done|👍|✅)/i.test(note)) return 'NOTE';
    return 'CHANGE';
  }

  // ── Each annotation ──
  sorted.forEach((a, i) => {
    const intent = classifyIntent(a);
    const num = i + 1;
    const searchTarget = a.cssClasses
      ? a.cssClasses.split(' ')[0]
      : (a.selector || '').replace(/^[a-z]+\./, '').split('.')[0];

    prompt += `---\n\n`;
    prompt += `## ${num}. ${intent}: ${a.comment}\n`;
    prompt += `**Element**: \`${a.selector || a.element || 'unknown'}\` (search for \`${searchTarget}\`)\n`;

    if (a.elementPath) {
      prompt += `**Path**: \`${a.elementPath}\`\n`;
    }

    // Labels with focus hints
    const labels = a.labels || [];
    if (labels.length) {
      const focusHints = labels
        .map(l => LABEL_FOCUS[l.toLowerCase()])
        .filter(Boolean);
      prompt += `**Labels**: ${labels.join(', ')}`;
      if (focusHints.length) prompt += ` → Focus: ${focusHints.join(', ')}`;
      prompt += `\n`;
    }

    // Contextual baseline — only include what's relevant
    if (intent !== 'QUESTION' && intent !== 'NOTE') {
      const baseline = inferRelevantStyles(a.comment, labels, a.computedStyles, a.boundingBox);
      if (baseline) {
        prompt += `**Baseline**: ${baseline}\n`;
      }

      const parent = formatParentCompact(a.parentInfo);
      if (parent) {
        prompt += `**Parent**: ${parent}\n`;
      }
    }

    // Visible text — only when relevant
    if (a.nearbyText && /text|copy|word|label|title|content|say|read|message/i.test(a.comment || '')) {
      prompt += `**Text**: "${a.nearbyText.slice(0, 60)}"\n`;
    }

    prompt += `\n`;
  });

  prompt += `---\n`;
  return prompt;
}


// ═══════════════════════════════════════════════════════════════
// REVIEW UI HTML — the main page the designer sees
// ═══════════════════════════════════════════════════════════════

function buildReviewUI(targetUrl, port, demo, collab) {
  const iframeSrc = demo ? '/demo' : '/proxy/';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>proto-annotation — ${escHtml(targetUrl)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=DM+Sans:wght@300;400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0b0d; --surface: #111318; --surface2: #181b22; --surface3: #1f222b;
    --border: #262a35; --border-hover: #363b4a;
    --text: #e4e7ef; --text-secondary: #9da3b3; --muted: #5c6273;
    --accent: #636bff; --accent-soft: rgba(99,107,255,0.12); --accent-medium: rgba(99,107,255,0.25);
    --green: #2dd4a0; --green-soft: rgba(45,212,160,0.12);
    --amber: #fbbf24; --amber-soft: rgba(251,191,36,0.12);
    --red: #f87171; --red-soft: rgba(248,113,113,0.12);
    --pin: #fbbf24; --pin-glow: rgba(251,191,36,0.4);
    --font-mono: 'JetBrains Mono', monospace;
    --font-sans: 'DM Sans', -apple-system, sans-serif;
    --shadow-lg: 0 24px 64px rgba(0,0,0,0.5), 0 8px 20px rgba(0,0,0,0.3);
    --shadow-xl: 0 32px 80px rgba(0,0,0,0.6), 0 12px 28px rgba(0,0,0,0.4);
    --transition: 0.15s cubic-bezier(0.4, 0, 0.2, 1);
    --panel-width: 380px;
  }
  body { font-family: var(--font-sans); background: var(--bg); color: var(--text); height: 100vh; overflow: hidden; }

  /* ── Full-screen iframe ── */
  #prototypeFrame { position: fixed; inset: 0; width: 100%; height: 100%; border: none; z-index: 1; }

  /* ── Floating toolbar (top-right) ── */
  .toolbar {
    position: fixed; top: 12px; right: 12px; z-index: 1000;
    display: flex; align-items: center; gap: 5px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 5px 6px;
    box-shadow: var(--shadow-lg);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .toolbar.panel-open { right: calc(var(--panel-width) + 20px); }

  .toolbar .logo { font-family: var(--font-mono); font-size: 13px; font-weight: 600; padding: 0 8px; user-select: none; color: var(--text); }
  .toolbar .logo span { color: var(--accent); }
  .toolbar .sep { width: 1px; height: 20px; background: var(--border); margin: 0 2px; }

  .tb-btn { display: flex; align-items: center; gap: 5px; padding: 6px 10px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: var(--muted); font-family: var(--font-mono); font-size: 11px; font-weight: 500; cursor: pointer; transition: all var(--transition); white-space: nowrap; }
  .tb-btn:hover:not(:disabled) { background: var(--surface2); color: var(--text-secondary); }
  .tb-btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .tb-btn.primary { background: var(--green-soft); color: var(--green); }
  .tb-btn.primary:hover:not(:disabled) { opacity: 0.85; }
  .tb-btn.danger:hover:not(:disabled) { color: var(--red); }

  .annotate-btn { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: var(--text-secondary); font-family: var(--font-mono); font-size: 11px; font-weight: 500; cursor: pointer; transition: all var(--transition); }
  .annotate-btn:hover { background: var(--accent-soft); }
  .annotate-btn.active { background: var(--accent-soft); color: var(--accent); }
  .annotate-btn .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .annotate-btn.active .dot { box-shadow: 0 0 8px currentColor; animation: breathe 2s ease-in-out infinite; }
  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .badge-count { font-family: var(--font-mono); font-size: 9px; background: var(--accent); color: #fff; min-width: 16px; height: 16px; border-radius: 8px; display: flex; align-items: center; justify-content: center; padding: 0 4px; font-weight: 700; }
  .badge-count.hidden { display: none; }

  .panel-toggle { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: var(--muted); cursor: pointer; transition: all var(--transition); font-size: 16px; }
  .panel-toggle:hover { background: var(--surface2); color: var(--text-secondary); }
  .panel-toggle.active { background: var(--accent-soft); color: var(--accent); }

  /* ── Floating side panel ── */
  .panel {
    position: fixed; top: 0; right: 0; z-index: 900;
    width: var(--panel-width); height: 100vh;
    background: var(--surface);
    border-left: 1px solid var(--border);
    box-shadow: var(--shadow-xl);
    display: flex; flex-direction: column;
    transform: translateX(100%);
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .panel.open { transform: translateX(0); }

  .panel-header { padding: 14px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .panel-title { font-size: 13px; font-weight: 600; color: var(--text); }
  .panel-close { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 18px; padding: 2px 6px; border-radius: 4px; transition: all var(--transition); }
  .panel-close:hover { background: var(--surface2); color: var(--text-secondary); }

  /* Panel tabs */
  .panel-tabs { display: flex; border-bottom: 1px solid var(--border); padding: 0 16px; gap: 4px; }
  .panel-tab { padding: 10px 8px; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.8px; cursor: pointer; transition: all var(--transition); border-bottom: 2px solid transparent; }
  .panel-tab:hover { color: var(--text-secondary); }
  .panel-tab.active { color: var(--text); border-bottom-color: var(--accent); }

  .panel-content { flex: 1; overflow-y: auto; }

  .panel-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 28px; text-align: center; color: var(--muted); gap: 12px; height: 100%; }
  .panel-empty-icon { font-size: 36px; opacity: 0.12; }
  .panel-empty-text { font-size: 13px; line-height: 1.6; }
  .panel-empty-hint { font-size: 11px; color: var(--muted); background: var(--surface2); padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); margin-top: 4px; }
  .panel-empty-hint .kbd { font-family: var(--font-mono); font-size: 10px; background: var(--surface3); padding: 1px 5px; border-radius: 3px; border: 1px solid var(--border); }

  .annotation-list { padding: 10px; }
  .a-card { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-bottom: 8px; cursor: pointer; transition: all var(--transition); }
  .a-card:hover { border-color: var(--border-hover); transform: translateY(-1px); }
  .a-card.highlighted { border-color: var(--pin); }
  .a-card-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
  .a-pin { width: 22px; height: 22px; border-radius: 50%; background: var(--pin); color: #000; font-size: 10px; font-weight: 700; font-family: var(--font-mono); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .a-selector { font-family: var(--font-mono); font-size: 10px; color: var(--accent); flex: 1; word-break: break-all; line-height: 1.5; }
  .a-actions { display: flex; gap: 2px; }
  .a-copy { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 11px; padding: 3px 6px; line-height: 1; border-radius: 4px; transition: all var(--transition); font-family: var(--font-mono); }
  .a-copy:hover { color: var(--green); background: var(--green-soft); }
  .a-copy.copied { color: var(--green); }
  .a-delete { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; padding: 2px; line-height: 1; border-radius: 4px; transition: all var(--transition); }
  .a-delete:hover { color: var(--red); background: var(--red-soft); }
  .a-type-wrap { position: relative; display: inline-block; margin-bottom: 6px; }
  .a-type { font-size: 9px; font-weight: 600; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; font-family: var(--font-mono); display: inline-flex; align-items: center; gap: 4px; cursor: pointer; transition: all var(--transition); border: 1px solid transparent; }
  .a-type:hover { border-color: var(--border-hover); }
  .a-type .a-type-arrow { font-size: 7px; opacity: 0.6; }
  .a-type.feedback { background: var(--accent-soft); color: var(--accent); }
  .a-type.bug { background: var(--red-soft); color: var(--red); }
  .a-type.question { background: var(--amber-soft); color: var(--amber); }
  .a-type-dropdown { position: absolute; top: 100%; left: 0; margin-top: 4px; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 4px; min-width: 120px; z-index: 1000; box-shadow: 0 12px 32px rgba(0,0,0,0.4); display: none; }
  .a-type-dropdown.open { display: block; }
  .a-type-option { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 5px; font-size: 10px; font-family: var(--font-mono); font-weight: 500; cursor: pointer; color: var(--text-secondary); transition: background var(--transition); }
  .a-type-option:hover { background: var(--surface3); }
  .a-type-option .a-type-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .a-type-option .a-type-dot.feedback { background: var(--accent); }
  .a-type-option .a-type-dot.bug { background: var(--red); }
  .a-type-option .a-type-dot.question { background: var(--amber); }

  /* ── Label chips ── */
  .a-labels-row { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; margin-bottom: 6px; }
  .a-label { font-size: 9px; font-weight: 500; padding: 2px 6px; border-radius: 4px; font-family: var(--font-mono); background: var(--surface3); color: var(--text-secondary); border: 1px solid var(--border); display: inline-flex; align-items: center; gap: 4px; }
  .a-label-x { cursor: pointer; opacity: 0.5; font-size: 10px; line-height: 1; }
  .a-label-x:hover { opacity: 1; color: var(--red); }
  .a-label-add { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px; cursor: pointer; border: 1px dashed var(--border); background: transparent; color: var(--muted); font-family: var(--font-mono); transition: all var(--transition); }
  .a-label-add:hover { border-color: var(--border-hover); color: var(--text-secondary); }
  .a-label-input { font-size: 9px; padding: 2px 6px; border-radius: 4px; border: 1px solid var(--accent); background: var(--bg); color: var(--text); font-family: var(--font-mono); outline: none; width: 70px; }
  .a-label-input::placeholder { color: var(--muted); }
  .a-note { font-size: 13px; color: var(--text); line-height: 1.55; }
  .a-meta { font-size: 10px; color: var(--muted); font-family: var(--font-mono); margin-top: 8px; display: flex; justify-content: space-between; }

  /* ── History tab ── */
  .history-item { padding: 10px 16px; border-bottom: 1px solid var(--border); font-size: 12px; }
  .history-item .time { font-family: var(--font-mono); font-size: 10px; color: var(--muted); }
  .history-item .action { color: var(--text-secondary); margin-top: 2px; }

  /* ── Stats bar at panel bottom ── */
  .stats-bar { display: flex; gap: 4px; padding: 12px 16px; border-top: 1px solid var(--border); background: var(--surface); }
  .stat-pill { flex: 1; text-align: center; padding: 8px 4px; border-radius: 8px; background: var(--surface2); }
  .stat-pill .num { font-family: var(--font-mono); font-size: 18px; font-weight: 700; }
  .stat-pill .label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }

  /* ── Panel action bar ── */
  .panel-actions { display: flex; gap: 6px; padding: 12px 16px; border-top: 1px solid var(--border); }
  .panel-actions .tb-btn { flex: 1; justify-content: center; padding: 8px; border: 1px solid var(--border); border-radius: 7px; }

  /* ── Toast ── */
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(16px); background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 18px; font-size: 12px; font-family: var(--font-mono); color: var(--text); z-index: 99999; opacity: 0; transition: all 0.2s; pointer-events: none; box-shadow: var(--shadow-lg); }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  /* ── Collab participant dots ── */
  .collab-dots { display: flex; gap: -4px; align-items: center; margin-left: 4px; }
  .collab-dot { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #fff; border: 2px solid var(--surface); margin-left: -6px; cursor: default; position: relative; }
  .collab-dot:first-child { margin-left: 0; }
  .collab-dot .collab-tooltip { position: absolute; bottom: -24px; left: 50%; transform: translateX(-50%); font-size: 9px; background: var(--surface2); padding: 2px 6px; border-radius: 4px; white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity 0.15s; border: 1px solid var(--border); }
  .collab-dot:hover .collab-tooltip { opacity: 1; }
</style>
</head>
<body>

<!-- Full-screen prototype -->
<iframe id="prototypeFrame" src="${iframeSrc}"></iframe>

<!-- Floating toolbar -->
<div class="toolbar" id="toolbar">
  <div class="logo">proto<span>.</span></div>
  <div class="collab-dots" id="collabDots"></div>
  <div class="sep"></div>
  <button class="annotate-btn" id="annotateBtn" onclick="toggleAnnotate()">
    <div class="dot"></div>
    <span id="annotateLabel">Annotate</span>
  </button>
  <div class="badge-count hidden" id="annotationCount">0</div>
  <div class="sep"></div>
  <button class="tb-btn primary" id="copyBtn" disabled onclick="copyPrompt()">Copy Prompt</button>
  <button class="tb-btn" id="jsonBtn" disabled onclick="copyJSON()">JSON</button>
  <button class="tb-btn danger" id="clearBtn" disabled onclick="clearAll()">Clear</button>
  <div class="sep"></div>
  <button class="panel-toggle" id="panelToggle" onclick="togglePanel()">☰</button>
</div>

<!-- Floating side panel -->
<div class="panel" id="panel">
  <div class="panel-header">
    <div class="panel-title">Annotations</div>
    <button class="panel-close" onclick="togglePanel()">&times;</button>
  </div>

  <div class="panel-tabs">
    <div class="panel-tab active" data-tab="annotations" onclick="switchTab('annotations')">Annotations</div>
    <div class="panel-tab" data-tab="history" onclick="switchTab('history')">History</div>
  </div>

  <div class="panel-content" id="panelContent">
    <div class="panel-empty" id="emptyState">
      <div class="panel-empty-icon">◎</div>
      <div class="panel-empty-text">
        Click <strong>Annotate</strong> to start reviewing.<br>
        Annotations become agent prompts.
      </div>
      <div class="panel-empty-hint">Press <span class="kbd">A</span> to toggle · <span class="kbd">P</span> panel</div>
    </div>
    <div class="annotation-list" id="annotationList" style="display:none"></div>
    <div id="historyContent" style="display:none"></div>
  </div>

  <div class="stats-bar">
    <div class="stat-pill">
      <div class="num" id="statPending">0</div>
      <div class="label">Pending</div>
    </div>
    <div class="stat-pill">
      <div class="num" id="statFixed" style="color:var(--green)">0</div>
      <div class="label">Fixed</div>
    </div>
    <div class="stat-pill">
      <div class="num" id="statTotal">0</div>
      <div class="label">Total</div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
  // ═══ STATE ═══
  let annotating = false;
  let panelOpen = false;
  let annotations = [];
  let history = [];
  let activeTab = 'annotations';

  let myToken = null;
  let myParticipant = null;
  let participants = [];
  const isCollab = ${collab ? 'true' : 'false'};

  const prototypeFrame = document.getElementById('prototypeFrame');

  // ═══ COLLAB IDENTITY ═══
  if (isCollab) {
    const urlParams = new URLSearchParams(window.location.search);
    const hostTokenParam = urlParams.get('hostToken');
    if (hostTokenParam) {
      localStorage.setItem('proto-collab-token', hostTokenParam);
      // Clean URL
      window.history.replaceState({}, '', '/');
    }
    myToken = localStorage.getItem('proto-collab-token');
    if (!myToken) {
      window.location.href = '/join';
    } else {
      // Verify token
      fetch('/api/collab/me', { headers: { 'x-collab-token': myToken } })
        .then(r => { if (!r.ok) throw new Error('bad token'); return r.json(); })
        .then(p => { myParticipant = p; })
        .catch(() => { localStorage.removeItem('proto-collab-token'); window.location.href = '/join'; });
    }
  }

  function authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (myToken) h['x-collab-token'] = myToken;
    return h;
  }

  // ═══ IFRAME INJECTION ═══
  prototypeFrame.addEventListener('load', () => {
    try {
      const doc = prototypeFrame.contentDocument || prototypeFrame.contentWindow.document;
      const script = doc.createElement('script');
      script.src = '/inject.js';
      doc.head.appendChild(script);
    } catch (e) {
      console.warn('anno: cross-origin iframe, inject.js must be loaded by the target app or via proxy');
    }
  });

  // ═══ WEBSOCKET — live sync with server ═══
  let ws;
  function connectWS() {
    ws = new WebSocket(\`ws://\${location.host}/ws\${myToken ? '?token=' + encodeURIComponent(myToken) : ''}\`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'sync') {
        annotations = msg.payload.annotations;
        renderAnnotations();
        updateStats(msg.payload.stats);
      } else if (msg.type === 'annotation.created') {
        if (!annotations.find(a => a.id === msg.payload.id)) {
          annotations.push(msg.payload);
        }
        renderAnnotations();
        logHistory('added', msg.payload);
        // Auto-open panel on first annotation
        if (annotations.length === 1 && !panelOpen) togglePanel();
      } else if (msg.type === 'annotation.updated') {
        const idx = annotations.findIndex(a => a.id === msg.payload.id);
        if (idx >= 0) annotations[idx] = msg.payload;
        renderAnnotations();
        logHistory('updated', msg.payload);
      } else if (msg.type === 'annotation.deleted') {
        annotations = annotations.filter(a => a.id !== msg.payload.id);
        renderAnnotations();
      } else if (msg.type === 'annotations.cleared') {
        annotations = [];
        renderAnnotations();
      } else if (msg.type === 'participant.joined') {
        if (!participants.find(p => p.id === msg.payload.id)) {
          participants.push(msg.payload);
        }
        renderParticipants();
        showToast(esc(msg.payload.name) + ' joined');
      } else if (msg.type === 'participant.left') {
        participants = participants.filter(p => p.id !== msg.payload.id);
        renderParticipants();
      } else if (msg.type === 'presence.selecting') {
        try {
          prototypeFrame.contentWindow.postMessage({
            source: 'anno-agent-parent',
            type: 'presence-hover',
            payload: msg.payload
          }, '*');
        } catch(err) {}
      }
      if (msg.type === 'sync' && msg.payload.participants) {
        participants = msg.payload.participants;
        renderParticipants();
      }
      updateButtons();
      updateStats();
    };
    ws.onclose = () => setTimeout(connectWS, 2000);
  }
  connectWS();

  // ═══ COMMUNICATION WITH IFRAME ═══
  window.addEventListener('message', (e) => {
    if (e.data?.source !== 'anno-agent-inject') return;
    if (e.data.type === 'element-clicked') {
      fetch('/api/annotations', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(e.data.payload)
      });
    }
    if (e.data.type === 'presence-hover' && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'presence.selecting',
        payload: e.data.payload
      }));
    }
  });

  // ═══ PANEL ═══
  function togglePanel() {
    panelOpen = !panelOpen;
    document.getElementById('panel').classList.toggle('open', panelOpen);
    document.getElementById('toolbar').classList.toggle('panel-open', panelOpen);
    document.getElementById('panelToggle').classList.toggle('active', panelOpen);
  }

  function toggleAnnotate() {
    annotating = !annotating;
    const btn = document.getElementById('annotateBtn');
    const label = document.getElementById('annotateLabel');
    btn.classList.toggle('active', annotating);
    label.textContent = annotating ? 'Annotating' : 'Annotate';

    try {
      prototypeFrame.contentWindow.postMessage({
        source: 'anno-agent-parent',
        type: annotating ? 'start-annotating' : 'stop-annotating'
      }, '*');
    } catch (e) {}

    if (annotating) showToast('Click any element to annotate · Esc to stop');
  }

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.getElementById('annotationList').style.display = tab === 'annotations' && annotations.length ? 'block' : 'none';
    document.getElementById('emptyState').style.display = tab === 'annotations' && !annotations.length ? 'flex' : 'none';
    document.getElementById('historyContent').style.display = tab === 'history' ? 'block' : 'none';
  }

  function renderAnnotations() {
    const list = document.getElementById('annotationList');
    const empty = document.getElementById('emptyState');
    const countEl = document.getElementById('annotationCount');

    countEl.textContent = annotations.length;
    countEl.classList.toggle('hidden', annotations.length === 0);

    if (annotations.length === 0) {
      list.style.display = 'none';
      if (activeTab === 'annotations') empty.style.display = 'flex';
      return;
    }

    empty.style.display = 'none';
    if (activeTab === 'annotations') list.style.display = 'block';

    list.innerHTML = annotations.map((a, i) => \`
      <div class="a-card" onclick="focusAnnotation('\${a.id}')">
        <div class="a-card-head">
          <div class="a-pin">\${i + 1}</div>
          <div class="a-selector">\${esc(a.elementPath || a.selector || '')}</div>
          <div class="a-actions">
            <button class="a-copy" id="copy-\${a.id}" onclick="event.stopPropagation(); copyAnnotation('\${a.id}')" title="Copy prompt for this annotation">⧉</button>
            <button class="a-delete" onclick="event.stopPropagation(); deleteAnnotation('\${a.id}')">&times;</button>
          </div>
        </div>
        <div class="a-labels-row">
          <div class="a-type-wrap">
            <span class="a-type \${a.type || 'feedback'}" onclick="event.stopPropagation(); toggleTypeDropdown('\${a.id}')">\${esc(a.type || 'feedback')} <span class="a-type-arrow">▾</span></span>
            <div class="a-type-dropdown" id="type-dd-\${a.id}"></div>
          </div>
          \${(a.labels || []).map(l => '<span class="a-label">' + esc(l) + '<span class="a-label-x" onclick="event.stopPropagation(); removeLabel(\\'' + a.id + '\\', \\'' + esc(l) + '\\')">&times;</span></span>').join('')}
          <button class="a-label-add" onclick="event.stopPropagation(); showLabelInput('\${a.id}')" id="label-add-\${a.id}">+</button>
          <input class="a-label-input" id="label-input-\${a.id}" style="display:none" placeholder="label…" maxlength="20">
        </div>
        <div class="a-note">\${esc(a.comment || '')}</div>
        <div class="a-meta">
          <span>\${a.element || ''}</span>
          <span style="display:flex;align-items:center;gap:6px;">
            \${isCollab && a.author ? '<span style="display:flex;align-items:center;gap:4px;"><span style="width:6px;height:6px;border-radius:50%;background:' + (a.author.color || '#636bff') + ';display:inline-block;"></span>' + esc(a.author.name || '') + '</span>' : ''}
            \${a.timestamp ? new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
          </span>
        </div>
      </div>
    \`).join('');
  }

  function focusAnnotation(id) {
    try {
      prototypeFrame.contentWindow.postMessage({
        source: 'anno-agent-parent',
        type: 'highlight-annotation',
        payload: { id }
      }, '*');
    } catch (e) {}
  }

  // ═══ HISTORY LOG ═══
  function logHistory(action, annotation) {
    history.unshift({ action, annotation, time: Date.now() });
    renderHistory();
  }
  function renderHistory() {
    const el = document.getElementById('historyContent');
    el.innerHTML = history.slice(0, 50).map(h => \`
      <div class="history-item">
        <div class="time">\${new Date(h.time).toLocaleTimeString()}</div>
        <div class="action">\${h.action}: \${esc((h.annotation.comment || '').slice(0, 60))}</div>
      </div>
    \`).join('');
  }

  // ═══ STATS ═══
  function updateStats(stats) {
    if (stats) {
      document.getElementById('statPending').textContent = stats.pending || 0;
      document.getElementById('statFixed').textContent = stats.fixed || 0;
      document.getElementById('statTotal').textContent = stats.total || 0;
    } else {
      const pending = annotations.filter(a => a.status === 'pending' || !a.status).length;
      const fixed = annotations.filter(a => a.status === 'fixed' || a.status === 'resolved').length;
      document.getElementById('statPending').textContent = pending;
      document.getElementById('statFixed').textContent = fixed;
      document.getElementById('statTotal').textContent = annotations.length;
    }
  }

  // ═══ TYPE DROPDOWN (feedback/bug/question only) ═══
  function toggleTypeDropdown(id) {
    document.querySelectorAll('.a-type-dropdown.open').forEach(d => d.classList.remove('open'));
    const dd = document.getElementById('type-dd-' + id);
    if (!dd) return;

    const a = annotations.find(x => x.id === id);
    const current = a?.type || 'feedback';

    dd.innerHTML = ['feedback', 'bug', 'question'].map(t =>
      '<div class="a-type-option" data-type="' + t + '"><div class="a-type-dot ' + t + '"></div>' + t + '</div>'
    ).join('');

    dd.querySelectorAll('.a-type-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        setAnnotationType(id, opt.dataset.type);
      });
    });

    dd.classList.add('open');
  }

  function setAnnotationType(id, type) {
    document.querySelectorAll('.a-type-dropdown.open').forEach(d => d.classList.remove('open'));
    fetch('/api/annotations/' + id, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ type })
    });
  }

  // ═══ LABELS (additive tags) ═══
  function showLabelInput(id) {
    const btn = document.getElementById('label-add-' + id);
    const input = document.getElementById('label-input-' + id);
    if (!btn || !input) return;
    btn.style.display = 'none';
    input.style.display = 'block';
    input.focus();
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const label = input.value.trim().toLowerCase().slice(0, 20);
        if (label) addLabel(id, label);
        input.value = '';
        input.style.display = 'none';
        btn.style.display = 'inline-block';
      } else if (e.key === 'Escape') {
        input.value = '';
        input.style.display = 'none';
        btn.style.display = 'inline-block';
      }
    };
    input.onblur = () => {
      const label = input.value.trim().toLowerCase().slice(0, 20);
      if (label) addLabel(id, label);
      input.value = '';
      input.style.display = 'none';
      btn.style.display = 'inline-block';
    };
  }

  function addLabel(id, label) {
    const a = annotations.find(x => x.id === id);
    if (!a) return;
    const labels = [...(a.labels || [])];
    if (labels.includes(label)) return;
    labels.push(label);
    fetch('/api/annotations/' + id, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ labels })
    });
  }

  function removeLabel(id, label) {
    const a = annotations.find(x => x.id === id);
    if (!a) return;
    const labels = (a.labels || []).filter(l => l !== label);
    fetch('/api/annotations/' + id, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ labels })
    });
  }

  // Close dropdowns on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('.a-type-dropdown.open').forEach(d => d.classList.remove('open'));
  });

  // ═══ COPY ═══
  function copyPrompt() {
    fetch('/api/prompt')
      .then(r => r.text())
      .then(prompt => {
        copyToClipboard(prompt);
        showToast('Copied agent prompt · ' + annotations.length + ' items');
      });
  }
  function copyAnnotation(id) {
    fetch('/api/prompt/' + id)
      .then(r => r.text())
      .then(prompt => {
        copyToClipboard(prompt);
        const btn = document.getElementById('copy-' + id);
        if (btn) {
          btn.textContent = '✓';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = '⧉'; btn.classList.remove('copied'); }, 2000);
        }
        const a = annotations.find(x => x.id === id);
        showToast('Copied prompt for: ' + (a?.comment || '').slice(0, 40));
      });
  }
  function copyJSON() {
    const json = JSON.stringify(annotations, null, 2);
    copyToClipboard(json);
    showToast('Copied JSON · ' + annotations.length + ' items');
  }
  function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }

  // ═══ ACTIONS ═══
  function deleteAnnotation(id) {
    fetch('/api/annotations/' + id, { method: 'DELETE', headers: authHeaders() });
  }
  function clearAll() {
    fetch('/api/annotations', { method: 'DELETE', headers: authHeaders() });
    showToast('All annotations cleared');
  }
  function updateButtons() {
    const has = annotations.length > 0;
    document.getElementById('copyBtn').disabled = !has;
    document.getElementById('clearBtn').disabled = !has;
    document.getElementById('jsonBtn').disabled = !has;
  }

  // ═══ KEYBOARD SHORTCUTS ═══
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.key === 'a' || e.key === 'A') toggleAnnotate();
    if (e.key === 'p' || e.key === 'P') togglePanel();
    if (e.key === 'Escape') {
      if (annotating) toggleAnnotate();
      else if (panelOpen) togglePanel();
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'c') {
      e.preventDefault();
      if (annotations.length) copyPrompt();
    }
  });

  // ═══ UTILS ═══
  function renderParticipants() {
    const el = document.getElementById('collabDots');
    if (!el || !isCollab) return;
    el.innerHTML = participants.map(p =>
      '<div class="collab-dot" style="background:' + (p.color || '#636bff') + '" title="' + esc(p.name) + '">' +
        esc(p.name[0].toUpperCase()) +
        '<span class="collab-tooltip">' + esc(p.name) + (p.isHost ? ' (host)' : '') + '</span>' +
      '</div>'
    ).join('');
  }

  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
  }
</script>
</body>
</html>`;
}


// ═══════════════════════════════════════════════════════════════
// INJECTION SCRIPT — runs inside the prototype iframe
// Full annotation UX: hover highlight, click popover, type tags
// ═══════════════════════════════════════════════════════════════

function buildInjectScript(port) {
  return `(function() {
  if (window.__annoAgentInjected) return;
  window.__annoAgentInjected = true;

  let annotating = false;
  let popover = null;
  let lastHovered = null;

  // ── Remote presence rings ──
  const remotePresenceRings = new Map();

  function showRemotePresence(data) {
    const { participantId, name, color, x, y, selector } = data;

    var targetEl = null;
    try { targetEl = document.querySelector(selector); } catch(err) {}

    var ring = remotePresenceRings.get(participantId);
    if (!ring) {
      ring = document.createElement('div');
      ring.className = '__anno_presence_ring';
      ring.style.cssText = 'position:fixed;pointer-events:none;z-index:999998;border:2px solid ' + (color || '#636bff') + ';border-radius:4px;transition:all 0.15s;display:none;';

      var label = document.createElement('div');
      label.style.cssText = 'position:absolute;top:-20px;left:0;font-size:9px;padding:1px 6px;border-radius:3px;background:' + (color || '#636bff') + ';color:#fff;font-family:sans-serif;white-space:nowrap;';
      label.textContent = name || '?';
      ring.appendChild(label);

      document.body.appendChild(ring);
      remotePresenceRings.set(participantId, ring);
    }

    if (targetEl) {
      var box = targetEl.getBoundingClientRect();
      ring.style.left = (box.left - 3) + 'px';
      ring.style.top = (box.top - 3) + 'px';
      ring.style.width = (box.width + 6) + 'px';
      ring.style.height = (box.height + 6) + 'px';
    } else {
      ring.style.left = ((x || 0) - 20) + 'px';
      ring.style.top = ((y || 0) - 20) + 'px';
      ring.style.width = '40px';
      ring.style.height = '40px';
    }

    ring.style.display = 'block';

    clearTimeout(ring._timeout);
    ring._timeout = setTimeout(function() { ring.style.display = 'none'; }, 3000);
  }

  // ── Listen for messages from parent ──
  window.addEventListener('message', (e) => {
    if (e.data?.source !== 'anno-agent-parent') return;
    if (e.data.type === 'start-annotating') startAnnotating();
    if (e.data.type === 'stop-annotating') stopAnnotating();
    if (e.data.type === 'presence-hover') showRemotePresence(e.data.payload);
  });

  let lastPresenceSend = 0;
  function sendPresence(e) {
    const now = Date.now();
    if (now - lastPresenceSend < 100) return;
    lastPresenceSend = now;
    const el = e.target;
    if (el.id === '__anno_popover' || el.closest('#__anno_popover')) return;
    const selector = buildSelector(el);
    if (!selector) return;
    const box = el.getBoundingClientRect();
    window.parent.postMessage({
      source: 'anno-agent-inject',
      type: 'presence-hover',
      payload: { selector: selector, x: Math.round(box.left + box.width/2), y: Math.round(box.top) }
    }, '*');
  }

  function startAnnotating() {
    annotating = true;
    document.body.style.cursor = 'crosshair';
    document.addEventListener('click', handleClick, true);
    document.addEventListener('mousemove', handleHover, true);
    document.addEventListener('mousemove', sendPresence, true);
  }

  function stopAnnotating() {
    annotating = false;
    document.body.style.cursor = '';
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('mousemove', handleHover, true);
    document.removeEventListener('mousemove', sendPresence, true);
    removePopover();
    removeHighlights();
  }

  // ── Hover highlight ──
  function handleHover(e) {
    if (!annotating || popover) return;
    const el = e.target;
    if (el === lastHovered || el.id === '__anno_popover' || el.closest('#__anno_popover')) return;
    removeHighlights();
    lastHovered = el;
    el.style.outline = '2px solid rgba(99,107,255,0.7)';
    el.style.outlineOffset = '1px';
    el.dataset._annoHighlighted = '1';
  }

  function removeHighlights() {
    document.querySelectorAll('[data-_anno-highlighted]').forEach(el => {
      el.style.outline = '';
      el.style.outlineOffset = '';
      delete el.dataset._annoHighlighted;
    });
    lastHovered = null;
  }

  // ── Click to annotate ──
  function handleClick(e) {
    if (!annotating) return;
    // Ignore clicks on popover itself
    if (e.target.id === '__anno_popover' || e.target.closest('#__anno_popover')) return;

    e.preventDefault();
    e.stopPropagation();

    const el = e.target;
    removeHighlights();
    showPopover(el, e.clientX, e.clientY);
  }

  // ── Popover ──
  function showPopover(el, x, y) {
    removePopover();

    const div = document.createElement('div');
    div.id = '__anno_popover';
    div.style.cssText = \`position:fixed;z-index:999999;background:#111318;border:1px solid #262a35;border-radius:10px;padding:14px;width:280px;box-shadow:0 24px 64px rgba(0,0,0,0.5), 0 8px 20px rgba(0,0,0,0.3);font-family:'DM Sans',-apple-system,sans-serif;color:#e4e7ef;\`;
    div.style.left = Math.min(x + 12, window.innerWidth - 300) + 'px';
    div.style.top = Math.min(y - 8, window.innerHeight - 260) + 'px';

    const selector = buildSelector(el);
    const fullPath = buildFullPath(el);
    const box = el.getBoundingClientRect();

    div.innerHTML = \`
      <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#636bff;margin-bottom:4px;">\${escH(selector)}</div>
      <div style="font-size:10px;color:#5c6273;margin-bottom:10px;">\${el.tagName.toLowerCase()} · \${Math.round(box.width)}×\${Math.round(box.height)}px</div>
      <textarea id="__anno_note" placeholder="Describe the issue or feedback…" style="width:100%;padding:8px 10px;background:#0a0b0d;border:1px solid #262a35;border-radius:6px;color:#e4e7ef;font-family:'DM Sans',-apple-system,sans-serif;font-size:12px;resize:none;outline:none;height:72px;line-height:1.5;"></textarea>
      <div style="display:flex;gap:4px;margin:10px 0 4px;">
        <button class="__anno_type_btn" data-type="feedback" style="font-size:9px;font-weight:600;padding:3px 8px;border-radius:4px;cursor:pointer;border:1px solid #636bff;background:rgba(99,107,255,0.12);color:#636bff;font-family:'JetBrains Mono',monospace;">FEEDBACK</button>
        <button class="__anno_type_btn" data-type="bug" style="font-size:9px;font-weight:600;padding:3px 8px;border-radius:4px;cursor:pointer;border:1px solid transparent;background:rgba(248,113,113,0.12);color:#f87171;font-family:'JetBrains Mono',monospace;">BUG</button>
        <button class="__anno_type_btn" data-type="question" style="font-size:9px;font-weight:600;padding:3px 8px;border-radius:4px;cursor:pointer;border:1px solid transparent;background:rgba(251,191,36,0.12);color:#fbbf24;font-family:'JetBrains Mono',monospace;">QUESTION</button>
      </div>
      <div id="__anno_labels_row" style="display:flex;gap:4px;margin:0 0 8px;flex-wrap:wrap;align-items:center;">
        <button id="__anno_label_add" style="font-size:9px;font-weight:500;padding:2px 7px;border-radius:4px;cursor:pointer;border:1px dashed #262a35;background:transparent;color:#5c6273;font-family:'JetBrains Mono',monospace;">+ label</button>
        <input id="__anno_label_input" style="display:none;font-size:9px;font-weight:500;padding:2px 6px;border-radius:4px;border:1px solid #636bff;background:#0a0b0d;color:#e4e7ef;font-family:'JetBrains Mono',monospace;width:70px;outline:none;" placeholder="label…" maxlength="20">
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end;">
        <button id="__anno_cancel" style="padding:5px 10px;border-radius:6px;background:transparent;color:#5c6273;font-size:12px;border:1px solid #262a35;cursor:pointer;font-family:'DM Sans',-apple-system,sans-serif;">Cancel</button>
        <button id="__anno_add" style="padding:5px 14px;border-radius:6px;background:#636bff;color:white;font-size:12px;font-weight:600;border:none;cursor:pointer;font-family:'DM Sans',-apple-system,sans-serif;">Add</button>
      </div>
    \`;

    document.body.appendChild(div);
    popover = div;

    let selectedType = 'feedback';

    // Type selection
    function selectTypeBtn(btn) {
      div.querySelectorAll('.__anno_type_btn').forEach(b => b.style.borderColor = 'transparent');
      btn.style.borderColor = btn.style.color || '#9da3b3';
      selectedType = btn.dataset.type;
    }
    div.querySelectorAll('.__anno_type_btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectTypeBtn(btn);
      });
    });

    // Labels "+" button
    const selectedLabels = [];
    const labelRow = div.querySelector('#__anno_labels_row');
    const labelAddBtn = div.querySelector('#__anno_label_add');
    const labelInput = div.querySelector('#__anno_label_input');

    function renderLabelChips() {
      // Remove old chips
      labelRow.querySelectorAll('.__anno_label_chip').forEach(c => c.remove());
      selectedLabels.forEach(label => {
        const chip = document.createElement('span');
        chip.className = '__anno_label_chip';
        chip.style.cssText = 'font-size:9px;font-weight:500;padding:2px 6px;border-radius:4px;font-family:"JetBrains Mono",monospace;background:rgba(255,255,255,0.06);color:#9da3b3;border:1px solid #262a35;display:inline-flex;align-items:center;gap:4px;';
        chip.innerHTML = label + '<span style="cursor:pointer;opacity:0.5;font-size:10px;" data-remove="' + label + '">&times;</span>';
        chip.querySelector('[data-remove]').addEventListener('click', (ev) => {
          ev.stopPropagation();
          const idx = selectedLabels.indexOf(label);
          if (idx >= 0) selectedLabels.splice(idx, 1);
          renderLabelChips();
        });
        labelRow.insertBefore(chip, labelAddBtn);
      });
    }

    if (labelAddBtn && labelInput) {
      labelAddBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        labelAddBtn.style.display = 'none';
        labelInput.style.display = 'block';
        labelInput.focus();
      });
      labelInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const label = labelInput.value.trim().toLowerCase().slice(0, 20);
          if (label && !selectedLabels.includes(label)) {
            selectedLabels.push(label);
            renderLabelChips();
          }
          labelInput.value = '';
          labelInput.style.display = 'none';
          labelAddBtn.style.display = 'inline-block';
        } else if (e.key === 'Escape') {
          labelInput.value = '';
          labelInput.style.display = 'none';
          labelAddBtn.style.display = 'inline-block';
        }
      });
    }

    // Add button
    div.querySelector('#__anno_add').addEventListener('click', (e) => {
      e.stopPropagation();
      const note = div.querySelector('#__anno_note').value.trim();
      if (!note) return;

      const styles = window.getComputedStyle(el);
      const elBox = el.getBoundingClientRect();
      const parentEl = el.parentElement;
      const parentStyles = parentEl ? window.getComputedStyle(parentEl) : null;

      // Capture a clean outerHTML snippet (strip annotation artifacts)
      const clone = el.cloneNode(true);
      clone.style.outline = '';
      clone.style.outlineOffset = '';
      delete clone.dataset._annoHighlighted;
      const outerSnippet = clone.outerHTML.slice(0, 300);

      window.parent.postMessage({
        source: 'anno-agent-inject',
        type: 'element-clicked',
        payload: {
          comment: note,
          type: selectedType,
          labels: [...selectedLabels],
          element: el.tagName.toLowerCase(),
          elementPath: fullPath,
          selector: selector,
          cssClasses: getCssClasses(el),
          nearbyText: getNearbyText(el),
          outerHTML: outerSnippet,
          boundingBox: { x: Math.round(elBox.x), y: Math.round(elBox.y), width: Math.round(elBox.width), height: Math.round(elBox.height) },
          computedStyles: {
            fontSize: styles.fontSize,
            fontWeight: styles.fontWeight,
            lineHeight: styles.lineHeight,
            color: styles.color,
            bg: styles.backgroundColor,
            padding: styles.padding,
            margin: styles.margin,
            gap: styles.gap,
            borderRadius: styles.borderRadius,
            border: styles.border,
            display: styles.display,
            position: styles.position,
            overflow: styles.overflow,
            opacity: styles.opacity,
          },
          parentInfo: parentEl ? {
            tag: parentEl.tagName.toLowerCase(),
            classes: getCssClasses(parentEl),
            display: parentStyles.display,
            flexDirection: parentStyles.flexDirection,
            gridTemplateColumns: parentStyles.gridTemplateColumns,
            gap: parentStyles.gap,
            alignItems: parentStyles.alignItems,
            justifyContent: parentStyles.justifyContent,
          } : null,
          url: window.location.href,
          timestamp: Date.now(),
          status: 'pending'
        }
      }, '*');

      // Mark element with pin outline
      el.style.outline = '2px solid #fbbf24';
      el.style.outlineOffset = '1px';

      removePopover();
    });

    // Cancel button
    div.querySelector('#__anno_cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      removePopover();
    });

    // Focus textarea
    setTimeout(() => div.querySelector('#__anno_note')?.focus(), 50);

    // Keyboard shortcuts in textarea
    div.querySelector('#__anno_note').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') removePopover();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) div.querySelector('#__anno_add').click();
    });
  }

  function removePopover() {
    if (popover) { popover.remove(); popover = null; }
  }

  // ── Selector builders ──
  const IGNORE_CLASSES = ['annotating', 'highlighted', 'visible', 'show', 'active'];

  function cleanClasses(el) {
    return [...el.classList].filter(c => !c.startsWith('_') && !IGNORE_CLASSES.some(ic => c === ic));
  }

  function buildSelector(el) {
    const tag = el.tagName.toLowerCase();
    const cls = cleanClasses(el).slice(0, 2).map(c => '.' + c).join('');
    if (cls) return tag + cls;
    if (el.id) return '#' + el.id;
    return tag;
  }

  function buildFullPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const tag = cur.tagName.toLowerCase();
      const cls = cleanClasses(cur).slice(0, 2).map(c => '.' + c).join('');
      const id = cur.id && !cur.id.startsWith('__anno') ? '#' + cur.id : '';
      parts.unshift(tag + (id || cls));
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function getCssClasses(el) {
    return cleanClasses(el).join(' ');
  }

  function getNearbyText(el) {
    const own = (el.textContent || '').trim().slice(0, 100);
    if (own) return own;
    const parent = el.parentElement;
    if (parent) return (parent.textContent || '').trim().slice(0, 100);
    return '';
  }

  function escH(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();`;
}


// ═══════════════════════════════════════════════════════════════
// JOIN PAGE — simple collab join form
// ═══════════════════════════════════════════════════════════════

function buildJoinPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Join Review Session</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=DM+Sans:wght@300;400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'DM Sans', -apple-system, sans-serif;
    background: #0a0b0d; color: #e4e7ef;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh;
  }
  .join-card {
    background: #111318; border: 1px solid #262a35; border-radius: 12px;
    padding: 32px; width: 340px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.5);
  }
  .join-logo { font-family: 'JetBrains Mono', monospace; font-size: 16px; font-weight: 600; margin-bottom: 20px; }
  .join-logo span { color: #636bff; }
  .join-label { font-size: 12px; font-weight: 500; color: #9da3b3; margin-bottom: 6px; }
  .join-input {
    width: 100%; padding: 10px 12px; background: #0a0b0d; border: 1px solid #262a35;
    border-radius: 6px; color: #e4e7ef; font-size: 14px; font-family: 'DM Sans', sans-serif;
    outline: none; margin-bottom: 16px;
  }
  .join-input:focus { border-color: #636bff; }
  .join-input::placeholder { color: #5c6273; }
  .join-btn {
    width: 100%; padding: 10px; background: #636bff; color: #fff; border: none;
    border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer;
    font-family: 'DM Sans', sans-serif;
  }
  .join-btn:hover { opacity: 0.9; }
  .join-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .join-error { color: #f87171; font-size: 12px; margin-top: 8px; display: none; }
</style>
</head>
<body>
<div class="join-card">
  <div class="join-logo">proto<span>.</span> review</div>
  <div class="join-label">Invite Code</div>
  <input class="join-input" id="codeInput" placeholder="Enter invite code" />
  <div class="join-label">Your Name</div>
  <input class="join-input" id="nameInput" placeholder="Enter your name" />
  <button class="join-btn" id="joinBtn" onclick="joinSession()">Join Session</button>
  <div class="join-error" id="joinError"></div>
</div>
<script>
  // Pre-fill code from URL if present
  const params = new URLSearchParams(window.location.search);
  const codeParam = params.get('code');
  if (codeParam) document.getElementById('codeInput').value = codeParam;

  async function joinSession() {
    const code = document.getElementById('codeInput').value.trim();
    const name = document.getElementById('nameInput').value.trim();
    const errEl = document.getElementById('joinError');
    errEl.style.display = 'none';

    if (!code || !name) {
      errEl.textContent = 'Please enter both invite code and name.';
      errEl.style.display = 'block';
      return;
    }

    document.getElementById('joinBtn').disabled = true;
    try {
      const res = await fetch('/api/collab/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name })
      });
      if (!res.ok) {
        errEl.textContent = 'Invalid invite code.';
        errEl.style.display = 'block';
        document.getElementById('joinBtn').disabled = false;
        return;
      }
      const data = await res.json();
      localStorage.setItem('proto-collab-token', data.token);
      window.location.href = '/';
    } catch(e) {
      errEl.textContent = 'Connection error. Please try again.';
      errEl.style.display = 'block';
      document.getElementById('joinBtn').disabled = false;
    }
  }

  // Allow Enter to submit
  document.getElementById('nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinSession();
  });
  document.getElementById('codeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('nameInput').focus();
  });
</script>
</body>
</html>`;
}


// ── Utility ──
function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


// ═══════════════════════════════════════════════════════════════
// DEMO PAGE — built-in test UI so anno-agent works standalone
// Modelled on the HTML prototype's dashboard
// ═══════════════════════════════════════════════════════════════

function buildDemoPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dashboard — Demo App</title>
<script src="/inject.js"></${'script'}>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #f8f9fb; --surface: #ffffff; --border: #e5e7eb; --border-hover: #d1d5db;
    --text: #111827; --text-secondary: #6b7280; --muted: #9ca3af;
    --primary: #4f46e5; --primary-soft: rgba(79,70,229,0.08); --primary-hover: #4338ca;
    --green: #059669; --green-soft: rgba(5,150,105,0.08);
    --amber: #d97706; --amber-soft: rgba(217,119,6,0.08);
    --red: #dc2626; --red-soft: rgba(220,38,38,0.08);
    --radius: 8px; --shadow: 0 1px 3px rgba(0,0,0,0.08);
    --font: 'DM Sans', -apple-system, sans-serif;
    --mono: 'JetBrains Mono', monospace;
  }
  body { font-family: var(--font); background: var(--bg); color: var(--text); min-height: 100vh; display: flex; }

  /* Sidebar */
  .sidebar { width: 220px; background: var(--surface); border-right: 1px solid var(--border); padding: 20px 0; display: flex; flex-direction: column; flex-shrink: 0; }
  .sidebar-logo { font-family: var(--mono); font-size: 15px; font-weight: 600; padding: 0 20px 20px; color: var(--primary); }
  .sidebar-section { font-size: 10px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; padding: 16px 20px 8px; }
  .nav-item { display: flex; align-items: center; gap: 10px; padding: 8px 20px; font-size: 13px; color: var(--text-secondary); cursor: pointer; transition: all 0.15s; }
  .nav-item:hover { background: var(--primary-soft); color: var(--text); }
  .nav-item.active { background: var(--primary-soft); color: var(--primary); font-weight: 500; }
  .nav-icon { width: 16px; height: 16px; opacity: 0.5; }
  .nav-item.active .nav-icon { opacity: 1; }
  .sidebar-spacer { flex: 1; }
  .sidebar-user { display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-top: 1px solid var(--border); margin-top: 8px; font-size: 13px; }
  .sidebar-avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--primary); color: white; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; }

  /* Content */
  .content { flex: 1; padding: 32px 40px; overflow-y: auto; }
  .page-title { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
  .page-subtitle { font-size: 13px; color: var(--muted); margin-bottom: 28px; }

  /* Stats grid */
  .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 32px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; box-shadow: var(--shadow); }
  .stat-label { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; }
  .stat-value { font-size: 28px; font-weight: 700; font-family: var(--mono); }
  .stat-delta { font-size: 12px; margin-top: 6px; font-weight: 500; }
  .stat-delta.up { color: var(--green); }
  .stat-delta.flat { color: var(--muted); }

  /* Section label */
  .section-label { font-size: 13px; font-weight: 600; color: var(--text-secondary); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }

  /* Quick add */
  .quick-add { display: flex; gap: 10px; margin-bottom: 32px; }
  .input-field { flex: 1; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius); font-size: 13px; font-family: var(--font); outline: none; transition: border-color 0.15s; }
  .input-field:focus { border-color: var(--primary); }
  .input-field::placeholder { color: var(--muted); }

  /* Buttons */
  .btn-primary { padding: 10px 20px; background: var(--primary); color: white; border: none; border-radius: var(--radius); font-size: 13px; font-weight: 600; font-family: var(--font); cursor: pointer; transition: background 0.15s; }
  .btn-primary:hover { background: var(--primary-hover); }
  .btn-secondary { padding: 10px 20px; background: var(--surface); color: var(--text-secondary); border: 1px solid var(--border); border-radius: var(--radius); font-size: 13px; font-weight: 500; font-family: var(--font); cursor: pointer; transition: all 0.15s; }
  .btn-secondary:hover { border-color: var(--border-hover); color: var(--text); }

  /* Table */
  .data-table { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-bottom: 20px; box-shadow: var(--shadow); }
  .table-header { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; padding: 10px 16px; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); background: var(--bg); }
  .table-row { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; padding: 12px 16px; font-size: 13px; border-bottom: 1px solid var(--border); align-items: center; }
  .table-row:last-child { border-bottom: none; }
  .table-row .muted { color: var(--text-secondary); }
  .badge { font-size: 11px; font-weight: 500; padding: 3px 10px; border-radius: 12px; }
  .badge.active { background: var(--green-soft); color: var(--green); }
  .badge.pending { background: var(--amber-soft); color: var(--amber); }
  .badge.inactive { background: var(--red-soft); color: var(--red); }

  .action-row { display: flex; gap: 10px; }
</style>
</head>
<body>

<div class="sidebar">
  <div class="sidebar-logo">acme.</div>
  <div class="sidebar-section">Navigation</div>
  <div class="nav-item active">
    <svg class="nav-icon" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>
    Overview
  </div>
  <div class="nav-item">
    <svg class="nav-icon" viewBox="0 0 16 16" fill="none"><path d="M2 4a1 1 0 011-1h4l2 2h5a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" stroke-width="1.2"/></svg>
    Projects
  </div>
  <div class="nav-item">
    <svg class="nav-icon" viewBox="0 0 16 16" fill="none"><circle cx="6" cy="5" r="2.5" stroke="currentColor" stroke-width="1.2"/><path d="M1 13c0-2.5 2.2-4 5-4s5 1.5 5 4" stroke="currentColor" stroke-width="1.2"/></svg>
    Team
  </div>
  <div class="nav-item">
    <svg class="nav-icon" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
    Settings
  </div>
  <div class="sidebar-spacer"></div>
  <div class="sidebar-user">
    <div class="sidebar-avatar">S</div>
    Simone
  </div>
</div>

<div class="content">
  <div class="page-title">Overview</div>
  <div class="page-subtitle">Last updated 3 minutes ago</div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Total Users</div>
      <div class="stat-value">2,847</div>
      <div class="stat-delta up">+12% this week</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Revenue</div>
      <div class="stat-value">$14.3k</div>
      <div class="stat-delta up">+8% this week</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Churn Rate</div>
      <div class="stat-value">2.1%</div>
      <div class="stat-delta flat">unchanged</div>
    </div>
  </div>

  <div class="section-label">Quick Add</div>
  <div class="quick-add">
    <input class="input-field" placeholder="name@company.com" />
    <button class="btn-primary">Invite</button>
  </div>

  <div class="section-label">Recent Activity</div>
  <div class="data-table">
    <div class="table-header">
      <span>Member</span><span>Plan</span><span>Status</span><span>MRR</span>
    </div>
    <div class="table-row">
      <span>Mia Chen</span>
      <span class="muted">Pro</span>
      <span><span class="badge active">Active</span></span>
      <span>$49</span>
    </div>
    <div class="table-row">
      <span>James Park</span>
      <span class="muted">Team</span>
      <span><span class="badge pending">Pending</span></span>
      <span>$129</span>
    </div>
    <div class="table-row">
      <span>Sara Ali</span>
      <span class="muted">Starter</span>
      <span><span class="badge inactive">Inactive</span></span>
      <span>$0</span>
    </div>
    <div class="table-row">
      <span>Lucas Vega</span>
      <span class="muted">Pro</span>
      <span><span class="badge active">Active</span></span>
      <span>$49</span>
    </div>
  </div>

  <div class="action-row">
    <button class="btn-primary">Export CSV</button>
    <button class="btn-secondary">View all &rarr;</button>
  </div>
</div>

</body>
</html>`;
}
