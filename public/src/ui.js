// DOM wiring: the join form, roster, inspector, feed and rules panel.

import { WORLD, LOBBY, WEAPONS, HEALTH_PACKS, LOOT, VISION, MOVE, AGENT, AGENT_COLORS, PULSE, COMMS, TEAMS } from './config.js';
import { MODES, PHASES } from './match.js';
import { renderSnapshotText } from './sensors.js';
import { TOOL_SCHEMAS, TOOL_SUMMARIES } from './actions.js';
import { hasConstraints } from './constraints.js';
import { MODEL_TIERS, DEFAULT_TIER } from './brains/sample.js';
import { formatClock, round0 } from './util.js';
import { PRESETS } from './presets.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor({ world, match, chatLog, directLog, onJoin, onSelect, onTogglePause, onMessage, onSkipBrief, onEndRound, mySeat }) {
    this.world = world;
    this.match = match;
    // How a fighter is coloured on this page. main.js replaces this with the
    // mode- and viewer-aware rule once it knows who is looking.
    this.colorOf = (p) => AGENT_COLORS[(p?.colorIndex ?? 0) % AGENT_COLORS.length];
    this.chatLog = chatLog;
    this.directLog = directLog;
    this.onJoin = onJoin;
    this.onSelect = onSelect;
    this.onMessage = onMessage;
    this.mySeat = mySeat ?? (() => null);
    this.selectedId = null;
    this.lastLogLength = 0;
    // Which of the five rail views is on screen. Only this one is rendered.
    this.railTab = 'roster';
    this.directThreadId = null;

    this.el = {
      badge: $('badge-model'),
      end: $('btn-end'),
      pause: $('btn-pause'),
      form: $('join-form'),
      name: $('field-name'),
      prompt: $('field-prompt'),
      brain: $('field-brain'),
      preset: $('field-preset'),
      count: $('prompt-count'),
      brainNote: $('brain-note'),
      brainWhy: $('brain-why'),
      brainHint: $('brain-hint'),
      card: $('deploy-card'),
      summary: $('fighter-summary'),
      rewrite: $('btn-rewrite'),
      joinLate: $('btn-join-late'),
      hudLives: $('hud-lives'),
      tierRow: $('tier-row'),
      tierSelect: $('field-tier'),
      tierLock: $('tier-lock'),
      usage: $('usage'),
      usageFill: $('usage-fill'),
      usageValue: $('usage-value'),
      badgeRoom: $('badge-room'),
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
      commsTitle: $('comms-title'),
      commsCount: $('comms-count'),
      commsStore: $('comms-store'),
      commsEmpty: $('comms-empty'),
      champions: $('champions'),

      directlog: $('directlog'),
      directForm: $('direct-form'),
      directInput: $('direct-input'),
      directSend: $('direct-send'),
      directTarget: $('direct-target'),
      directEmpty: $('direct-empty'),
      directNote: $('direct-note'),
      railTabs: $('rail-tabs'),

      hud: $('hud'),
      hudMode: $('hud-mode'),
      hudScore: $('hud-score'),
      hudClock: $('hud-clock'),
      briefBanner: $('brief-banner'),
      briefClock: $('brief-clock'),
      briefCount: $('brief-count'),
      skipBrief: $('btn-skip-brief'),
      deployPhase: $('deploy-phase'),
      cardClock: $('card-clock'),

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

    this.railPanels = new Map(
      [...document.querySelectorAll('.rail-panel')].map((node) => [node.dataset.panel, node]),
    );
    this.railButtons = new Map(
      [...this.el.railTabs.querySelectorAll('button[data-tab]')].map((node) => [node.dataset.tab, node]),
    );
    this.el.railTabs.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-tab]');
      if (button) this.setRailTab(button.dataset.tab);
    });

    if (this.directLog) {
      this.directLog.onChange(() => this.renderDirect());
      this.el.directForm.addEventListener('submit', (event) => {
        event.preventDefault();
        this.sendDirect();
      });
      this.renderDirect();
    }

    this.fillPresets();
    this.fillTiers();
    this.fillTools();
    this.fillRules();

    this.el.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const result = this.onJoin({
        name: this.el.name.value.trim(),
        prompt: this.el.prompt.value.trim(),
        brainKind: this.el.brain.value,
        tier: this.tier,
      });
      this.showStatus(result.message, result.tone);
      if (result.ok) {
        // The prompt stays in the box: rewriting it in the briefing starts
        // from what you sent, not from nothing.
        this.editing = false;
        this.renderFighterCard();
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

    this.el.skipBrief.addEventListener('click', () => onSkipBrief?.());
    this.el.end.addEventListener('click', () => onEndRound?.());
    // The form is folded away while you have a fighter; these bring it back.
    this.el.rewrite.addEventListener('click', () => { this.editing = true; this.renderFighterCard(); });
    this.el.joinLate.addEventListener('click', () => { this.editing = true; this.renderFighterCard(); });
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

  /** The thinking tiers the runtime offers. Not model names - it has none. */
  fillTiers() {
    this.el.tierSelect.innerHTML = MODEL_TIERS
      .map((t) => `<option value="${t.id}">${escapeHtml(t.label)}</option>`)
      .join('');
    this.el.tierSelect.value = DEFAULT_TIER;
    this.el.tierSelect.addEventListener('change', () => this.describeBrain());
    this.el.brain.addEventListener('change', () => {
      this.chosenBrain = this.el.brain.value;
      this.syncTierRow();
    });
    this.describeBrain();
  }

  /**
   * One short line under the brain picker, and only when it says something
   * the picker does not: how a tier thinks, or what offline means when you
   * could have had Claude.
   */
  describeBrain() {
    const brain = this.el.brain.value;
    const tier = MODEL_TIERS.find((t) => t.id === this.el.tierSelect.value);
    const claudeAround = !this.el.brain.querySelector('option[value="sample"]').hidden ||
      !this.el.brain.querySelector('option[value="claude"]').hidden;

    const line = brain === 'local'
      ? claudeAround ? 'Reads your prompt for intent with no Claude calls. Cheaper, and much less clever.' : ''
      : tier?.note ?? '';
    this.el.brainHint.textContent = line;
    this.el.brainHint.hidden = !line;
  }

  /** The tier only applies to a brain that actually calls Claude. */
  syncTierRow() {
    const usesClaude = this.el.brain.value === 'sample' || this.el.brain.value === 'claude';
    this.el.tierRow.hidden = !usesClaude;
    this.describeBrain();
    this.lockTierIfDeployed();
  }

  /**
   * A character's tier is fixed for its life: it is baked into a conversation
   * that is already running, so switching mid-fight would be incoherent.
   */
  lockTierIfDeployed() {
    const mine = this.world.lobby.list().some((p) => p.isMine && p.status !== 'gone');
    this.el.tierSelect.disabled = mine;
    this.el.tierLock.textContent = mine ? 'locked while you are in the arena' : '';
  }

  get tier() {
    return this.el.tierSelect.value || DEFAULT_TIER;
  }

  /**
   * An artifact has levels, and they are not cosmetic: the platform itself
   * refuses an admin-only room message from anyone below Editor. So the
   * controls that change the shared arena are shown to the people who can
   * actually use them, and the rest are told where they stand.
   */
  setRole({ isOwner, canEdit, known }) {
    this.role = { isOwner, canEdit, known };
    this.renderMatch();
  }

  /** What this page has spent of the viewer's Claude account. */
  renderUsage(state) {
    if (!state) {
      this.el.usage.hidden = true;
      return;
    }
    this.el.usage.hidden = false;
    const percent = Math.round(state.fraction * 100);
    this.el.usageFill.style.width = `${percent}%`;
    this.el.usageValue.textContent = `${percent}%`;
    this.el.usage.classList.toggle('warn', state.fraction >= 0.7 && !state.exhausted);
    this.el.usage.classList.toggle('full', state.exhausted || state.rateLimited);
    this.el.usage.title = state.rateLimited
      ? 'Your Claude account hit its own limit — agents fell back to the offline brain.'
      : `${state.calls} of ${state.budget} calls this session (quick ${state.byTier.quick}, balanced ${state.byTier.default}, deep ${state.byTier.complex}). ` +
        'This counts what this page asked for, not your account balance.';
  }

  renderRoom(state) {
    const badge = this.el.badgeRoom;
    if (!state?.available) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    const others = Math.max(0, state.peers - 1);
    badge.textContent = state.canSend === false
      ? `${state.peers} here · watching`
      : others === 0
        ? 'solo'
        : `${state.peers} here · ${state.isHost ? 'hosting' : 'guest'}`;
    badge.classList.toggle('live', others > 0);

    // At Viewer level the platform refuses everything this page would send,
    // so the deploy form would only ever fail silently. Say so instead.
    const watching = state.canSend === false;
    this.el.form.querySelector('button[type=submit]').disabled = watching;
    if (watching) {
      this.showStatus('You are here as a Viewer: you can watch, but deploying a fighter needs Contributor access. Ask the owner to raise it from the Share menu.', 'warn');
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

  /**
   * What thinks for your fighter, decided once from everything known.
   *
   * There are two ways to reach Claude - your own account, inside an artifact,
   * and a server holding a key - and they report in at different times. They
   * used to each write the badge as they arrived, so whichever answered LAST
   * won: inside the artifact a failed server probe could land after Claude had
   * already reported in, and replace "Claude · your account" with a paragraph
   * about running a server. Now both feed one state and the badge is derived.
   *
   * @param sample  true / false once known, null while still asking
   * @param server  { ready, model, compat, hint } once known, null while asking
   */
  setModelStatus({ sample = null, server = null } = {}) {
    const brainSample = this.el.brain.querySelector('option[value="sample"]');
    const brainServer = this.el.brain.querySelector('option[value="claude"]');

    // An option that cannot work is not offered at all, rather than shown
    // greyed out with an explanation nobody asked for.
    brainSample.hidden = sample !== true;
    brainServer.hidden = !server?.ready;
    brainServer.textContent = server?.compat ? `Model (${server.model})` : 'Claude (server)';

    const best = sample === true ? 'sample' : server?.ready ? 'claude' : 'local';
    const current = this.el.brain.value;
    if (this.el.brain.querySelector(`option[value="${current}"]`).hidden || this.chosenBrain === undefined) {
      this.el.brain.value = best;
    }

    const badge = this.el.badge;
    if (sample === true) {
      badge.textContent = 'Claude · your account';
      badge.className = 'badge ok';
    } else if (server?.ready) {
      badge.textContent = server.compat ? `Model · ${server.model}` : `Claude · ${server.model}`;
      badge.className = 'badge ok';
    } else if (sample === null && server === null) {
      badge.textContent = 'Checking for Claude…';
      badge.className = 'badge';
    } else {
      badge.textContent = 'Offline brain';
      badge.className = 'badge off';
    }

    // The long explanation only exists for the case it explains - nothing but
    // the offline brain on offer - and it is folded away even then.
    const offlineOnly = sample !== true && !server?.ready && (sample !== null || server !== null);
    this.el.brainWhy.hidden = !offlineOnly || !server?.hint;
    if (server?.hint) this.el.brainNote.innerHTML = server.hint;
    this.el.brain.disabled = best === 'local' && offlineOnly;
    this.syncTierRow();
  }

  /** Clicking toggles: click the focused agent again to let go of it. */
  select(participantId) {
    this.selectedId = this.selectedId === participantId ? null : participantId;
    // Asking to look at an agent is asking to see what it sees.
    if (this.selectedId) this.setRailTab('agent');
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
    if (this.selectedId) this.setRailTab('agent');
    this.onSelect?.(this.selectedId);
  }

  // ------------------------------------------------------------------ render

  update() {
    const world = this.world;
    const participants = world.lobby.list();

    this.lockTierIfDeployed();
    this.renderFighterCard();
    this.renderRail(participants);
    this.syncDirect();
  }

  /**
   * The rail shows one view at a time, so only that one is rendered - the
   * four behind it cost nothing until you open them.
   */
  renderRail(participants) {
    this.el.rosterCount.textContent = participants.length ? `${participants.length}` : '';

    switch (this.railTab) {
      case 'roster': return this.renderRoster(participants);
      case 'board': return this.renderLeaderboard();
      case 'champs': return this.renderChampions();
      case 'agent': return this.renderInspector();
      case 'feed': return this.renderLog();
      default: return undefined;
    }
  }

  setRailTab(name) {
    if (!this.railPanels.has(name) || name === this.railTab) return;
    this.railTab = name;
    for (const [key, node] of this.railPanels) node.hidden = key !== name;
    for (const [key, node] of this.railButtons) node.setAttribute('aria-selected', String(key === name));
    // A panel coming back on screen has to redraw even if nothing changed.
    this.lastLogLength = -1;
    this.update();
  }

  renderRoster(participants) {
    const ordered = [...participants].sort((a, b) => {
      const rank = (p) => (p.status === 'live' ? 0 : p.status === 'queued' ? 1 : 2);
      return rank(a) - rank(b) || b.kills - a.kills || a.joinedAt - b.joinedAt;
    });

    this.el.roster.innerHTML = ordered.map((p) => this.rosterRow(p)).join('') ||
      '<li class="waiting"><span></span><span class="muted">Nobody has entered yet.</span><span></span></li>';
  }

  rosterRow(p) {
    const color = this.colorOf(p);
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
    } else if (p.status === 'eliminated') {
      sub = 'out of lives — spectating';
    } else {
      sub = `down — back in ${formatClock(p.readyAt - this.world.time)}`;
    }

    const lives = Number.isFinite(p.livesLeft) ? ` · ${p.livesLeft} ${p.livesLeft === 1 ? 'life' : 'lives'}` : '';
    sub += lives;
    // In commander mode the name is a call-sign, so say whose it is. A
    // commander is marked on its name, where truncation cannot reach it.
    if (p.role === 'squad' && p.commanderName) sub += ` · ${p.commanderName}'s`;

    const hp = agent ? Math.max(0, agent.hp / AGENT.maxHp) : 0;
    const hpColor = hp > 0.5 ? 'var(--good)' : hp > 0.25 ? 'var(--warn)' : 'var(--bad)';
    const brainTag = { sample: ' · Claude', claude: ' · Claude', remote: ' · remote' }[p.brainKind] ?? '';

    const teamRing = p.team && TEAMS[p.team] ? `box-shadow:0 0 0 2px ${TEAMS[p.team].color}` : '';
    return `
      <li data-id="${p.id}" class="${p.status !== 'live' ? 'waiting' : ''} ${this.selectedId === p.id ? 'selected' : ''}">
        <span class="dot" style="background:${color};${teamRing}"></span>
        <span class="who">
          <span class="name">${p.role === 'commander' ? '<span class="star" title="Commander">★</span> ' : ''}${escapeHtml(p.name)}</span>
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

    const color = this.colorOf(participant);
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

    // What you have changed since. These outrank the orders above, so they are
    // shown as what they are rather than folded into the original prompt.
    if (participant.amendments?.length) {
      parts.push(
        `<div><span class="label">Orders you changed since</span><ol class="amendments">` +
          participant.amendments.map((line) => `<li>${escapeHtml(line)}</li>`).join('') +
          `</ol></div>`,
      );
    }

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

  /** This viewer's own fighter, if they have one in this round. */
  get myFighter() {
    const mine = this.world.lobby.list().filter((p) => p.isMine && p.status !== 'gone');
    return mine.sort((a, b) => b.joinedAt - a.joinedAt)[0] ?? null;
  }

  /**
   * The fighter card. The form takes the space only while filling it in is
   * the thing to do; the rest of the time this is a two-line summary, and the
   * conversation with your fighter happens in Agent chat.
   */
  renderFighterCard() {
    const match = this.match;
    if (!match) return;
    const phase = match.phase;
    const seat = match.seats[this.mySeat()] ?? null;
    const mine = this.myFighter;
    const briefing = phase === PHASES.briefing;
    const live = phase === PHASES.live;

    const entered = phase !== this.cardPhase;
    if (entered) {
      this.cardPhase = phase;
      this.editing = false;
    }

    let state;
    if (!seat?.side) state = 'spectating';
    else if (this.editing) state = 'form';
    else if (!mine) state = live ? 'late' : 'form';
    else state = briefing ? 'ready' : 'fighting';

    // The phase is part of the key: the form looks the same in the lobby and
    // the briefing, but its labels do not.
    const key = `${phase}:${state}:${mine?.id ?? ''}:${mine?.status ?? ''}:${mine?.livesLeft ?? ''}:${this.colorOf(mine ?? {})}`;
    if (key === this.cardKey) return;
    this.cardKey = key;

    // The clock starting is the cue to write, so the cursor goes where the
    // writing happens - which on a narrow screen also scrolls it into view.
    if (entered && briefing && state === 'form') {
      const field = this.el.name.value.trim() ? this.el.prompt : this.el.name;
      requestAnimationFrame(() => field.focus());
    }

    this.el.card.dataset.state = state;
    this.el.form.hidden = state !== 'form';
    this.el.rewrite.hidden = state !== 'ready';
    this.el.joinLate.hidden = state !== 'late';
    this.el.summary.hidden = state === 'form';
    this.el.deployPhase.textContent = {
      form: briefing ? 'write it now' : 'join mid-round',
      ready: 'ready',
      fighting: 'in the round',
      late: '',
      spectating: 'spectating',
    }[state];
    this.el.form.querySelector('button[type=submit]').textContent = briefing ? 'Ready' : mine ? 'Send the new prompt' : 'Join mid-round';

    if (state === 'spectating') {
      this.el.summary.innerHTML = '<p class="muted">You are spectating this round. Pick a side in the lobby to play the next one.</p>';
      return;
    }
    if (state === 'late') {
      this.el.summary.innerHTML = '<p class="muted">You have no fighter in this round yet.</p>';
      return;
    }
    if (!mine) return;

    const brain = { sample: 'Claude', claude: 'Claude (server)', remote: 'Claude', local: 'offline interpreter' }[mine.brainKind] ?? 'offline';
    const tier = mine.brainKind === 'sample' || mine.brainKind === 'claude'
      ? ` · ${MODEL_TIERS.find((t) => t.id === mine.tier)?.label.toLowerCase() ?? 'quick'}`
      : '';
    const lives = Number.isFinite(mine.livesLeft) && live
      ? ` · ${mine.livesLeft} ${mine.livesLeft === 1 ? 'life' : 'lives'} left`
      : '';
    const status = briefing
      ? 'Ready. It goes in when the clock runs out.'
      : mine.status === 'eliminated'
        ? 'Out of lives — watching the rest.'
        : mine.status === 'cooldown'
          ? 'Down — back in a moment.'
          : 'In the arena. Talk to it in Agent chat.';

    this.el.summary.innerHTML = `
      <div class="fs-who"><i style="background:${this.colorOf(mine)}"></i><b>${escapeHtml(mine.name)}</b>
        <span class="muted">${escapeHtml(brain)}${tier}${lives}</span></div>
      <p class="fs-status">${escapeHtml(status)}</p>`;
  }

  /**
   * The strip over the arena: what is being played, how it stands, and how long
   * is left. Diffed like the focus bar, because it is written every frame.
   */
  renderMatch() {
    const match = this.match;
    if (!match) return;

    this.hudState ??= {};
    const set = (key, value, apply) => {
      if (this.hudState[key] === value) return;
      this.hudState[key] = value;
      apply(value);
    };

    const phase = match.phase;
    const mode = MODES[match.settings.mode] ?? MODES.ffa;
    const briefing = phase === PHASES.briefing;

    set('phase', `${phase}:${this.role?.canEdit}`, () => {
      this.el.briefBanner.hidden = !briefing;
      this.el.hud.hidden = briefing;
      this.el.end.hidden = !(this.role?.canEdit && phase === PHASES.live);
      this.el.skipBrief.hidden = !this.role?.canEdit;
      this.renderFighterCard();
    });

    // Your lives sit next to the clock: the two numbers that decide what you
    // can still afford to do.
    const mine = this.myFighter;
    const lives = phase === PHASES.live && mine && Number.isFinite(mine.livesLeft) ? mine.livesLeft : null;
    set('lives', lives, (v) => {
      this.el.hudLives.hidden = v === null;
      if (v !== null) {
        this.el.hudLives.textContent = v === 0 ? 'out' : '♥'.repeat(Math.min(v, 10));
        this.el.hudLives.title = `${v} ${v === 1 ? 'life' : 'lives'} left`;
      }
    });

    const left = match.remaining;
    if (briefing) {
      set('brief', left === null ? null : Math.ceil(left), (v) => {
        this.el.briefClock.textContent = v === null ? '—' : `${v}`;
        this.el.cardClock.textContent = v === null ? '' : formatMatchClock(v);
        this.el.cardClock.classList.toggle('urgent', v !== null && v <= 10);
      });
      const waiting = this.world.lobby.list().length;
      set('briefCount', waiting, (v) => {
        this.el.briefCount.textContent = v === 1 ? '1 fighter ready.' : `${v} fighters ready.`;
      });
      return;
    }

    set('mode', `${mode.name}`, (v) => { this.el.hudMode.textContent = v; });
    set('clock', left === null ? null : Math.ceil(left), (v) => {
      this.el.hudClock.textContent = v === null ? '—' : formatMatchClock(v);
      this.el.hudClock.classList.toggle('urgent', v !== null && v <= 30);
    });

    if (match.isTeamMode) {
      const scores = match.scores;
      set('score', `${scores.a}:${scores.b}`, () => {
        this.el.hudScore.innerHTML = ['a', 'b'].map((team) => {
          const lead = scores[team] > scores[team === 'a' ? 'b' : 'a'];
          return `<span class="hud-team ${lead ? 'leading' : ''}" style="color:${TEAMS[team].color}">
              <i style="background:${TEAMS[team].color}"></i>${scores[team]}</span>`;
        }).join('<span class="hud-sep">—</span>');
      });
      return;
    }

    // Free-for-all has no team score, so the strip carries the leader instead.
    const live = this.world.agents.map((a) => a.participant);
    const leader = live.sort((a, b) => b.kills - a.kills)[0] ?? null;
    set('leader', leader ? `${leader.name}:${leader.kills}` : '', () => {
      this.el.hudScore.innerHTML = leader
        ? `<span class="hud-lead">leader <b>${escapeHtml(leader.name)}</b> ${leader.kills} ${mode.scoreWord}</span>`
        : '<span class="hud-lead">nobody has scored</span>';
    });
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

    const color = this.colorOf(participant);
    set('color', color, (v) => { this.el.fbDot.style.background = v; });
    set('name', participant.name, (v) => { this.el.fbName.textContent = v; });
    const brainLabel = { sample: 'your account', claude: 'server', remote: 'their account', local: 'offline' };
    set('brain', brainLabel[participant.brainKind] ?? 'offline', (v) => { this.el.fbBrain.textContent = v; });

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

  renderLeaderboard() {
    const live = this.world.agents
      .filter((a) => a.alive)
      .map((a) => a.participant)
      .sort((a, b) => b.kills - a.kills || (b.assists ?? 0) - (a.assists ?? 0) || a.name.localeCompare(b.name));

    this.el.leaderboard.innerHTML = live.length
      ? live.map((p, i) => {
          const color = this.colorOf(p);
          return `<li class="${p.id === this.selectedId ? 'selected' : ''}" data-id="${p.id}">
            <span class="rank">${i + 1}</span>
            <span class="dot" style="background:${color}"></span>
            <span class="who"><span class="name">${escapeHtml(p.name)}</span></span>
            <span class="tally"><b>${p.kills}</b>K <b>${p.assists ?? 0}</b>A</span>
          </li>`;
        }).join('')
      : '<li class="empty muted">Nobody is in the arena.</li>';
  }

  renderChampions() {
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

  // ------------------------------------------------------- the private channel

  /**
   * Who the agent-chat card is talking to: the focused agent when it is one of
   * yours, otherwise the last one you deployed. There is no channel to somebody
   * else's fighter - theirs answers on their page, paid for by their account.
   */
  get directTarget() {
    const focused = this.selectedId ? this.world.lobby.get(this.selectedId) : null;
    if (focused?.isMine) return focused;
    const mine = this.world.lobby.list().filter((p) => p.isMine);
    return mine.sort((a, b) => b.joinedAt - a.joinedAt)[0] ?? null;
  }

  sendDirect() {
    const target = this.directTarget;
    const text = this.el.directInput.value.trim();
    if (!target || !text) return;

    // main.js owns the delivery: it files the message and pokes the agent.
    const line = this.onMessage?.(target, text);
    if (!line) return;
    this.el.directInput.value = '';
    this.renderDirect();
  }

  /** The cheap part of the card: whose channel it is, and what is pending. */
  syncDirect() {
    if (!this.directLog) return;
    const target = this.directTarget;

    // `null` and `undefined` must compare equal here, or a card with nobody to
    // talk to would rebuild itself forever.
    if ((target?.id ?? null) !== this.directThreadId) {
      this.renderDirect();
      return;
    }

    const waiting = target?.inbox?.length ?? 0;
    const note = !target
      ? 'Deploy an agent and this becomes a channel to it.'
      : target.agent?.thinking && waiting
        ? `${target.name} is reading it now…`
        : waiting
          ? `${waiting} message${waiting === 1 ? '' : 's'} waiting for ${target.name}'s next decision.`
          : target.status === 'live'
            ? `Private line to ${target.name}. Nobody else can see it.`
            : target.status === 'cooldown'
              ? `${target.name} is out of the arena — it reads this when it respawns.`
              : `${target.name} is waiting to enter — it reads this when it spawns.`;

    if (this.directNoteText !== note) {
      this.directNoteText = note;
      this.el.directNote.textContent = note;
    }
  }

  /**
   * One thread at a time. Switching agents rebuilds the list; otherwise this is
   * append-only, exactly like the global log.
   */
  renderDirect() {
    if (!this.directLog) return;
    const target = this.directTarget;
    const id = target?.id ?? null;
    const thread = this.directLog.forAgent(id);

    this.el.directTarget.textContent = target ? `with ${target.name}` : 'nobody deployed';
    this.el.directInput.disabled = !target;
    this.el.directSend.disabled = !target;
    this.el.directInput.placeholder = target
      ? `Message ${target.name}…`
      : 'Deploy an agent to talk to it';
    this.el.directInput.maxLength = COMMS.messageLength;
    this.el.directEmpty.hidden = thread.length > 0;
    this.el.directEmpty.textContent = target
      ? `Say something to ${target.name}. It answers here, and only you two can see this.`
      : 'Deploy a fighter, then talk to it here. Only you two can see this.';

    if (id !== this.directThreadId) {
      this.directThreadId = id;
      this.el.directlog.innerHTML = '';
    }

    // The store drops from the front when full; mirror that in the DOM.
    while (this.el.directlog.children.length > thread.length) {
      this.el.directlog.firstElementChild.remove();
    }

    const nearBottom =
      this.el.directlog.scrollHeight - this.el.directlog.scrollTop - this.el.directlog.clientHeight < 60;

    for (let i = this.el.directlog.children.length; i < thread.length; i++) {
      const message = thread[i];
      const row = document.createElement('li');
      row.className = message.side === 'you' ? 'from-you' : 'from-agent';
      const who = message.side === 'you' ? 'You' : message.name;
      const color = message.side === 'you' ? 'var(--accent)' : message.color ?? 'var(--text)';
      row.innerHTML =
        `<span class="who" style="color:${escapeHtml(color)}">${escapeHtml(who)}</span>` +
        `<span class="bubble">${escapeHtml(message.text)}</span>`;
      this.el.directlog.append(row);
    }

    if (nearBottom) this.el.directlog.scrollTop = this.el.directlog.scrollHeight;
    this.directNoteText = null;
    this.syncDirect();
  }

  /**
   * Append-only: existing messages are never re-rendered, and a history that
   * scrolled off the ring is trimmed from the front.
   */
  /** The side whose channel this page is reading, in a mode that has them. */
  get myTeam() {
    const mine = this.world.lobby.list().filter((p) => p.isMine && p.team);
    return mine.sort((a, b) => b.joinedAt - a.joinedAt)[0]?.team ?? null;
  }

  renderChat() {
    const mode = this.match ? MODES[this.match.settings.mode] : null;
    const team = mode?.teamChat ? this.myTeam : null;

    // A channel change rebuilds the list; within a channel it stays append-only.
    const channel = `${mode?.teamChat ? 'team' : 'all'}:${team ?? ''}`;
    if (channel !== this.chatChannel) {
      this.chatChannel = channel;
      this.el.chatlog.innerHTML = '';
      this.el.commsTitle.textContent = mode?.teamChat ? 'Team chat' : 'Global chat';
      this.el.commsEmpty.textContent = mode?.teamChat
        ? team
          ? `Only ${TEAMS[team].name} can read this. The other side has its own.`
          : 'Each side has its own channel. Deploy a commander to read one.'
        : 'Agents call out when something happens. Nothing yet.';
    }

    const messages = team
      ? this.chatLog.messages.filter((m) => m.team === team)
      : this.chatLog.messages;
    this.el.commsEmpty.hidden = messages.length > 0;
    this.el.commsCount.textContent = messages.length ? `${messages.length}` : '';
    this.el.commsStore.textContent = this.chatLog.serverBacked
      ? `server · max ${this.chatLog.capacity}`
      : `this tab · max ${this.chatLog.capacity}`;
    this.el.commsCount.classList.toggle('team', Boolean(team));

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

/** mm:ss, for a countdown rather than an elapsed clock. */
function formatMatchClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
