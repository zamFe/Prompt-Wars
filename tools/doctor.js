// Why is the model brain offline?
//
//   npm run doctor
//
// Walks the same path the server does - find the env file, load it, resolve
// the settings, reach the endpoint, run the real credential probe - and says
// which step failed and what to do about it.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadDotEnv, parseEnvFile, maskValue } from './env.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_API = 'https://api.anthropic.com';

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);
const info = (m) => console.log(`        ${m}`);
const head = (m) => console.log(`\n${m}\n${'-'.repeat(m.length)}`);

const problems = [];
const fail = (message, fix) => {
  bad(message);
  problems.push({ message, fix });
};

// ------------------------------------------------------------------ 1. where
head('1. Where this is running');
info(`node        ${process.version} on ${process.platform}`);
info(`project     ${ROOT}`);
info(`working dir ${process.cwd()}`);
try {
  const commit = execSync('git log -1 --format=%h\\ %s', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  info(`checkout    ${branch} @ ${commit}`);
} catch {
  info('checkout    (not a git checkout)');
}

// --------------------------------------------------------------- 2. env file
head('2. The env file');
const envFile = process.env.PROMPT_WARS_ENV_FILE ?? path.join(ROOT, '.env');

if (process.env.PROMPT_WARS_ENV_FILE === '') {
  info('PROMPT_WARS_ENV_FILE is empty, so no file is read at all.');
} else if (!fs.existsSync(envFile)) {
  fail(`no env file at ${envFile}`, `Create it there. On Windows make sure the name is exactly ".env" and not ".env.txt".`);
} else {
  const raw = fs.readFileSync(envFile, 'utf8');
  ok(`found ${envFile} (${Buffer.byteLength(raw)} bytes)`);

  const parsed = parseEnvFile(raw);
  if (!parsed.size) {
    fail('the file parsed to zero variables', 'Each line must look like KEY=value.');
  } else {
    ok(`parsed ${parsed.size} variable${parsed.size === 1 ? '' : 's'}`);
    for (const [key, value] of parsed) info(`  ${key} = ${maskValue(key, value)}`);
  }

  const unparsed = raw.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l));
  for (const line of unparsed) info(`  (ignored, not KEY=value) ${JSON.stringify(line.slice(0, 60))}`);
}

// A file named nearly right is the classic way this goes wrong.
const lookalikes = fs.readdirSync(ROOT)
  .filter((f) => f !== '.env' && /^\.?env(\.|$)/i.test(f) && !fs.statSync(path.join(ROOT, f)).isDirectory());
if (lookalikes.length) {
  fail(`found ${lookalikes.map((f) => `"${f}"`).join(', ')} next to the project`,
    'The server only reads a file named exactly ".env". Rename it.');
}

// ------------------------------------------------------------ 3. what loaded
head('3. Settings after loading');
const report = process.env.PROMPT_WARS_ENV_FILE === '' ? { loaded: false, overridden: [] } : loadDotEnv(envFile);
for (const { key, was, now } of report.overridden ?? []) {
  info(`${key}: file value (${maskValue(key, now)}) replaced your shell's (${maskValue(key, was)})`);
}

const baseUrl = process.env.ANTHROPIC_BASE_URL || DEFAULT_API;
const apiKey = process.env.ANTHROPIC_API_KEY;
info(`ANTHROPIC_BASE_URL   ${baseUrl}${process.env.ANTHROPIC_BASE_URL ? '' : '  (default)'}`);
info(`ANTHROPIC_API_KEY    ${apiKey ? maskValue('KEY', apiKey) : '(not set)'}`);
info(`PROMPT_WARS_MODEL    ${process.env.PROMPT_WARS_MODEL ?? 'claude-opus-5  (default)'}`);
info(`PROMPT_WARS_COMPAT   ${process.env.PROMPT_WARS_COMPAT ?? '(off)'}`);
info(`PORT                 ${process.env.PORT ?? '8080  (default)'}`);

if (!apiKey && !process.env.ANTHROPIC_AUTH_TOKEN) {
  fail('no ANTHROPIC_API_KEY resolved', 'Put ANTHROPIC_API_KEY=... in your .env (any value works for the stub).');
}
const looksLocal = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/i.test(baseUrl);
if (apiKey && !looksLocal && baseUrl === DEFAULT_API && !/^sk-/.test(apiKey)) {
  fail(`the key does not look like a real Anthropic key, but the endpoint is ${DEFAULT_API}`,
    'If you meant the stub, ANTHROPIC_BASE_URL did not take effect - check section 2.');
}

// ------------------------------------------------------------- 4. the endpoint
head('4. Reaching the model endpoint');
try {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/models?limit=1`, {
    headers: { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' },
  });
  if (response.ok) ok(`${baseUrl} answered ${response.status}`);
  else {
    const detail = (await response.text().catch(() => '')).slice(0, 160);
    fail(`${baseUrl} answered ${response.status}`,
      response.status === 401
        ? looksLocal
          ? 'A local endpoint rejecting the key is unusual - is that really the stub?'
          : 'The key was rejected. If you meant the local stub, your ANTHROPIC_BASE_URL is not being applied.'
        : `Unexpected response: ${detail}`);
  }
} catch (error) {
  fail(`could not reach ${baseUrl} (${error?.cause?.code ?? error.message})`,
    looksLocal
      ? 'Nothing is listening there. Start it first: npm run stub-model'
      : 'Check your network or proxy settings.');
}

// ------------------------------------------------------------- 5. the real probe
head('5. The credential probe the server runs');
try {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  await new Anthropic().models.list({ limit: 1 });
  ok('the SDK authenticated - the server will enable the live brain');
} catch (error) {
  const message = error?.message ?? String(error);
  if (/Cannot find package/.test(message)) fail('the Anthropic SDK is not installed', 'Run: npm install');
  else fail(`probe failed: ${message.slice(0, 160)}`, 'See the section above for the likely cause.');
}

// ------------------------------------------------------------------- 6. port
head('6. The port');
const port = Number(process.env.PORT ?? 8080);
const inUse = await new Promise((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
  setTimeout(() => { socket.destroy(); resolve(false); }, 700);
});
if (inUse) {
  info(`something is already listening on ${port}.`);
  info('If that is an older copy of this server, stop it - your browser may be talking to that one.');
} else {
  ok(`port ${port} is free`);
}

// ---------------------------------------------------------------- the verdict
head('Verdict');
if (!problems.length) {
  console.log('  Everything checks out. Start the server with: npm start');
} else {
  console.log(`  ${problems.length} problem${problems.length === 1 ? '' : 's'} found:\n`);
  problems.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.message}`);
    console.log(`     -> ${p.fix}\n`);
  });
}
process.exit(problems.length ? 1 : 0);
