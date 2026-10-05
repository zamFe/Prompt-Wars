// Agent speech: how a line gets out of a model's reply and onto a channel.
//
// There are two channels and one answer. An agent writes both in the same JSON
// it returns its actions in, so speaking never costs an extra model call:
//
//   say / chat  -> out loud: the bubble over its sphere, and the global chat
//   reply       -> privately to its operator, and nowhere else
//
// Either may also be written as a standalone object in the agent's prose
// ({"say": "..."}), which is what the server brain's tool-calling path uses -
// there the text and the tool calls arrive as separate blocks.

import { CHAT, COMMS } from './config.js';

/** Matches one speech object: {"say": "…"}, {"chat": "…"} or {"reply": "…"}. */
const SPEECH_RE = /\{\s*"(say|chat|reply)"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g;

/**
 * Pull the speech objects out of a model's reply text.
 *
 * Returns the first line found for each channel, plus the text with every
 * speech object removed - so a bubble does not also show up in the reasoning
 * note. The first line per channel wins; later ones are dropped.
 */
export function extractSpeech(text) {
  if (!text) return { say: null, reply: null, rest: '' };

  const found = { say: null, reply: null };

  const rest = String(text).replace(SPEECH_RE, (match, key) => {
    const channel = key === 'reply' ? 'reply' : 'say';
    if (found[channel]) return '';                  // only the first line counts
    try {
      const value = JSON.parse(match)[key];
      if (typeof value === 'string' && value.trim()) {
        found[channel] = tidy(value, channel === 'reply' ? COMMS.replyLength : CHAT.maxLength);
      }
    } catch {
      // Malformed - drop it rather than showing raw braces over a sphere.
    }
    return '';
  });

  return { ...found, rest: rest.replace(/\s+/g, ' ').trim() };
}

/** The out-loud channel on its own, which is all the older callers want. */
export function extractChat(text) {
  const { say, rest } = extractSpeech(text);
  return { chat: say, rest };
}

/** Collapse whitespace and cut to length. */
export function tidy(line, limit = CHAT.maxLength) {
  const clean = String(line ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
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
