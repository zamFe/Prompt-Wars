// DOM wiring: the join form, roster, inspector, feed and rules panel.

import { WORLD, LOBBY, WEAPONS, HEALTH_PACKS, LOOT, VISION, MOVE, AGENT, AGENT_COLORS } from './config.js';
import { renderSnapshotText } from './sensors.js';
import { TOOL_SCHEMAS, TOOL_SUMMARIES } from './actions.js';
import { formatClock, round0 } from './util.js';
import { PRESETS } from './presets.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor({ world, onJoin, onDemo, onClear, onSelect, onTogglePause }) {
    this.world = world;
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
      status: $('join-status'),
      roster: $('roster'),
      rosterCount: $('roster-count'),
      inspector: $('inspector'),
      log: $('log'),
      rules: $('rules'),
      tools: $('tools'),
      demo: $('btn-demo'),
      clear: $('btn-clear'),
    };

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

    this.el.roster.addEventListener('click', (event) => {
      const li = event.target.closest('li[data-id]');
      if (li) this.select(li.dataset.id);
    });

    this.updateCount();
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

  setModelBadge(state, detail, { compat = false } = {}) {
    const badge = this.el.badge;
    const option = this.el.brain.querySelector('option[value="claude"]');
    if (option) option.textContent = compat ? 'Live model (via gateway)' : 'Claude (live)';
    badge.textContent = detail;
    badge.className = `badge ${state}`;
    // Only offer the live brain when the server can actually reach the model.
    this.el.brain.querySelector('option[value="claude"]').disabled = state !== 'ok';
    if (state !== 'ok' && this.el.brain.value === 'claude') this.el.brain.value = 'local';
  }

  select(participantId) {
    this.selectedId = this.selectedId === participantId ? null : participantId;
    this.onSelect?.(this.selectedId);
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

    if (participant.lastError) {
      parts.push(`<div class="chips"><span class="chip err">${escapeHtml(participant.lastError)}</span></div>`);
    }

    if (agent) {
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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
