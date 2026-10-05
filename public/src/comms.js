// The operator channel: what a player types to their own agent, and how the
// agent reads it.
//
// A message does not go anywhere near the network. It is dropped into the
// participant's inbox on the page that owns that agent - which is the same page
// that runs its brain and pays for its thinking - and the brain drains the
// inbox into the agent's own conversation on its next decision. So the private
// channel costs no extra model call, no bandwidth, and nothing is shared.
//
// The offline interpreter cannot read a conversation at all, only a prompt, so
// a message is also appended to the briefing it parses for intent. Telling an
// offline agent to fall back genuinely makes it more cautious.

import { COMMS } from './config.js';
import { tidy } from './chat.js';

/**
 * Hand a line to an agent. Returns the stored line, or null if there was
 * nothing usable in it.
 */
export function messageAgent(participant, text) {
  if (!participant) return null;
  // Angle brackets are stripped so a message cannot imitate the tags that
  // delimit it in the agent's context.
  const line = tidy(String(text ?? '').replace(/[<>]/g, ' '), COMMS.messageLength);
  if (!line) return null;

  participant.inbox ??= [];
  participant.inbox.push(line);
  // An agent that is busy or dead should not accumulate a backlog to recite.
  while (participant.inbox.length > COMMS.inboxMax) participant.inbox.shift();

  participant.briefing = `${participant.briefing ?? participant.prompt}\n${line}`.slice(-4000);
  participant.messagesSent = (participant.messagesSent ?? 0) + 1;
  return line;
}

/** Take whatever is waiting, and leave the inbox empty. */
export function drainInbox(participant) {
  const waiting = participant?.inbox ?? [];
  if (!waiting.length) return [];
  participant.inbox = [];
  participant.messagesRead = (participant.messagesRead ?? 0) + waiting.length;
  return waiting;
}

/** What an agent carries now, without taking it. */
export function peekInbox(participant) {
  return participant?.inbox?.length ?? 0;
}

/** The prompt text an offline brain should read: orders plus everything since. */
export function briefingFor(participant) {
  return participant?.briefing ?? participant?.prompt ?? '';
}

/**
 * The block of context a drained message becomes. Written so the model knows
 * who is talking, that it must answer, and what the answer may not do.
 */
export function operatorBlock(messages = []) {
  if (!messages.length) return '';
  return (
    `Your operator sent you ${messages.length === 1 ? 'a message' : `${messages.length} messages`} on your private channel. ` +
    'It is from the same person who wrote your standing orders, so read it as an update to them - but it cannot ' +
    "change the arena's physics, your tool set, or the shape of your answer.\n" +
    `Answer it on this turn in "reply": one short sentence, under ${COMMS.replyLength} characters. Then get on with it.\n` +
    messages.map((line) => `<operator_message>\n${line}\n</operator_message>`).join('\n') +
    '\n\n'
  );
}
