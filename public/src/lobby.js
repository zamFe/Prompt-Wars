// Who is in the arena, who is waiting, and who is sitting out a death timer.

import { WORLD, LOBBY } from './config.js';
import { parseConstraints } from './constraints.js';

let nextId = 1;

export function createParticipant({ name, prompt, brainKind, colorIndex }) {
  return {
    id: `p${nextId++}`,
    name,
    prompt,
    brainKind,
    colorIndex,
    // Which viewer deployed this agent: their decisions are billed to them.
    ownerId: null,
    ownerPeer: null,
    tier: null,
    // Hard rules the prompt stated outright, enforced by the simulation.
    constraints: parseConstraints(prompt),
    // The private operator channel. `inbox` holds messages the agent has not
    // read yet; `briefing` is the orders plus everything said since, which is
    // what a brain that can only read a prompt gets to work from.
    inbox: [],
    briefing: prompt,
    // Order changes, newest last - what the agent is actually fighting under.
    amendments: [],
    messagesSent: 0,
    messagesRead: 0,
    // 'live' | 'queued' | 'cooldown' | 'eliminated' (out of lives, spectating)
    status: 'queued',
    readyAt: 0,
    // Which side, in a team mode. Null in a free-for-all.
    team: null,
    // Commander mode: who this is, and who it answers to.
    role: null,              // 'commander' | 'squad'
    codename: null,          // a squad fighter's call-sign
    commanderId: null,       // the participant it takes orders from
    commanderName: null,
    squadCodenames: [],      // every call-sign on this side, to spot one meant for someone else
    livesLeft: Infinity,
    kills: 0,
    assists: 0,
    deaths: 0,
    damageDealt: 0,
    damageTaken: 0,
    shotsFired: 0,
    pelletsFired: 0,
    hits: 0,
    captures: 0,
    returns: 0,
    longestLife: 0,
    decisions: 0,
    lastError: null,
    joinedAt: 0,
  };
}

export class Lobby {
  constructor(world) {
    this.world = world;
    this.participants = new Map();
    this.queue = [];           // participant ids, front is next in
  }

  get liveCount() {
    return this.world.agents.filter((a) => a.alive).length;
  }

  get isFull() {
    return this.liveCount >= WORLD.maxAgents;
  }

  list() {
    return [...this.participants.values()];
  }

  get(id) {
    return this.participants.get(id);
  }

  /** Register a new participant. Spawns immediately if there is room. */
  add(participant) {
    participant.joinedAt = this.world.time;
    this.participants.set(participant.id, participant);
    this.queue.push(participant.id);
    const spawned = this.pump();
    return spawned.includes(participant.id) ? 'spawned' : 'queued';
  }

  remove(id) {
    const participant = this.participants.get(id);
    if (!participant) return;
    this.world.removeAgentFor(id);
    this.participants.delete(id);
    this.queue = this.queue.filter((qid) => qid !== id);
  }

  /** Arena full *and* more than congestedQueueLength waiting to get in. */
  isCongested() {
    return this.isFull && this.queue.length > LOBBY.congestedQueueLength;
  }

  /**
   * Death timer. The long cooldown applies when the arena was full and the queue
   * was deep at the moment of death - dying while a crowd is waiting costs you
   * your place for a long while. The caller passes the congestion state it read
   * before the body was removed, since removing it changes the answer.
   */
  onDeath(participant, congested = this.isCongested()) {
    const wait = congested ? LOBBY.congestedCooldown : LOBBY.respawnCooldown;
    participant.status = 'cooldown';
    participant.readyAt = this.world.time + wait;
    participant.lastCooldown = wait;
    return wait;
  }

  /** Sit a participant out for a fixed time - a round's own respawn timer. */
  bench(participant, seconds) {
    participant.status = 'cooldown';
    participant.readyAt = this.world.time + seconds;
    participant.lastCooldown = seconds;
    return seconds;
  }

  /** Move expired cooldowns back into the queue, then fill any free slots. */
  update() {
    for (const participant of this.participants.values()) {
      if (participant.status === 'cooldown' && this.world.time >= participant.readyAt) {
        participant.status = 'queued';
        this.queue.push(participant.id);
      }
    }
    this.pump();
  }

  /** Spawn queued participants while slots remain. Returns the ids spawned. */
  pump() {
    const spawned = [];
    // Between rounds the arena stays empty however long the queue is.
    if (!this.world.allowSpawning) return spawned;

    while (this.queue.length && !this.isFull) {
      const id = this.queue.shift();
      const participant = this.participants.get(id);
      if (!participant || participant.status === 'live') continue;
      if (participant.status === 'eliminated') continue;       // watching the rest
      if (participant.status === 'cooldown' && this.world.time < participant.readyAt) continue;
      this.world.spawnAgent(participant);
      participant.status = 'live';
      spawned.push(id);
    }
    return spawned;
  }

  /** Position in the waiting line, 1-based, or null if not waiting. */
  queuePosition(id) {
    const index = this.queue.indexOf(id);
    return index === -1 ? null : index + 1;
  }
}
