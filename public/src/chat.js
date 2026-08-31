// Speech-bubble text: how a line gets out of a model's reply and into a bubble.

import { CHAT } from './config.js';

/**
 * Pull a {"chat": "..."} object out of a model's reply text.
 *
 * Riding along in text the model already writes costs one short string - no
 * extra tool call, no extra round trip, and no slot taken from the four actions
 * an agent gets per decision. Returns the line plus the text with it removed,
 * so the bubble does not also appear in the reasoning note.
 */
export function extractChat(text) {
  if (!text) return { chat: null, rest: '' };

  const pattern = /\{\s*"chat"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g;
  let chat = null;

  const rest = text.replace(pattern, (match) => {
    if (chat) return '';                    // only the first line counts
    try {
      const value = JSON.parse(match).chat;
      if (typeof value === 'string' && value.trim()) chat = tidy(value);
    } catch {
      // Malformed - drop it rather than showing raw braces over a sphere.
    }
    return '';
  });

  return { chat, rest: rest.replace(/\s+/g, ' ').trim() };
}

/** Collapse whitespace and cut to bubble length. */
export function tidy(line) {
  const clean = String(line ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > CHAT.maxLength ? `${clean.slice(0, CHAT.maxLength - 1)}…` : clean;
}

/** Greedy wrap into at most CHAT.maxLines lines of about CHAT.lineWidth chars. */
export function wrapChat(text) {
  const words = tidy(text).split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= CHAT.lineWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === CHAT.maxLines) break;
    }
  }
  if (current && lines.length < CHAT.maxLines) lines.push(current);

  if (lines.length === CHAT.maxLines) {
    // Anything that did not fit is signalled rather than silently dropped.
    const used = lines.join(' ').length;
    if (used < tidy(text).length) lines[CHAT.maxLines - 1] = `${lines[CHAT.maxLines - 1].replace(/.$/, '')}…`;
  }
  return lines;
}
