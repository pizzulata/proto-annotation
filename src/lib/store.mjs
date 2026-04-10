/**
 * Annotation store — in-memory persistence
 *
 * Tracks annotations, sessions, stats, and collaboration.
 * Can be swapped to SQLite later for persistence across restarts.
 */

import { randomBytes } from 'crypto';

const COLLAB_COLORS = [
  '#e06c75', // rose
  '#61afef', // blue
  '#98c379', // green
  '#e5c07b', // gold
  '#c678dd', // purple
  '#56b6c2', // teal
  '#d19a66', // orange
  '#be5046', // brick
];

export function createStore() {
  const annotations = new Map();
  const sessions = new Map();
  let collabSession = null;

  function genId(prefix = 'ann_') {
    return prefix + randomBytes(4).toString('hex');
  }

  // ═══ COLLABORATION ═══

  function initCollab(hostName) {
    const inviteCode = randomBytes(3).toString('hex');
    const hostToken = 'tok_' + randomBytes(16).toString('hex');
    const hostId = genId('p_');
    collabSession = {
      inviteCode,
      hostToken,
      participants: new Map(),
      colorIndex: 1,
    };
    const hostParticipant = {
      id: hostId,
      name: hostName || 'Host',
      color: COLLAB_COLORS[0],
      isHost: true,
      token: hostToken,
      joinedAt: new Date().toISOString(),
    };
    collabSession.participants.set(hostToken, hostParticipant);
    return { inviteCode, hostToken, hostParticipant };
  }

  function isCollabActive() {
    return collabSession !== null;
  }

  function joinSession(inviteCode, name) {
    if (!collabSession) return null;
    if (collabSession.inviteCode !== inviteCode) return null;
    if (!name || !name.trim()) return null;

    const token = 'tok_' + randomBytes(16).toString('hex');
    const id = genId('p_');
    const colorIdx = collabSession.colorIndex % COLLAB_COLORS.length;
    collabSession.colorIndex++;

    const participant = {
      id,
      name: name.trim().slice(0, 20),
      color: COLLAB_COLORS[colorIdx],
      isHost: false,
      token,
      joinedAt: new Date().toISOString(),
    };
    collabSession.participants.set(token, participant);
    return { token, participant };
  }

  function getParticipant(token) {
    if (!collabSession || !token) return null;
    return collabSession.participants.get(token) || null;
  }

  function getParticipants() {
    if (!collabSession) return [];
    return [...collabSession.participants.values()].map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      isHost: p.isHost,
    }));
  }

  function isHost(token) {
    if (!collabSession) return false;
    return token === collabSession.hostToken;
  }

  function removeParticipant(token) {
    if (!collabSession) return null;
    const p = collabSession.participants.get(token);
    if (p && !p.isHost) {
      collabSession.participants.delete(token);
    }
    return p || null;
  }

  // ═══ ANNOTATIONS ═══

  function createAnnotation(data) {
    const id = genId('ann_');
    const annotation = {
      id,
      comment: data.comment || data.note || '',
      type: data.type || 'feedback',
      labels: Array.isArray(data.labels) ? data.labels : [],
      status: data.status || 'pending',
      element: data.element || '',
      elementPath: data.elementPath || data.fullPath || '',
      selector: data.selector || '',
      cssClasses: data.cssClasses || '',
      nearbyText: data.nearbyText || '',
      outerHTML: data.outerHTML || '',
      boundingBox: data.boundingBox || null,
      computedStyles: data.computedStyles || null,
      parentInfo: data.parentInfo || null,
      computedContext: data.computedContext || '',
      url: data.url || '',
      author: data.author || null,
      timestamp: data.timestamp || Date.now(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    annotations.set(id, annotation);

    // Track session by URL
    const sessionKey = annotation.url || 'default';
    if (!sessions.has(sessionKey)) {
      sessions.set(sessionKey, {
        id: sessionKey,
        url: annotation.url,
        createdAt: new Date().toISOString(),
        annotationCount: 0,
      });
    }
    sessions.get(sessionKey).annotationCount++;

    return annotation;
  }

  function getAnnotations({ session, status, type } = {}) {
    let result = [...annotations.values()];
    if (session) result = result.filter(a => a.url === session || a.url.includes(session));
    if (status) result = result.filter(a => a.status === status);
    if (type) result = result.filter(a => a.type === type);
    return result.sort((a, b) => a.timestamp - b.timestamp);
  }

  function updateAnnotation(id, updates) {
    const existing = annotations.get(id);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    if (updates.status === 'fixed' || updates.status === 'resolved') {
      updated.resolvedAt = new Date().toISOString();
    }
    annotations.set(id, updated);
    return updated;
  }

  function deleteAnnotation(id) {
    const existing = annotations.get(id);
    if (!existing) return null;
    annotations.delete(id);
    return existing;
  }

  function getSessions() {
    return [...sessions.values()];
  }

  function getStats() {
    const all = [...annotations.values()];
    const defaultTypes = ['bug', 'feedback', 'question'];
    const customCounts = {};
    all.filter(a => a.type && !defaultTypes.includes(a.type))
      .forEach(a => { customCounts[a.type] = (customCounts[a.type] || 0) + 1; });
    return {
      total: all.length,
      pending: all.filter(a => a.status === 'pending').length,
      fixed: all.filter(a => a.status === 'fixed' || a.status === 'resolved').length,
      dismissed: all.filter(a => a.status === 'dismissed').length,
      bugs: all.filter(a => a.type === 'bug').length,
      feedback: all.filter(a => a.type === 'feedback').length,
      questions: all.filter(a => a.type === 'question').length,
      custom: customCounts,
    };
  }

  function clearAll() {
    annotations.clear();
    return true;
  }

  return {
    // Annotations
    createAnnotation,
    getAnnotations,
    updateAnnotation,
    deleteAnnotation,
    getSessions,
    getStats,
    clearAll,
    // Collaboration
    initCollab,
    isCollabActive,
    joinSession,
    getParticipant,
    getParticipants,
    isHost,
    removeParticipant,
  };
}
