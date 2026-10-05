// The three screens that are not the arena: the title card, the lobby, and the
// post-game report.
//
// They are kept out of ui.js because they belong to different moments. ui.js
// drives a running round at frame rate; this file draws a handful of times when
// something actually changes, and never while a round is being fought.

import { MODE_LIST, MODES, PHASES } from './match.js';
import { MAPS } from './arena.js';
import { TEAMS, AGENT_COLORS } from './config.js';
import { formatClock } from './util.js';

const byId = (id) => document.getElementById(id);

export function createScreens({
  world,
  match,
  onConfigure = () => {},
  onAddBot = () => {},
  onClearLobby = () => {},
  onStart = () => {},
  onReturn = () => {},
  onSetTeam = () => {},
}) {
  const el = {
    body: document.body,
    landing: byId('screen-landing'),
    lobbySub: byId('lobby-sub'),
    lobbyRoom: byId('lobby-room'),
    modeCards: byId('mode-cards'),
    mapCards: byId('map-cards'),
    round: byId('set-round'),
    roundValue: byId('set-round-value'),
    brief: byId('set-brief'),
    briefValue: byId('set-brief-value'),
    lives: byId('set-lives'),
    livesValue: byId('set-lives-value'),
    livesNote: byId('lives-note'),
    teamColumns: byId('team-columns'),
    lobbyCount: byId('lobby-count'),
    lobbyActions: byId('lobby-actions'),
    lobbyRoleNote: byId('lobby-role-note'),
    lobbyHint: byId('lobby-hint'),
    start: byId('btn-start'),
    addBot: byId('btn-add-bot'),
    clear: byId('btn-lobby-clear'),
    postTitle: byId('post-title'),
    postSub: byId('post-sub'),
    podium: byId('podium'),
    speech: byId('speech'),
    speechWho: byId('speech-who'),
    speechText: byId('speech-text'),
    scoreboard: byId('scoreboard'),
    notable: byId('notable'),
    postHint: byId('post-hint'),
    returnBtn: byId('btn-return'),
  };

  let role = { canEdit: true, known: false };
  let room = null;

  // --- the title card: anything at all moves on ------------------------------
  const leaveLanding = () => {
    if (match.phase !== PHASES.landing) return;
    onStartPressed();
  };
  const onStartPressed = () => {
    match.begin();
    api.render();
  };
  // "Any press or click" means any: a key, a tap, a click anywhere on the page.
  // Each handler checks the phase itself, so they cost nothing afterwards.
  window.addEventListener('keydown', leaveLanding);
  window.addEventListener('pointerdown', leaveLanding);

  // --- lobby controls --------------------------------------------------------
  el.modeCards.innerHTML = MODE_LIST
    .map((mode) => `<button type="button" class="pick" data-mode="${mode.id}" aria-pressed="false">
        <b>${esc(mode.name)}</b><span>${esc(mode.blurb)}</span></button>`)
    .join('');
  el.mapCards.innerHTML = MAPS
    .map((map) => `<button type="button" class="pick" data-map="${map.id}" aria-pressed="false">
        <b>${esc(map.name)}</b><span>${esc(map.blurb)}</span></button>`)
    .join('');

  el.modeCards.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (button && role.canEdit) onConfigure({ mode: button.dataset.mode });
  });
  el.mapCards.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-map]');
    if (button && role.canEdit) onConfigure({ map: button.dataset.map });
  });

  // Sliders report while dragging and commit on release, so a drag does not
  // broadcast thirty settings changes to everyone in the room.
  const slider = (input, read) => {
    input.addEventListener('input', () => api.previewSettings());
    input.addEventListener('change', () => onConfigure(read()));
  };
  slider(el.round, () => ({ roundSeconds: Number(el.round.value) * 60 }));
  slider(el.brief, () => ({ briefSeconds: Number(el.brief.value) }));
  slider(el.lives, () => ({ lives: Number(el.lives.value) }));

  el.addBot.addEventListener('click', () => onAddBot());
  el.clear.addEventListener('click', () => onClearLobby());
  el.start.addEventListener('click', () => onStart());
  el.returnBtn.addEventListener('click', () => onReturn());

  el.teamColumns.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-swap]');
    if (button && role.canEdit) onSetTeam(button.dataset.swap, button.dataset.team);
  });

  const api = {
    setRole(next) {
      role = next;
      api.render();
    },

    setRoom(state) {
      room = state;
      api.renderLobby();
    },

    /** Live feedback while a slider is being dragged, before it commits. */
    previewSettings() {
      const minutesValue = Number(el.round.value);
      el.roundValue.textContent = `${minutesValue} min`;
      el.briefValue.textContent = `${el.brief.value}s`;
      const lives = Number(el.lives.value);
      el.livesValue.textContent = lives === 0 ? 'endless' : `${lives}`;
      el.livesNote.textContent = lives === 0
        ? 'Nobody is ever out: the arena runs on the open drop-in timers instead, and a round ends on the clock.'
        : `Lose ${lives} ${lives === 1 ? 'life' : 'lives'} and you spectate the rest of the round.`;
    },

    render() {
      el.body.dataset.phase = match.phase;
      if (match.phase === PHASES.lobby) api.renderLobby();
      if (match.phase === PHASES.postgame) api.renderPostgame();
    },

    renderLobby() {
      const settings = match.settings;

      for (const button of el.modeCards.querySelectorAll('button[data-mode]')) {
        button.setAttribute('aria-pressed', String(button.dataset.mode === settings.mode));
        button.disabled = !role.canEdit;
      }
      for (const button of el.mapCards.querySelectorAll('button[data-map]')) {
        button.setAttribute('aria-pressed', String(button.dataset.map === settings.map));
        button.disabled = !role.canEdit;
      }

      el.round.value = String(Math.round(settings.roundSeconds / 60));
      el.brief.value = String(settings.briefSeconds);
      el.lives.value = String(settings.lives);
      for (const input of [el.round, el.brief, el.lives]) input.disabled = !role.canEdit;
      api.previewSettings();

      api.renderRoster();

      el.lobbyActions.hidden = !role.canEdit;
      el.start.hidden = !role.canEdit;
      el.lobbyRoleNote.hidden = !role.known || role.canEdit;
      el.lobbyRoleNote.innerHTML = 'The owner sets the game up and starts it. ' +
        'You write your own fighter’s prompt once the round begins.';

      const fighters = world.lobby.list().length;
      el.start.disabled = fighters === 0;
      el.lobbyHint.textContent = !role.canEdit
        ? 'Waiting for the owner to start the round…'
        : fighters === 0
          ? 'Add a bot, or just start — everyone writes a prompt in the next minute either way.'
          : `${MODES[settings.mode].name} on ${MAPS.find((m) => m.id === settings.map)?.name}, ` +
            `${minutes(settings.roundSeconds)}.`;

      if (room?.available) {
        const others = Math.max(0, room.peers - 1);
        el.lobbyRoom.hidden = false;
        el.lobbyRoom.textContent = others === 0 ? 'solo' : `${room.peers} here`;
        el.lobbyRoom.classList.toggle('live', others > 0);
      } else {
        el.lobbyRoom.hidden = true;
      }
    },

    renderRoster() {
      const everyone = world.lobby.list();
      el.lobbyCount.textContent = everyone.length ? `${everyone.length} in` : 'nobody yet';

      const row = (p) => {
        const color = AGENT_COLORS[p.colorIndex % AGENT_COLORS.length];
        const tag = p.isMine ? 'yours' : p.brainKind === 'local' ? 'bot' : 'theirs';
        const swap = match.isTeamMode && role.canEdit
          ? `<button class="swap" data-swap="${p.id}" data-team="${p.team === 'a' ? 'b' : 'a'}" title="Move to the other side">&#8644;</button>`
          : '<span></span>';
        return `<li class="${p.isMine ? 'mine' : ''}">
            <i class="dot" style="background:${color}"></i>
            <span class="who"><span class="name">${esc(p.name)}</span></span>
            <span class="tag">${tag}</span>${swap}</li>`;
      };

      if (!match.isTeamMode) {
        el.teamColumns.innerHTML = `<div class="team-col solo"><ul>${
          everyone.map(row).join('') || '<li class="empty">Nobody has joined yet.</li>'
        }</ul></div>`;
        return;
      }

      el.teamColumns.innerHTML = ['a', 'b'].map((team) => {
        const members = everyone.filter((p) => p.team === team);
        return `<div class="team-col">
            <h4><i style="background:${TEAMS[team].color}"></i>${esc(TEAMS[team].name)}
              <span class="tag">${members.length}</span></h4>
            <ul>${members.map(row).join('') || '<li class="empty">Nobody yet.</li>'}</ul>
          </div>`;
      }).join('');
    },

    renderPostgame() {
      const results = match.results;
      if (!results) return;

      const teamName = results.winningTeam ? TEAMS[results.winningTeam].name : null;
      el.postTitle.textContent = results.teams
        ? teamName ? `${teamName} wins` : 'Draw'
        : results.winner ? `${results.winner.name} wins` : 'Draw';

      const score = results.teams
        ? `${TEAMS.a.name} ${results.scores.a} — ${results.scores.b} ${TEAMS.b.name}`
        : `${results.rows[0]?.score ?? 0} ${MODES[results.mode].scoreWord}`;
      el.postSub.textContent =
        `${results.modeName} on ${MAPS.find((m) => m.id === results.map)?.name ?? results.map} · ` +
        `${score} · ${formatClock(results.playedSeconds)} played` +
        `${results.reason === 'eliminated' ? ' · ended early, one side left standing' : ''}`;

      // Second, first, third - so the tall one is in the middle.
      const order = [results.podium[1], results.podium[0], results.podium[2]];
      el.podium.innerHTML = order.map((entry, index) => {
        const place = index === 1 ? 1 : index === 0 ? 2 : 3;
        if (!entry) return `<div class="step empty"><span class="place">${ordinal(place)}</span></div>`;
        const color = AGENT_COLORS[entry.colorIndex % AGENT_COLORS.length];
        return `<div class="step ${place === 1 ? 'first' : ''}">
            <span class="place">${ordinal(place)}</span>
            <div class="sphere" style="background:${color}"></div>
            <div class="who">${esc(entry.name)}</div>
            <div class="line">${entry.team ? `${esc(TEAMS[entry.team].name)} · ` : ''}${entry.score} ${MODES[results.mode].scoreWord}</div>
            <div class="line">${entry.kills}K / ${entry.deaths}D · ${entry.damageDealt} dmg</div>
          </div>`;
      }).join('');

      if (results.speech) {
        el.speech.hidden = false;
        el.speechWho.textContent = `${results.winner?.name ?? 'The winner'} says`;
        el.speechText.textContent = `“${results.speech}”`;
      } else {
        el.speech.hidden = true;
      }

      const ctf = results.mode === 'ctf';
      el.scoreboard.innerHTML =
        `<thead><tr><th>Fighter</th>${ctf ? '<th>Caps</th><th>Ret</th>' : ''}<th>K</th><th>D</th><th>A</th>` +
        `<th>Dmg</th><th>Acc</th><th>Best life</th></tr></thead><tbody>` +
        results.rows.map((r) => {
          const color = AGENT_COLORS[r.colorIndex % AGENT_COLORS.length];
          return `<tr class="${r.isMine ? 'mine' : ''}">
            <td class="name"><i style="background:${color}"></i>${esc(r.name)}
              ${r.team ? `<span class="team-tag">${esc(TEAMS[r.team].short)}</span>` : ''}</td>
            ${ctf ? `<td>${r.captures}</td><td>${r.returns}</td>` : ''}
            <td>${r.kills}</td><td>${r.deaths}</td><td>${r.assists}</td>
            <td>${r.damageDealt}</td><td>${r.accuracy}%</td><td>${r.longestLife}s</td></tr>`;
        }).join('') + '</tbody>';

      el.notable.innerHTML = results.notable.length
        ? results.notable.map((item) => `<li>
            <span class="label">${esc(item.label)}</span>
            <span><b>${esc(item.name)}</b> <span class="value">${esc(item.value)}</span></span>
          </li>`).join('')
        : '<li class="muted">Nothing much happened out there.</li>';

      el.returnBtn.hidden = !role.canEdit;
      el.postHint.textContent = role.canEdit
        ? 'Back to the lobby to change the game, the map or the teams.'
        : 'Waiting for the owner to take everyone back to the lobby…';
    },
  };

  return api;
}

const ordinal = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : '3rd');
const minutes = (seconds) => {
  const n = Math.round(seconds / 60);
  return `${n} ${n === 1 ? 'minute' : 'minutes'}`;
};

/** "1 kill", "2 kills" - the score word is stored plural. */
const tally = (n, word) => `${n} ${n === 1 ? word.replace(/s$/, '') : word}`;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
