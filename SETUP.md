# Setup guide

Everything needed to get Prompt Wars running, from "just let me watch it" to a
deployment other people can use.

- [What you need](#what-you-need)
- [Sixty-second start](#sixty-second-start)
- [Choosing how agents think](#choosing-how-agents-think)
- [Configuration](#configuration)
- [Putting it online](#putting-it-online)
- [Troubleshooting](#troubleshooting)
- [Working on it](#working-on-it)

## What you need

**Node 18 or newer.** That is the whole list. `node --version` to check.

No API key is needed to play — the offline interpreter is the default and reads
your prompt for intent. A key only buys you agents that think with a real model.

## Sixty-second start

```bash
git clone https://github.com/zamFe/Prompt-Wars.git
cd Prompt-Wars
npm install
npm start
```

Open <http://localhost:8080>. Four demo agents are already fighting. Write a
prompt, name it, press **Enter arena**, and the bar under the arena follows it.

**Not even that?** Open `dist/prompt-wars.html` straight from disk. It is the
whole game in one file, offline brains only, no install and no server.

`npm install` pulls exactly one dependency, the Anthropic SDK, and only the live
model brain uses it. The game itself has no dependencies at all.

## Choosing how agents think

Four options, cheapest first.

| | Cost | Needs | Good for |
|---|---|---|---|
| **Offline interpreter** | free | nothing | Playing. Arena balance, weapons, loot, the lobby. |
| **Stub model** | free | nothing | Proving the live-agent wiring before spending. |
| **Local model** | free | a gateway + a model | Real language-model agents on your own hardware. |
| **Claude** | paid | an API key | The real thing. |

### 1. Offline interpreter — the default

Nothing to do. It parses your prompt for posture, preferred range, loot greed,
trigger discipline, an explicit threshold like *"retreat below 40 hp"*, a weapon
preference and whether to strafe, then drives a state machine from those traits.
It is not a language model, but it is genuinely prompt-driven.

### 2. Stub model — free, offline, exercises the live path

Runs the whole live pipeline — proxy, tool schemas, async decisions, the
thinking indicator, error handling — with no key and no network:

```bash
npm run stub-model          # terminal 1, listens on :8790
```
```bash
# terminal 2
ANTHROPIC_BASE_URL=http://127.0.0.1:8790 \
ANTHROPIC_API_KEY=stub \
PROMPT_WARS_MODEL=stub-model \
PROMPT_WARS_COMPAT=1 npm start
```

Pick **Live model** as the brain and it plays.

> **The stub does not read your prompt.** It is not a language model. It looks
> only at the sensor observation and returns canned tactics, so an agent on the
> stub will happily walk and shoot no matter what your prompt says. Use it to
> check that the plumbing works, never to judge a prompt.
>
> For real prompt-following you need a local model or Claude, which get the
> orders in a system prompt and their own conversation memory. If you want the
> stub bound to your rules anyway, set `HARD_RULES.enforce` in
> `public/src/config.js` — the simulation will then refuse calls that break
> absolutes like *"never fire"*, whichever brain made them.

### 3. A free local model

The SDK honours `ANTHROPIC_BASE_URL`, so any endpoint speaking the Messages API
works. For example a local model behind [LiteLLM](https://github.com/BerriAI/litellm):

```bash
litellm --model ollama/qwen2.5:14b --port 4000
```
```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:4000 \
ANTHROPIC_API_KEY=local \
PROMPT_WARS_MODEL=ollama/qwen2.5:14b \
PROMPT_WARS_COMPAT=1 npm start
```

`PROMPT_WARS_COMPAT=1` drops reasoning effort and prompt caching, which
non-Anthropic gateways reject.

Small models are weak at structured tool calling. Bad calls are clamped or
dropped rather than crashing the arena, so a struggling model looks like an
agent standing around rather than an error. Expect poor play below roughly 14B.

### 4. Claude

```bash
export ANTHROPIC_API_KEY=sk-ant-...    # or: ant auth login
npm start
```

The server checks the credential on boot with one cheap `models.list` call and
only offers the **Claude (live)** brain if it actually works. **The key never
reaches the browser** — the page posts sensor readings to `/api/decide` and gets
tool calls back.

There is no free tier on the Claude API; new accounts get a small starter
credit. Measured from a real request this game sends — a ~1,600-token cached
prefix and ~370 fresh tokens per decision, with output dominating — one agent
for ten minutes costs roughly $0.20 on Haiku 4.5, $0.40 on Sonnet 5, $0.70 on
Opus 5. Estimates, not a quote; output length is the variable.

`PROMPT_WARS_MODEL=claude-haiku-4-5` is the cheapest, and a reflex loop like
this suits it. Brains also mix — one Claude agent against nine offline ones
costs you one agent.

## Configuration

Environment variables, or a `.env` file in the project root.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `ANTHROPIC_API_KEY` | — | Credential. `ANTHROPIC_AUTH_TOKEN` and `ant auth login` profiles also work. |
| `ANTHROPIC_BASE_URL` | Claude API | Point the SDK at any Messages-compatible endpoint |
| `PROMPT_WARS_MODEL` | `claude-opus-5` | Model driving live agents |
| `PROMPT_WARS_EFFORT` | `low` | Reasoning effort — agents are a reflex loop, not a research task |
| `PROMPT_WARS_CONCURRENCY` | `4` | Simultaneous model calls |
| `PROMPT_WARS_MEMORY_TURNS` | `12` | Past exchanges each character carries |
| `PROMPT_WARS_MAX_SESSIONS` | `200` | Live conversations held before the oldest is evicted |
| `PROMPT_WARS_CHAT_MAX` | `1000` | Comms messages kept before the oldest is dropped |
| `PROMPT_WARS_COMPAT` | off | Drop effort and caching, for non-Anthropic gateways |
| `PROMPT_WARS_RATE_LIMIT` | `90` | Decisions per minute per caller; `0` disables |
| `PROMPT_WARS_DAILY_LIMIT` | none | Hard ceiling on decisions per UTC day, all callers |
| `PROMPT_WARS_TRUST_PROXY` | off | Read the caller IP from `X-Forwarded-For` — only behind a proxy you control |
| `PROMPT_WARS_ENV_FILE` | `./.env` | Where to read the env file; empty string skips it |
| `STUB_LATENCY_MS` | `900` | Fake think time for the stub model |

### The `.env` file

A `.env` in the project root is read **before any setting is applied**, and
**it wins over your shell**. That is deliberate: a stale `ANTHROPIC_BASE_URL`
left in a shell profile quietly beating a `.env` you wrote by hand is exactly
how a stub key ends up pointed at the real API. Every override is printed at
boot, so nothing about it is silent:

```
.env: loaded 2 variables.
.env: ANTHROPIC_BASE_URL overrides the value from your shell (https://api.anthropic.com -> http://127.0.0.1:8790).
Model endpoint: http://127.0.0.1:8790
```

Set `PROMPT_WARS_ENV_FILE` to another path to read a different file, or to an
empty string to skip it — which is what CI and anything passing explicit
variables should do.

A complete `.env` for the free stub model:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8790
ANTHROPIC_API_KEY=stub
PROMPT_WARS_MODEL=stub-model
PROMPT_WARS_COMPAT=1
```

Then `npm run stub-model` in one terminal and `npm start` in another, with no
inline variables at all.

## Putting it online

> **Read this before exposing it.** `/api/decide` turns requests into billed
> tokens against *your* key. Anyone who finds the URL can spend your money.
> The server ships two caps for this: `PROMPT_WARS_RATE_LIMIT` per caller and
> `PROMPT_WARS_DAILY_LIMIT` overall. Set a daily limit you would not mind
> paying, and prefer a cheap model. Refused requests never reach the API.

It is an ordinary long-running Node HTTP server with no database and no build
step, so any host that runs a Node process works. A `Dockerfile` is included:

```bash
docker build -t prompt-wars .
docker run -p 8080:8080 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e PROMPT_WARS_MODEL=claude-haiku-4-5 \
  -e PROMPT_WARS_DAILY_LIMIT=2000 \
  prompt-wars
```

Behind a reverse proxy, set `PROMPT_WARS_TRUST_PROXY=1` so the rate limiter
sees real caller addresses instead of the proxy's — without it every visitor
shares one bucket.

Serverless platforms are a poor fit: the arena is in-browser, but each agent
decision is a slow model call, and the concurrency semaphore and rate limiter
are per-process. Use a normal long-running container or VM.

## Troubleshooting

**The badge says "Claude off".** Expected without credentials. The note under
the brain selector says which case you are in. The offline interpreter still
runs the full game.

**"credentials rejected by …".** The probe reached an endpoint but was turned
away. The message names the endpoint it actually used — if that reads
`https://api.anthropic.com` when you meant your local stub, your
`ANTHROPIC_BASE_URL` never took effect. The `.env:` lines printed at boot show
exactly what was loaded and what it overrode.

**"no credentials — set ANTHROPIC_API_KEY".** Nothing resolved at all. Check
`ant auth status`, or that the key is in your `.env` or exported in the shell
that started the server — not just your profile.

**Live agents error with a 4xx from a gateway.** Add `PROMPT_WARS_COMPAT=1`.
Non-Anthropic endpoints reject reasoning effort and `cache_control`.

**429s in the feed.** A spend cap refused the request. Raise
`PROMPT_WARS_RATE_LIMIT`, or lower agent count — ten live agents is a lot of
decisions per minute.

**My agent ignores its prompt.** If you are on the stub model, that is expected —
it never reads prompts. On a real model, each character carries its orders in a
cached system block and remembers its own past turns; click the agent and the
Inspector shows the turn count and what its last moves achieved. If a model
still will not obey an absolute rule, `HARD_RULES.enforce` in
`public/src/config.js` makes the simulation refuse the offending calls
outright.

**Live agents stand around doing nothing.** Usually a weak model returning prose
or malformed tool calls. Bad calls are dropped by design. Click the agent and
read the Inspector: an empty plan with a note means nothing usable came back.

**Port already in use.** `PORT=3000 npm start`.

**Fonts look wrong.** The page pulls Chakra Petch and IBM Plex from Google
Fonts. Blocked networks fall back to system stacks; nothing breaks.

## Working on it

```bash
npm test          # 73 tests, no credentials needed
npm run build     # bundles everything into dist/ as one HTML file
```

`test/sim.test.js` runs the arena headlessly in Node — weapon balance, cone
geometry, walls blocking sight and bullets, the queue, both death cooldowns,
loot, tool clamping, prompt parsing, bubbles, assists, champion scoring, and a
full 12-agent two-minute match. `test/model-proxy.test.js` runs the real server
against a stub Messages API and checks the request shape, the tool-call round
trip, the spend caps and compatibility mode.

`npm run build` writes `dist/prompt-wars.html` (open it directly) and
`dist/artifact.html`. The bundler resolves the import graph and concatenates —
no dependency — and fails loudly on a duplicate top-level name rather than
silently shadowing one.

Everything tunable lives in `public/src/config.js`: arena size, movement speeds,
vision, the weapon table, medkits, loot timing, lobby rules, bubble duration.
`public/src/actions.js` is the single source of truth for the tool definitions —
the server imports the same schemas it sends to the API.
