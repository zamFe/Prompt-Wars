# Prompt Wars

A top-down 2D browser arena where you don't play — your **prompt** does.

Write instructions for a fighter, drop it into the arena, and watch it work.
Every sphere is driven by an agent that can only see through a narrow vision
cone and can only act through six slow, deliberate tools. It cannot strafe,
cannot sprint, and cannot snap its aim onto a target. That deliberate weakness
is the whole design: when the mechanics are this constrained, the quality of
your instructions is what decides the fight.

![the arena](docs/arena.png)

## Running it

```bash
npm install
npm start          # http://localhost:8080
```

`npm install` is only needed for the Claude brain. The offline brain works with
no dependencies at all — you can also just open `dist/prompt-wars.html` in a
browser, or serve `public/` with any static file server.

To let agents think with a real model, give the server credentials:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or: ant auth login
npm start
```

The server checks the credentials on boot and only offers the "Claude (live)"
brain in the UI if they actually work. **The key never reaches the browser** —
the page posts its sensor readings to `/api/decide` and gets tool calls back.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `PROMPT_WARS_MODEL` | `claude-opus-5` | Model that drives live agents |
| `PROMPT_WARS_EFFORT` | `low` | Reasoning effort — agents are a reflex loop, not a research task |
| `PROMPT_WARS_CONCURRENCY` | `4` | Max simultaneous model calls |

A `.env` file in the project root is read if present.

## What an agent can do

Six tools, and nothing else. Every one costs time, and the world keeps moving
while an action plays out.

| Tool | Effect |
|---|---|
| `turn(direction, degrees)` | Rotate the body at 100°/s. A 180° turn takes nearly two seconds of blindness. |
| `move(direction, steps)` | Walk along the body facing. 26 units per step, 130 u/s forward, 78 u/s backward. No strafing. |
| `aim(direction, degrees)` | Swing the gun up to ±35° off the body facing at 160°/s. Far faster than turning. |
| `fire(shots)` | Shoot along the current aim. Stops when the magazine runs dry. |
| `reload()` | Refill the magazine. Cannot be cancelled. Nothing auto-reloads. |
| `hold(seconds)` | Stand still and watch. |

An agent returns 1–4 tool calls per decision, which run in order. Short plans
stay responsive; long plans commit you to something the world may have already
invalidated.

## What an agent can see

**No arena coordinates, ever.** An agent gets a 45° vision cone with a range of
620 units, blocked by walls, and has to work out the rest for itself:

- **Enemies in the cone** — bearing, distance, relative position (`n ahead / m to
  your right`), their HP and weapon, their compass heading, and how they are
  oriented relative to you (`facing you`, `side-on, left`, `facing away`).
- **Loot in the cone** — what it is, bearing and distance.
- **Nine wall probes** fanned across the cone, plus a short-range proximity
  reading front / back / left / right. Working out where you are in the room is
  the prompt's job.
- **A compass heading**, your HP, weapon and ammo.
- **Events since the last decision** — damage taken and from which side, kills,
  pickups, a walk that ran into a wall.

Bearings are always relative to your body: negative is left, positive is right.
Click any sphere in the running game to read its exact sensor feed.

## Combat

100 HP. Everyone spawns with the pistol; the other two are found on the floor,
which is what makes crossing open ground for them worth the risk.

| Weapon | Magazine | Between shots | Reload | Damage | Sustained DPS | Shots to kill |
|---|---|---|---|---|---|---|
| Pistol | 3 | 0.75s | 2.0s | 20 | ~14 | 5 |
| Shotgun | 5 | 1.0s | 3.0s | 6 pellets × 8 (48 up close) | ~30 close, far less at range | 3 shells point-blank |
| Assault Rifle | 10 | 0.5s | 2.0s | 15 | ~21 | 7 |

The shotgun deals full damage inside 130 units and decays to 35% at its 520-unit
limit, so its headline number only exists if you get close. The rifle keeps 75%
of its damage all the way out to 1000 units.

Medkits heal **10 / 25 / 50 HP** and are read at a glance — bigger and brighter
means a bigger heal. An agent already at full health leaves the pack for someone
else. Loot spawns at a random open spot every 6–16 seconds, up to 10 items on the
floor, and despawns after 60 seconds.

Getting shot cancels the rest of your current plan so you can react. Fresh
spawns are invulnerable for 1.5 seconds.

## The lobby

The arena holds **10 agents**. Anyone else waits in a queue and is admitted the
moment a slot frees.

When you die you sit out **60 seconds**. If the arena was full *and* more than 10
were already queued at the moment of your death, that becomes **10 minutes** —
dying in a crowd costs you your place for a long while.

## The two brains

**Offline interpreter** (default, no API key). It reads your prompt for intent —
posture, preferred range, loot greed, trigger discipline, an explicit HP retreat
threshold like *"retreat below 40 hp"*, a weapon preference, a turn bias — and
drives a state machine from those traits. Not a language model, but genuinely
prompt-driven, and it makes the game playable with zero setup.

**Claude (live).** Your prompt becomes the agent's standing orders; the sensor
readout becomes its observation; the six tools above are its tool definitions.
The stable rules live in a cached system prompt and your prompt is fenced into
`<standing_orders>` as untrusted text that sets tactics but cannot change the
rules of the arena, the tool set, or the output format.

Live agents think asynchronously — an agent keeps executing its previous plan
while the next one is in flight, so latency shows up as commitment rather than
as a freeze.

## Writing a prompt that wins

The starter prompts in the dropdown are a decent tour. What actually matters:

- **Say when to shoot, not just to shoot.** "Fire when the bearing is under 5°"
  beats "kill everyone".
- **Prefer `aim` to `turn` for small corrections.** Turning the body is slow and
  blinds you; the gun swings at 160°/s.
- **Give a retreat rule with a number.** "Back off below 40 hp" is actionable;
  "be careful" is not.
- **Say what to do when the cone is empty** — that's most of the match.
- **Manage the magazine.** Nothing reloads for you, and a reload cannot be
  cancelled. Reloading with an enemy at 100 units is how agents die.

## Layout

```
server.js              static hosting + the /api/decide model proxy
build.js               bundles everything into dist/ as one HTML file
public/
  index.html, styles.css
  src/
    config.js          every tunable number in one table
    util.js            math, geometry, seedable RNG
    arena.js           walls, ray casts, line of sight, collision
    sensors.js         what an agent perceives, and its text rendering
    actions.js         the six tools: schemas, validation, execution
    world.js           bodies, bullets, loot, damage, the decision loop
    lobby.js           queue and death timers
    render.js          canvas drawing
    ui.js              panels, roster, inspector
    main.js            wiring and the fixed-timestep loop
    brains/
      local.js         the offline prompt interpreter
      claude.js        client for the model proxy
test/
  sim.test.js          rules: balance, vision, bullets, lobby, loot, prompts
  model-proxy.test.js  the Claude path, against a stub Messages API
```

`public/src/actions.js` is the single source of truth for the tool definitions —
the server imports the same schemas it sends to the API.

## Tests

```bash
npm test
```

`sim.test.js` runs the arena headlessly in Node — weapon balance, cone geometry,
walls blocking sight and bullets, the queue, both death cooldowns, loot rules,
tool-argument clamping, prompt parsing, and a full 12-agent two-minute match.
`model-proxy.test.js` runs the server against a stub Messages API and checks the
request shape and the tool-call round trip; it needs no credentials.

## Building the single file

```bash
npm run build
```

Writes `dist/prompt-wars.html` (open it directly — offline brains only, since
there is no server to proxy the model) and `dist/artifact.html`.
