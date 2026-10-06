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
import { colorOf, isHex } from './colors.js';

const byId = (id) => document.getElementById(id);

export function createScreens({
  world,
  match,
  me = () => ({ seat: null, profile: null }),
  onProfile = () => {},
  onPickSide = () => {},
  onMoveSeat = () => {},
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
    profileForm: byId('profile-form'),
    profileName: byId('profile-name'),
    swatches: byId('profile-swatches'),
    profileSphere: byId('profile-sphere'),
    profilePreview: byId('profile-preview-name'),
    lobbySub: byId('lobby-sub'),
    lobbyRoom: byId('lobby-room'),
    lobbyConn: byId('lobby-conn'),
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

  // --- the title card: who you are, and what colour you fight in -------------
  let pickedColor = null;

  el.swatches.innerHTML =
    AGENT_COLORS.map((color) => `<button type="button" class="swatch" role="radio" aria-checked="false"
        data-color="${color}" style="--swatch:${color}" title="${color}"></button>`).join('') +
    // Anything outside the palette, for anyone who has a colour in mind.
    `<label class="swatch custom" title="Any colour"><input type="color" id="profile-custom" value="#ffffff" />
      <span>+</span></label>`;

  const choose = (color) => {
    if (!isHex(color)) return;
    pickedColor = color.toLowerCase();
    for (const swatch of el.swatches.querySelectorAll('.swatch[data-color]')) {
      swatch.setAttribute('aria-checked', String(swatch.dataset.color.toLowerCase() === pickedColor));
    }
    el.profileSphere.style.background = pickedColor;
  };
  const preview = () => {
    el.profilePreview.textContent = el.profileName.value.trim() || 'Rook';
  };

  el.swatches.addEventListener('click', (event) => {
    const swatch = event.target.closest('.swatch[data-color]');
    if (swatch) choose(swatch.dataset.color);
  });
  byId('profile-custom').addEventListener('input', (event) => choose(event.target.value));
  el.profileName.addEventListener('input', preview);

  el.profileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = el.profileName.value.trim().slice(0, 14);
    if (!name) return el.profileName.focus();
    onProfile({ name, color: pickedColor ?? AGENT_COLORS[0] });
  });

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
    const swap = event.target.closest('button[data-swap]');
    if (swap && role.canEdit) return onSetTeam(swap.dataset.swap, swap.dataset.team);
    const pick = event.target.closest('button[data-pick]');
    if (pick) return onPickSide(pick.dataset.pick === 'none' ? null : pick.dataset.pick);
    return undefined;
  });
  // The owner moves anybody, from a picker on that person's row.
  el.teamColumns.addEventListener('change', (event) => {
    const move = event.target.closest('select[data-move]');
    if (move && role.canEdit) onMoveSeat(move.dataset.move, move.value === 'none' ? null : move.value);
  });

  /** The rules a finished round's colours are drawn by, for this viewer. */
  const viewFor = (results) => ({
    mode: MODES[results.mode],
    mySeat: me().seat,
    myColor: me().profile?.color,
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

    /** Fill the form from a profile this viewer saved last time. */
    setProfile(profile) {
      if (profile?.name) el.profileName.value = profile.name;
      choose(profile?.color ?? AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)]);
      preview();
    },

    render() {
      // The profile screen is this page's own gate, in front of whatever the
      // room is doing - a newcomer names themselves before anything else.
      const { profile } = me();
      const shown = !profile ? PHASES.landing : match.phase === PHASES.landing ? PHASES.lobby : match.phase;
      el.body.dataset.phase = shown;
      if (shown === PHASES.landing) {
        requestAnimationFrame(() => {
          if (document.activeElement !== el.profileName) el.profileName.focus();
        });
      }
      if (shown === PHASES.lobby) api.renderLobby();
      if (shown === PHASES.postgame) api.renderPostgame();
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

      const playing = Object.values(match.seats).filter((seat) => seat.side).length;
      const fighters = world.lobby.list().filter((p) => !p.seat).length + playing;
      const mySide = match.seats[me().seat]?.side ?? null;
      el.start.disabled = fighters === 0;
      el.lobbyHint.textContent = !role.canEdit
        ? mySide
          ? 'You are in. You write your prompt once the owner starts the round…'
          : 'Pick a side to play, or stay in the stands and watch.'
        : fighters === 0
          ? 'Pick a side yourself, or add a bot. Prompts are written in the minute after you press Start.'
          : `${MODES[settings.mode].name} on ${MAPS.find((m) => m.id === settings.map)?.name}, ` +
            `${minutes(settings.roundSeconds)}.`;

      // Whether anyone else can see this lobby. Two people in two lobbies that
      // look exactly alike is the worst way to find out they are not connected.
      const others = room?.available ? Math.max(0, room.peers - 1) : 0;
      const offline = room !== null && !room.available;
      el.lobbyRoom.textContent = room === null ? 'connecting…' : offline ? 'not connected' : others === 0 ? 'only you' : `${room.peers} here`;
      el.lobbyRoom.classList.toggle('live', others > 0);
      el.lobbyRoom.classList.toggle('off', offline);
      el.lobbyConn.hidden = room === null || others > 0;
      el.lobbyConn.classList.toggle('off', offline);
      el.lobbyConn.textContent = offline
        ? 'This page is not connected to other players, so this lobby is only on your screen.'
        : role.canEdit
          ? 'Waiting for players. People join this lobby when they open the artifact signed in, ' +
            'shared to them directly — anyone arriving by a public link gets a separate game.'
          : 'Nobody else is here yet.';
    },

    /**
     * Everyone in the lobby, by where they sit: the stands, then each side.
     * People are seats; bots are fighters with no seat. The owner can move
     * anyone; a person can move themselves; a Viewer can only watch.
     */
    renderRoster() {
      const { seat: mySeat, profile } = me();
      const seats = match.seats;
      const people = Object.entries(seats);
      const bots = world.lobby.list().filter((p) => !p.seat && p.role !== 'squad');
      const mode = match.mode;
      const view = { mode, mySeat, myColor: profile?.color };

      el.lobbyCount.textContent = `${people.length} ${people.length === 1 ? 'person' : 'people'}` +
        (bots.length ? ` · ${bots.length} bot${bots.length === 1 ? '' : 's'}` : '');

      const sides = mode.teams
        ? [
            { id: null, name: 'Spectating', color: null },
            { id: 'a', name: TEAMS.a.name, color: TEAMS.a.color },
            { id: 'b', name: TEAMS.b.name, color: TEAMS.b.color },
          ]
        : [
            { id: null, name: 'Spectating', color: null },
            { id: 'play', name: 'In the fight', color: null },
          ];

      const options = (current) => sides
        .map((side) => `<option value="${side.id ?? 'none'}" ${side.id === (current ?? null) ? 'selected' : ''}>${esc(side.name)}</option>`)
        .join('');

      const personRow = ([id, seat]) => {
        const isMe = id === mySeat;
        const tag = isMe ? 'you' : seat.canPlay ? '' : 'watching only';
        const control = role.canEdit && seat.canPlay
          ? `<select class="move" data-move="${esc(id)}" aria-label="Move ${esc(seat.name)}">${options(seat.side)}</select>`
          : '<span></span>';
        return `<li class="${isMe ? 'mine' : ''}">
            <i class="dot" style="background:${esc(seat.color)}"></i>
            <span class="who"><span class="name">${esc(seat.name)}</span></span>
            <span class="tag">${tag}</span>${control}</li>`;
      };

      const botRow = (p) => {
        const color = colorOf(p, view);
        const swap = mode.teams && role.canEdit
          ? `<button class="swap" data-swap="${p.id}" data-team="${p.team === 'a' ? 'b' : 'a'}" title="Move to the other side">&#8644;</button>`
          : '<span></span>';
        return `<li class="bot">
            <i class="dot" style="background:${color}"></i>
            <span class="who"><span class="name">${esc(p.name)}</span></span>
            <span class="tag">${p.role === 'commander' ? 'bot commander' : 'bot'}</span>${swap}</li>`;
      };

      const mine = seats[mySeat];
      const canJoin = (side) => {
        if (!mine || !mine.canPlay || (mine.side ?? null) === side.id) return false;
        // Commander is one person a side, and a bot commander counts.
        if (side.id && mode.squad) {
          const held = people.some(([id, other]) => id !== mySeat && other.side === side.id) ||
            bots.some((b) => b.role === 'commander' && b.team === side.id);
          if (held) return false;
        }
        return true;
      };

      el.teamColumns.innerHTML = sides.map((side) => {
        const here = people.filter(([, seat]) => (seat.side ?? null) === side.id);
        const hereBots = side.id === null ? [] : bots.filter((b) => (mode.teams ? b.team === side.id : true));
        const join = canJoin(side)
          ? `<button type="button" class="pick-side" data-pick="${side.id ?? 'none'}">${side.id ? 'Join' : 'Spectate'}</button>`
          : '';
        const rows = here.map(personRow).join('') + hereBots.map(botRow).join('');
        return `<div class="team-col ${side.id === null ? 'stands' : ''}">
            <h4>${side.color ? `<i style="background:${side.color}"></i>` : ''}${esc(side.name)}
              <span class="tag">${here.length + hereBots.length}</span>${join}</h4>
            <ul>${rows || `<li class="empty">${side.id === null ? 'Nobody watching.' : 'Nobody yet.'}</li>`}</ul>
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
        const color = colorOf(entry, viewFor(results));
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
          const color = colorOf(r, viewFor(results));
          return `<tr class="${r.seat && r.seat === me().seat ? 'mine' : ''}">
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
