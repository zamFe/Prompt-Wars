// A free, offline stand-in for the Messages API.
//
//   node tools/stub-model.js            # listens on :8790
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8790 ANTHROPIC_API_KEY=stub npm start
//
// It speaks just enough of POST /v1/messages to drive the Claude brain end to
// end: it reads the observation text out of the request and answers with real
// tool_use blocks. Useful for checking the whole live path - proxy, tool
// schemas, action queue, the thinking indicator, error handling - without an
// API key and without spending anything.
//
// It is NOT a language model. It ignores the player's prompt entirely, so it
// tells you nothing about whether a prompt is any good.

import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8790);
const LATENCY = Number(process.env.STUB_LATENCY_MS ?? 900);   // fake think time

/** Pull the numbers we need back out of the rendered observation. */
function readObservation(text) {
  const enemy = text.match(/^\s{2}(\S+): bearing ([+-]?[\d.]+)°.*?distance (\d+)/m);
  const loot = text.match(/^\s{2}(Medkit[^:]*|Shotgun|Assault Rifle): bearing ([+-]?[\d.]+)°, distance (\d+)/m);
  // Ammo is the second n/m pair on the status line - the first is HP.
  const ammo = text.match(/HP \d+\/\d+\s+[A-Za-z ]+?\s(\d+)\/(\d+)/);
  const front = text.match(/WALL PROXIMITY: front (\d+)/);

  return {
    enemy: enemy && { name: enemy[1], bearing: Number(enemy[2]), distance: Number(enemy[3]) },
    loot: loot && { label: loot[1], bearing: Number(loot[2]), distance: Number(loot[3]) },
    ammo: ammo ? Number(ammo[1]) : 3,
    reloading: /RELOADING/.test(text),
    hp: Number((text.match(/HP (\d+)\//) ?? [, 100])[1]),
    frontWall: front ? Number(front[1]) : 500,
  };
}

let turn = 0;

function plan(observation) {
  const s = readObservation(observation);
  const call = (name, input = {}) => ({ type: 'tool_use', id: `stub_${turn++}`, name, input });

  if (s.reloading) return { text: 'Reload in progress, holding.', calls: [call('hold', { seconds: 0.5 })] };
  if (s.ammo <= 0) return { text: 'Magazine dry.', calls: [call('reload')] };

  if (s.enemy) {
    const calls = [];
    const bearing = s.enemy.bearing;
    if (Math.abs(bearing) > 2) {
      calls.push(Math.abs(bearing) <= 35
        ? call('aim', { direction: bearing < 0 ? 'left' : 'right', degrees: Math.abs(bearing) })
        : call('turn', { direction: bearing < 0 ? 'left' : 'right', degrees: Math.min(180, Math.abs(bearing)) }));
    }
    calls.push(call('fire', { shots: Math.min(2, s.ammo) }));
    if (s.enemy.distance > 300) calls.push(call('move', { direction: 'forward', steps: 3 }));
    else calls.push(call('move', { direction: turn % 2 ? 'left' : 'right', steps: 2 }));
    return { text: `Engaging ${s.enemy.name} at ${s.enemy.distance}.`, calls };
  }

  if (s.loot && (s.hp < 100 || !s.loot.label.startsWith('Medkit'))) {
    return {
      text: `Collecting ${s.loot.label}.`,
      calls: [
        call('aim', { direction: s.loot.bearing < 0 ? 'left' : 'right', degrees: Math.min(35, Math.abs(s.loot.bearing)) }),
        call('move', { direction: 'forward', steps: Math.max(1, Math.min(8, Math.round(s.loot.distance / 26))) }),
      ],
    };
  }

  if (s.frontWall < 80) {
    return { text: 'Wall ahead, turning.', calls: [call('turn', { direction: 'right', degrees: 90 }), call('move', { direction: 'forward', steps: 3 })] };
  }
  return {
    text: 'Nothing in sight, sweeping.',
    calls: [call('turn', { direction: turn % 3 ? 'right' : 'left', degrees: 35 }), call('move', { direction: 'forward', steps: 3 })],
  };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', async () => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'stub-model', type: 'model', display_name: 'Stub Model' }], has_more: false }));
    }
    if (!req.url.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: req.url } }));
    }

    let request;
    try {
      request = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad JSON' } }));
    }

    const content = request.messages?.[0]?.content ?? '';
    const observation = (String(content).match(/<observation>\n([\s\S]*?)\n<\/observation>/) ?? [, ''])[1];
    const { text, calls } = plan(observation);

    // A little latency, so the arena behaves like it does against a real model.
    if (LATENCY > 0) await new Promise((r) => setTimeout(r, LATENCY));

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `msg_stub_${turn}`,
      type: 'message',
      role: 'assistant',
      model: request.model ?? 'stub-model',
      stop_reason: 'tool_use',
      content: [{ type: 'text', text }, ...calls],
      usage: { input_tokens: 0, output_tokens: 0 },
    }));
  });
});

server.listen(PORT, () => {
  console.log(`Stub model listening on http://127.0.0.1:${PORT}`);
  console.log('Point the game at it with:');
  console.log(`  ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} ANTHROPIC_API_KEY=stub npm start`);
});
