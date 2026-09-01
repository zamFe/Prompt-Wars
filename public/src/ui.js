// DOM wiring: the join form, roster, inspector, feed and rules panel.

import { WORLD, LOBBY, WEAPONS, HEALTH_PACKS, LOOT, VISION, MOVE, AGENT, AGENT_COLORS, PULSE } from './config.js';
import { renderSnapshotText } from './sensors.js';
import { TOOL_SCHEMAS, TOOL_SUMMARIES } from './actions.js';
import { hasConstraints } from './constraints.js';
import { formatClock, round0 } from './util.js';
import { PRESETS } from './presets.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor({ world, chatLog, onJoin, onDemo, onClear, onSelect, onTogglePause }) {
    this.world = world;
    this.chatLog = chatLog;
    this.onJoin = onJoin;
    this.onSelect = onSelect;
    this.selectedId = null;
    this.lastLogLength = 0;

    this.el = {
      alive: $('stat-alive'),
      max: $('stat-max'),
      queue: $('stat-queue'),
      cooldown: $('stat-cooldown'),
      clock: $('stat-clock'),
      badge: $('badge-model'),
      pause: $('btn-pause'),
      form: $('join-form'),
      name: $('field-name'),
      prompt: $('field-prompt'),
      brain: $('field-brain'),
      preset: $('field-preset'),
      count: $('prompt-count'),
      brainNote: $('brain-note'),
      status: $('join-status'),
      roster: $('roster'),
      rosterCount: $('roster-count'),
      inspector: $('inspector'),
      log: $('log'),
      rules: $('rules'),
      tools: $('tools'),
      demo: $('btn-demo'),
      clear: $('btn-clear'),
      leaderboard: $('leaderboard'),
      chatlog: $('chatlog'),
      commsCount: $('comms-count'),
      commsStore: $('comms-store'),
      commsEmpty: $('comms-empty'),
      champions: $('champions'),

      focusEmpty: $('focus-empty'),
      focusBody: $('focus-body'),
      fbDot: $('fb-dot'),
      fbName: $('fb-name'),
      fbBrain: $('fb-brain'),
      fbHealth: $('fb-health'),
      fbHpFill: $('fb-hp-fill'),
      fbHpValue: $('fb-hp-value'),
      fbWeapons: $('fb-weapons'),
      fbAmmoLabel: $('fb-ammo-label'),
      fbPips: $('fb-pips'),
      fbReload: $('fb-reload'),
      fbKills: $('fb-kills'),
      fbAssists: $('fb-assists'),
      fbDeaths: $('fb-deaths'),
      fbDoing: $('fb-doing'),
    };

    // The focus bar redraws every frame, so it diffs against this.
    this.barState = {};
    this.buildWeaponSlots();

    // One stylesheet rule decides which side of the comms panel a message sits
    // on. Swapping its text restyles every matching message at once - no
    // per-row DOM work, however long the history gets.
    this.focusStyle = document.createElement('style');
    document.head.append(this.focusStyle);
    this.renderedChat = 0;

    if (this.chatLog) {
      this.chatLog.onChange(() => this.renderChat());
      this.renderChat();
    }

    this.el.max.textContent = String(WORLD.maxAgents);
    this.fillPresets();
    this.fillTools();
    this.fillRules();

    this.el.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const result = this.onJoin({
        name: this.el.name.value.trim(),
        prompt: this.el.prompt.value.trim(),
        brainKind: this.el.brain.value,
      });
      this.showStatus(result.message, result.tone);
      if (result.ok) {
        this.el.name.value = '';
        this.el.prompt.value = '';
        this.updateCount();
      }
    });

    this.el.prompt.addEventListener('input', () => this.updateCount());
    this.el.preset.addEventListener('change', () => {
      const preset = PRESETS.find((p) => p.name === this.el.preset.value);
      if (!preset) return;
      this.el.prompt.value = preset.prompt;
      if (!this.el.name.value) this.el.name.value = preset.name;
      this.updateCount();
      this.el.preset.value = '';
    });

    this.el.demo.addEventListener('click', () => onDemo());
    this.el.clear.addEventListener('click', () => onClear());
    this.el.pause.addEventListener('click', () => {
      const paused = onTogglePause();
      this.el.pause.textContent = paused ? 'Resume' : 'Pause';
    });

    for (const list of [this.el.roster, this.el.leaderboard]) {
      list.addEventListener('click', (event) => {
        const li = event.target.closest('li[data-id]');
        if (li) this.select(li.dataset.id);
      });
    }

    this.updateCount();
  }

  /** Three fixed loadout slots; the equipped one lights up. */
  buildWeaponSlots() {
    this.weaponSlots = new Map();
    this.el.fbWeapons.innerHTML = '';

    for (const weapon of Object.values(WEAPONS)) {
      const slot = document.createElement('span');
      slot.className = 'fb-weapon';
      slot.dataset.weapon = weapon.id;
      slot.style.setProperty('--weapon-color', weapon.color);
      slot.innerHTML =
        `<b>${weapon.id === 'pistol' ? 'P' : weapon.id === 'shotgun' ? 'SG' : 'AR'}</b>` +
        `<span>${escapeHtml(weapon.name)}</span>`;
      this.el.fbWeapons.append(slot);
      this.weaponSlots.set(weapon.id, slot);
    }
  }

  fillPresets() {
    for (const preset of PRESETS) {
      const option = document.createElement('option');
      option.value = preset.name;
      option.textContent = preset.name;
      this.el.preset.append(option);
    }
  }

  /**
   * The action surface, rendered from TOOL_SCHEMAS itself - argument names and
   * their allowed values come from the same definitions the agents are given,
   * so this panel cannot quietly fall out of date with the tools.
   */
  fillTools() {
    this.el.tools.innerHTML = TOOL_SCHEMAS.map((tool) => {
      const properties = tool.input_schema.properties ?? {};
      const args = Object.entries(properties)
        .map(([key, spec]) => (spec.enum ? `${key}: ${spec.enum.join('|')}` : key))
        .join(', ');
      const signature = `${tool.name}(${args})`;
      const summary = TOOL_SUMMARIES[tool.name] ?? tool.description.split('.')[0];
      return `<dt><code>${escapeHtml(signature)}</code></dt><dd>${escapeHtml(summary)}</dd>`;
    }).join('');
  }

  fillRules() {
    const rows = [
      ['Arena', `${WORLD.maxAgents} agents max, overflow waits in a queue`],
      ['Vision', `${VISION.fov}° cone, ${VISION.range} range, blocked by walls`],
      ['Body', `${MOVE.turnSpeed}°/s turn, ${MOVE.stepDistance}u steps, aim ±${MOVE.aimLimit}°`],
      ['Health', `${AGENT.maxHp} HP`],
      ...Object.values(WEAPONS).map((w) => [
        w.name,
        `${w.magazine} shots · ${w.timeBetweenShots}s between · ${w.reloadTime}s reload · ` +
          `${w.pellets > 1 ? `${w.pellets}×${w.damage}` : w.damage} dmg`,
      ]),
      ['Medkits', Object.values(HEALTH_PACKS).map((h) => `+${h.heal}`).join(' / ') + ' — bigger and brighter heals more'],
      ['Loot', `spawns every ${LOOT.spawnCooldown[0]}–${LOOT.spawnCooldown[1]}s, ${LOOT.maxOnGround} max on the floor`],
      ['Death', `${LOBBY.respawnCooldown}s before you may rejoin — ${LOBBY.congestedCooldown / 60} min if the arena is full and more than ${LOBBY.congestedQueueLength} are queued`],
    ];
    this.el.rules.innerHTML = rows
      .map(([term, def]) => `<dt>${term}</dt><dd>${def}</dd>`)
      .join('');
  }

  updateCount() {
    this.el.count.textContent = `${this.el.prompt.value.length} / 1200`;
  }

  showStatus(message, tone = '') {
    this.el.status.textContent = message ?? '';
    this.el.status.className = `form-note ${tone}`;
  }

  setModelBadge(state, detail, { compat = false, hint = null } = {}) {
    const badge = this.el.badge;
    const option = this.el.brain.querySelector('option[value="claude"]');
    if (option) option.textContent = compat ? 'Live model (via gateway)' : 'Claude (live)';

    // "Off" on its own tells a visitor nothing. Say what is running instead,
    // and what running the server would add.
    this.el.brainNote.hidden = !hint;
    if (hint) this.el.brainNote.innerHTML = hint;
    badge.textContent = detail;
    badge.className = `badge ${state}`;
    // Only offer the live brain when the server can actually reach the model.
    this.el.brain.querySelector('option[value="claude"]').disabled = state !== 'ok';
    if (state !== 'ok' && this.el.brain.value === 'claude') this.el.brain.value = 'local';
  }

  /** Clicking toggles: click the focused agent again to let go of it. */
  select(participantId) {
    this.selectedId = this.selectedId === participantId ? null : participantId;
    this.onSelect?.(this.selectedId);
  }

  /** Focus outright, without the toggle - used when an agent is deployed. */
  focus(participantId) {
    this.selectedId = participantId;
    this.onSelect?.(this.selectedId);
  }

  /** Point the single "mine" rule at whoever is focused. */
  applyChatFocus() {
    const id = this.selectedId;
    // Participant ids are generated as p<number>, so they need no escaping.
    this.focusStyle.textContent = id
      ? `.chatlog li[data-agent="${id}"] { align-self: flex-end; }
         .chatlog li[data-agent="${id}"] .who { text-align: right; }
         .chatlog li[data-agent="${id}"] .bubble {
           background: var(--accent); border-color: var(--accent);
           color: #05202e; border-radius: 12px 12px 3px 12px;
         }`
      : '';
  }

  selectByPoint(x, y) {
    let hit = null;
    for (const agent of this.world.agents) {
      if (Math.hypot(agent.x - x, agent.y - y) <= WORLD.agentRadius + 10) hit = agent;
    }
    this.selectedId = hit ? hit.participant.id : null;
    this.onSelect?.(this.selectedId);
  }

  // ------------------------------------------------------------------ render

  update() {
    const world = this.world;
    const participants = world.lobby.list();
    const alive = world.agents.filter((a) => a.alive);

    this.el.alive.textContent = String(alive.length);
    this.el.queue.textContent = String(world.lobby.queue.length);
    this.el.cooldown.textContent = String(participants.filter((p) => p.status === 'cooldown').length);
    const total = Math.floor(world.time);
    this.el.clock.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;

    this.renderRoster(participants);
    this.renderBoards();
    this.renderInspector();
    this.renderLog();
  }

  renderRoster(participants) {
    const ordered = [...participants].sort((a, b) => {
      const rank = (p) => (p.status === 'live' ? 0 : p.status === 'queued' ? 1 : 2);
      return rank(a) - rank(b) || b.kills - a.kills || a.joinedAt - b.joinedAt;
    });

    this.el.rosterCount.textContent = `${participants.length} total`;
    this.el.roster.innerHTML = ordered.map((p) => this.rosterRow(p)).join('') ||
      '<li class="waiting"><span></span><span class="muted">Nobody has entered yet.</span><span></span></li>';
  }

  rosterRow(p) {
    const color = AGENT_COLORS[p.colorIndex % AGENT_COLORS.length];
    const agent = p.agent;
    let sub;

    if (p.status === 'live' && agent) {
      const weapon = WEAPONS[agent.weapon];
      sub = `${weapon.name} ${agent.ammo}/${weapon.magazine}` +
        `${agent.reloadUntil > this.world.time ? ' · reloading' : ''}` +
        `${agent.thinking ? ' · thinking' : ''}`;
    } else if (p.status === 'queued') {
      const place = this.world.lobby.queuePosition(p.id);
      sub = place ? `waiting — #${place} in queue` : 'waiting';
    } else {
      sub = `dead — rejoins in ${formatClock(p.readyAt - this.world.time)}`;
    }

    const hp = agent ? Math.max(0, agent.hp / AGENT.maxHp) : 0;
    const hpColor = hp > 0.5 ? 'var(--good)' : hp > 0.25 ? 'var(--warn)' : 'var(--bad)';
    const brainTag = p.brainKind === 'claude' ? ' · Claude' : '';

    return `
      <li data-id="${p.id}" class="${p.status !== 'live' ? 'waiting' : ''} ${this.selectedId === p.id ? 'selected' : ''}">
        <span class="dot" style="background:${color}"></span>
        <span class="who">
          <span class="name">${escapeHtml(p.name)}</span>
          <div class="sub">${escapeHtml(sub)}${brainTag}</div>
          ${p.status === 'live' ? `<div class="hpbar"><i style="width:${hp * 100}%;background:${hpColor}"></i></div>` : ''}
        </span>
        <span class="kd">${p.kills}<span class="muted">K</span> ${p.deaths}<span class="muted">D</span></span>
      </li>`;
  }

  renderInspector() {
    const participant = this.selectedId ? this.world.lobby.get(this.selectedId) : null;
    if (!participant) {
      this.el.inspector.innerHTML = '<p class="muted">Select an agent to see its sensor feed.</p>';
      return;
    }

    const color = AGENT_COLORS[participant.colorIndex % AGENT_COLORS.length];
    const agent = participant.agent;
    const parts = [
      `<div class="who-line"><span class="dot" style="background:${color}"></span>${escapeHtml(participant.name)}
        <span class="muted" style="font-weight:400;font-size:12px">
          ${participant.brainKind === 'claude' ? 'Claude' : 'offline interpreter'} ·
          ${participant.kills}K / ${participant.deaths}D ·
          ${round0(participant.damageDealt)} dmg dealt · ${participant.decisions} decisions
        </span></div>`,
      `<blockquote class="prompt-quote">${escapeHtml(participant.prompt)}</blockquote>`,
    ];

    if (hasConstraints(participant.constraints)) {
      parts.push(
        `<div><span class="label">Hard rules from your prompt</span><div class="chips">` +
          participant.constraints.rules.map((r) => `<span class="chip rule">${escapeHtml(r)}</span>`).join('') +
          `</div></div>`,
      );
    }

    if (agent?.lastRefused?.length) {
      parts.push(
        `<div><span class="label">Refused last decision</span><div class="chips">` +
          agent.lastRefused.map((r) => `<span class="chip err">${escapeHtml(r)}</span>`).join('') +
          `</div></div>`,
      );
    }

    if (participant.lastError) {
      parts.push(`<div class="chips"><span class="chip err">${escapeHtml(participant.lastError)}</span></div>`);
    }

    if (agent) {
      if (agent.turn) {
        parts.push(
          `<div><span class="label">Its own memory</span><div>` +
            `Turn ${agent.turn} of this life · carrying ${agent.memoryDepth ?? 0} past exchange` +
            `${agent.memoryDepth === 1 ? '' : 's'}</div></div>`,
        );
      }
      if (agent.planResults?.length) {
        parts.push(
          `<div><span class="label">What its last moves achieved</span><div class="chips">` +
            agent.planResults.map((r) => `<span class="chip">${escapeHtml(r.outcome)}</span>`).join('') +
            `</div></div>`,
        );
      }
      if (agent.lastNote) parts.push(`<div><span class="label">Reasoning</span><div>${escapeHtml(agent.lastNote)}</div></div>`);
      const chips = (agent.lastActions ?? []).map((a) => `<span class="chip">${escapeHtml(a)}</span>`).join('');
      parts.push(`<div><span class="label">Last plan${agent.thinking ? ' (thinking…)' : ''}</span><div class="chips">${chips || '<span class="muted">—</span>'}</div></div>`);
      if (agent.lastSnapshot) {
        parts.push(`<div><span class="label">What it sees</span><pre>${escapeHtml(renderSnapshotText(agent.lastSnapshot))}</pre></div>`);
      }
    } else if (participant.status === 'cooldown') {
      parts.push(`<p class="muted">Eliminated. Rejoins in ${formatClock(participant.readyAt - this.world.time)}.</p>`);
    } else {
      const place = this.world.lobby.queuePosition(participant.id);
      parts.push(`<p class="muted">Waiting to enter${place ? ` — #${place} in queue` : ''}.</p>`);
    }

    this.el.inspector.innerHTML = parts.join('');
  }

  /**
   * The bar under the arena. Called every frame, because the action flashes are
   * short - so every write is diffed against the previous frame first.
   */
  renderFocusBar() {
    const participant = this.selectedId ? this.world.lobby.get(this.selectedId) : null;
    const agent = participant?.agent ?? null;
    const now = this.world.time;

    if (!participant) {
      if (this.barState.empty !== true) {
        this.el.focusEmpty.hidden = false;
        this.el.focusBody.hidden = true;
        this.barState = { empty: true };
      }
      return;
    }
    if (this.barState.empty !== false) {
      this.el.focusEmpty.hidden = true;
      this.el.focusBody.hidden = false;
      this.barState = { empty: false };
    }

    const set = (key, value, apply) => {
      if (this.barState[key] === value) return;
      this.barState[key] = value;
      apply(value);
    };
    // A pulse is "live" for PULSE.duration after the world stamped it.
    const firing = (kind) => Boolean(agent) && now - agent.pulses[kind] < PULSE.duration;

    const color = AGENT_COLORS[participant.colorIndex % AGENT_COLORS.length];
    set('color', color, (v) => { this.el.fbDot.style.background = v; });
    set('name', participant.name, (v) => { this.el.fbName.textContent = v; });
    set('brain', participant.brainKind === 'claude' ? 'live model' : 'offline', (v) => { this.el.fbBrain.textContent = v; });

    const hp = agent ? Math.max(0, Math.round(agent.hp)) : 0;
    set('hp', hp, (v) => {
      this.el.fbHpValue.textContent = `${v}`;
      this.el.fbHpFill.style.width = `${(v / AGENT.maxHp) * 100}%`;
      this.el.fbHpFill.style.background =
        v > AGENT.maxHp * 0.5 ? 'var(--good)' : v > AGENT.maxHp * 0.25 ? 'var(--warn)' : 'var(--bad)';
    });
    set('hurt', firing('hurt'), (v) => this.el.fbHealth.classList.toggle('flash-hurt', v));
    set('heal', firing('heal'), (v) => this.el.fbHealth.classList.toggle('flash-heal', v));

    const equipped = agent?.weapon ?? null;
    set('weapon', equipped, (v) => {
      for (const [id, slot] of this.weaponSlots) slot.classList.toggle('equipped', id === v);
    });
    // The equipped weapon flashes its border on every shot.
    set('fire', firing('fire') ? equipped : null, (v) => {
      for (const [id, slot] of this.weaponSlots) slot.classList.toggle('firing', id === v && v !== null);
    });
    set('pickup', firing('pickup') ? equipped : null, (v) => {
      for (const [id, slot] of this.weaponSlots) slot.classList.toggle('picked', id === v && v !== null);
    });

    const weapon = WEAPONS[equipped] ?? WEAPONS.pistol;
    const ammo = agent?.ammo ?? 0;
    set('ammo', `${ammo}/${weapon.magazine}`, () => {
      this.el.fbAmmoLabel.textContent = `Ammo ${ammo}/${weapon.magazine}`;
      this.el.fbPips.innerHTML = Array.from({ length: weapon.magazine }, (_, i) =>
        `<i class="${i < ammo ? 'live' : ''}" style="--weapon-color:${weapon.color}"></i>`).join('');
    });

    const reloading = agent && agent.reloadUntil > now;
    set('reload', reloading ? Math.ceil((agent.reloadUntil - now) * 10) : null, (v) => {
      this.el.fbReload.hidden = v === null;
      if (v !== null) this.el.fbReload.textContent = `Reloading ${(v / 10).toFixed(1)}s`;
      this.el.fbPips.classList.toggle('reloading', v !== null);
    });

    set('kills', participant.kills, (v) => { this.el.fbKills.querySelector('b').textContent = v; });
    set('assists', participant.assists ?? 0, (v) => { this.el.fbAssists.querySelector('b').textContent = v; });
    set('deaths', participant.deaths, (v) => { this.el.fbDeaths.querySelector('b').textContent = v; });
    set('killFlash', firing('kill'), (v) => this.el.fbKills.classList.toggle('flash-kill', v));

    let doing;
    if (!agent) {
      doing = participant.status === 'cooldown'
        ? `Eliminated — rejoins in ${formatClock(participant.readyAt - now)}`
        : 'Waiting to enter the arena';
    } else if (agent.thinking) {
      doing = 'Thinking…';
    } else {
      doing = describeCurrent(agent);
    }
    set('doing', doing, (v) => { this.el.fbDoing.textContent = v; });
  }

  renderBoards() {
    const live = this.world.agents
      .filter((a) => a.alive)
      .map((a) => a.participant)
      .sort((a, b) => b.kills - a.kills || (b.assists ?? 0) - (a.assists ?? 0) || a.name.localeCompare(b.name));

    this.el.leaderboard.innerHTML = live.length
      ? live.map((p, i) => {
          const color = AGENT_COLORS[p.colorIndex % AGENT_COLORS.length];
          return `<li class="${p.id === this.selectedId ? 'selected' : ''}" data-id="${p.id}">
            <span class="rank">${i + 1}</span>
            <span class="dot" style="background:${color}"></span>
            <span class="who"><span class="name">${escapeHtml(p.name)}</span></span>
            <span class="tally"><b>${p.kills}</b>K <b>${p.assists ?? 0}</b>A</span>
          </li>`;
        }).join('')
      : '<li class="empty muted">Nobody is in the arena.</li>';

    this.el.champions.innerHTML = this.world.champions.length
      ? this.world.champions.map((c, i) => `
          <li>
            <span class="rank">${i + 1}</span>
            <span class="dot" style="background:${c.color}"></span>
            <span class="who">
              <span class="name">${escapeHtml(c.name)}</span>
              <span class="sub">survived ${formatClock(c.survived)}</span>
            </span>
            <span class="tally"><b>${c.kills}</b>K <b>${c.assists}</b>A</span>
          </li>`).join('')
      : '<li class="empty muted">No lives have ended yet.</li>';
  }

  /**
   * Append-only: existing messages are never re-rendered, and a history that
   * scrolled off the ring is trimmed from the front.
   */
  renderChat() {
    const messages = this.chatLog.messages;
    this.el.commsEmpty.hidden = messages.length > 0;
    this.el.commsCount.textContent = messages.length ? `${messages.length}` : '';
    this.el.commsStore.textContent = this.chatLog.serverBacked
      ? `server · max ${this.chatLog.capacity}`
      : `this tab · max ${this.chatLog.capacity}`;

    // The store drops from the front when full; mirror that in the DOM.
    while (this.el.chatlog.children.length > messages.length) {
      this.el.chatlog.firstElementChild.remove();
    }

    const nearBottom =
      this.el.chatlog.scrollHeight - this.el.chatlog.scrollTop - this.el.chatlog.clientHeight < 60;

    for (let i = this.el.chatlog.children.length; i < messages.length; i++) {
      const message = messages[i];
      const row = document.createElement('li');
      row.dataset.agent = message.agentId;
      row.innerHTML =
        `<span class="who" style="color:${escapeHtml(message.color)}">${escapeHtml(message.name)}</span>` +
        `<span class="bubble">${escapeHtml(message.text)}</span>`;
      this.el.chatlog.append(row);
    }

    if (nearBottom) this.el.chatlog.scrollTop = this.el.chatlog.scrollHeight;
  }

  renderLog() {
    if (this.world.log.length === this.lastLogLength) return;
    this.lastLogLength = this.world.log.length;

    const recent = this.world.log.slice(-40).reverse();
    this.el.log.innerHTML = recent
      .map((entry) => {
        const t = Math.floor(entry.time);
        return `<li class="${entry.kind}"><span class="t">${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}</span>${escapeHtml(entry.text)}</li>`;
      })
      .join('');
  }
}

/** Plain-language summary of what an agent is doing right now. */
function describeCurrent(agent) {
  const action = agent.current;
  if (!action) return agent.lastActions?.[0] ? `Next: ${agent.lastActions[0]}` : 'Idle';
  switch (action.type) {
    case 'turn': return `Turning ${action.direction}`;
    case 'move': return action.direction === 'left' || action.direction === 'right'
      ? `Sidestepping ${action.direction}` : `Walking ${action.direction}`;
    case 'aim': return 'Adjusting aim';
    case 'fire': return `Firing (${action.remaining} left)`;
    case 'reload': return 'Reloading';
    case 'hold': return 'Holding';
    default: return action.type;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
